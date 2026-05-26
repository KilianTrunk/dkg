// daemon/routes/guardian.ts
//
// First-class Umanitek Guardian audit routes. These routes ingest local agent
// telemetry from Hermes/OpenClaw adapters, run deterministic security analysis,
// persist findings in the Node UI DB, and write public-safe vulnerability
// intelligence into DKG.

import {
  analyzeGuardianEvent,
  buildFixPrompt,
  buildPrivateAuditQuads,
  buildPublicDependencyQuads,
  componentsFromFindings,
  guardianDependencyIntelId,
  normalizeGuardianEvent,
  normalizeSeverity,
  redactGuardianData,
  sanitizeText,
  type GuardianDependencyComponent,
  type GuardianDependencyIntelRecord,
  type GuardianEventInput,
  type GuardianFindingRecord,
  type GuardianGraphSyncRecord,
  type GuardianSeverity,
} from '@origintrail-official/dkg-node-ui';
import type { RequestContext } from './context.js';
import {
  jsonResponse,
  readBody,
  safeParseJson,
  SMALL_BODY_BYTES,
} from '../http-utils.js';

const PRIVATE_AUDIT_GRAPH_ID = 'guardian-local-audit';
const PUBLIC_VULN_GRAPH_ID = 'guardian-vulnerability-intel';
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const EPSS_URL = 'https://api.first.org/data/v1/epss';
const NVD_CVE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

let cisaCache: { loadedAt: number; byCve: Map<string, CisaKevEntry> } | null = null;

interface CisaKevEntry {
  cveID?: string;
  cveId?: string;
  dateAdded?: string;
  dueDate?: string;
  requiredAction?: string;
  vulnerabilityName?: string;
  knownRansomwareCampaignUse?: string;
}

interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
    ecosystem_specific?: { severity?: string };
    database_specific?: Record<string, unknown>;
  }>;
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string };
  modified?: string;
  published?: string;
}

export async function handleGuardianRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, url, path, dashDb } = ctx;

  if (req.method === 'POST' && path === '/api/guardian/events') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const event = normalizeGuardianEvent(parsed as GuardianEventInput);
    const findings = analyzeGuardianEvent(event);
    const stored = dashDb.upsertGuardianEvent(event);
    dashDb.upsertGuardianFindings(findings);

    await syncPrivateAuditGraph(ctx, event, findings);

    const components = componentsFromFindings(findings);
    const dependencyIntel = components.length > 0
      ? await enrichAndStoreDependencies(ctx, components)
      : [];

    return jsonResponse(res, 200, {
      ok: true,
      inserted: stored.inserted,
      event,
      findings,
      dependencyIntel,
    });
  }

  if (req.method === 'GET' && path === '/api/guardian/events') {
    const limit = boundedInt(url.searchParams.get('limit'), 100, 1, 500);
    const offset = boundedInt(url.searchParams.get('offset'), 0, 0, 10_000);
    const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined;
    const result = dashDb.listGuardianEvents({
      agentFramework: url.searchParams.get('agent') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
      since: Number.isFinite(since) ? since : undefined,
      limit,
      offset,
    });
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'GET' && path === '/api/guardian/findings') {
    const limit = boundedInt(url.searchParams.get('limit'), 100, 1, 500);
    const offset = boundedInt(url.searchParams.get('offset'), 0, 0, 10_000);
    const result = dashDb.listGuardianFindings({
      status: url.searchParams.get('status') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
      limit,
      offset,
    });
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'GET' && path === '/api/guardian/summary') {
    return jsonResponse(res, 200, {
      summary: dashDb.getGuardianSummary(),
      dependencyIntel: dashDb.listGuardianDependencyIntel(50),
    });
  }

  if (req.method === 'POST' && path === '/api/guardian/audit/dependencies') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const components = parseDependencyComponents(parsed.components);
    if (components.length === 0) {
      const openDependencyFindings = dashDb.listGuardianFindings({ status: 'open', type: 'dependency_install', limit: 500 }).findings;
      components.push(...componentsFromFindings(openDependencyFindings));
    }
    const dependencyIntel = await enrichAndStoreDependencies(ctx, components);
    return jsonResponse(res, 200, { ok: true, dependencyIntel });
  }

  if (req.method === 'POST' && path === '/api/guardian/fix-prompt') {
    const open = dashDb.listGuardianFindings({ status: 'open', limit: 500 }).findings;
    return jsonResponse(res, 200, {
      ok: true,
      prompt: buildFixPrompt(open),
      findingCount: open.length,
    });
  }
}

async function enrichAndStoreDependencies(
  ctx: RequestContext,
  components: GuardianDependencyComponent[],
): Promise<GuardianDependencyIntelRecord[]> {
  const unique = dedupeComponents(components);
  if (unique.length === 0) return [];
  const records = await queryOsv(unique);
  for (const record of records) {
    ctx.dashDb.upsertGuardianDependencyIntel(record);
    await publishPublicDependencyIntel(ctx, record);
  }
  return records;
}

async function queryOsv(components: GuardianDependencyComponent[]): Promise<GuardianDependencyIntelRecord[]> {
  const payload = {
    queries: components.map((component) => ({
      package: { ecosystem: component.ecosystem, name: component.name },
      version: component.version,
    })),
  };
  const batch = await fetchJson(OSV_BATCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  const results = Array.isArray(batch?.results) ? batch.results : [];
  const pairs: Array<{ component: GuardianDependencyComponent; id: string }> = [];
  for (let i = 0; i < components.length; i++) {
    const vulns = Array.isArray(results[i]?.vulns) ? results[i].vulns : [];
    for (const vuln of vulns) {
      if (typeof vuln?.id === 'string' && vuln.id) pairs.push({ component: components[i], id: vuln.id });
    }
  }
  if (pairs.length === 0) return [];

  const records = await Promise.all(pairs.map(async ({ component, id }) => {
    const osv = await fetchJson(`${OSV_VULN_URL}${encodeURIComponent(id)}`).catch(() => ({ id }));
    return buildDependencyIntel(component, normalizeOsvRecord(osv, id), await exploitIntelFor(normalizeOsvRecord(osv, id)));
  }));
  return records;
}

async function exploitIntelFor(osv: OsvRecord): Promise<{
  knownExploited: boolean;
  exploitedAt: string | null;
  epssScore: number | null;
  epssPercentile: number | null;
  epssDate: string | null;
}> {
  const cves = cvesFor(osv);
  if (cves.length === 0) {
    return { knownExploited: false, exploitedAt: null, epssScore: null, epssPercentile: null, epssDate: null };
  }
  const [kev, epss, nvd] = await Promise.all([
    loadCisaKev().catch(() => new Map<string, CisaKevEntry>()),
    fetchEpss(cves).catch(() => null),
    fetchNvdKev(cves[0]).catch(() => null),
  ]);
  const kevEntry = cves.map((cve) => kev.get(cve)).find(Boolean);
  const exploitedAt = kevEntry?.dateAdded ?? nvd?.dateAdded ?? null;
  return {
    knownExploited: Boolean(kevEntry || nvd?.knownExploited),
    exploitedAt,
    epssScore: epss?.score ?? null,
    epssPercentile: epss?.percentile ?? null,
    epssDate: epss?.date ?? null,
  };
}

function buildDependencyIntel(
  component: GuardianDependencyComponent,
  osv: OsvRecord,
  exploit: {
    knownExploited: boolean;
    exploitedAt: string | null;
    epssScore: number | null;
    epssPercentile: number | null;
    epssDate: string | null;
  },
): GuardianDependencyIntelRecord {
  const now = Date.now();
  const severity = severityFromOsv(osv, exploit.knownExploited);
  return {
    id: guardianDependencyIntelId(component, osv.id),
    ecosystem: component.ecosystem,
    package_name: component.name,
    package_version: component.version,
    advisory_id: osv.id,
    cve_ids_json: JSON.stringify(cvesFor(osv)),
    severity,
    summary: sanitizeText(osv.summary || osv.details || osv.id, 1200),
    fixed_versions_json: JSON.stringify(fixedVersions(osv)),
    references_json: JSON.stringify((osv.references ?? []).map((ref) => ref.url).filter((v): v is string => typeof v === 'string')),
    known_exploited: exploit.knownExploited ? 1 : 0,
    exploited_at: exploit.exploitedAt,
    epss_score: exploit.epssScore,
    epss_percentile: exploit.epssPercentile,
    epss_date: exploit.epssDate,
    osv_json: JSON.stringify(redactGuardianData(osv)),
    publish_status: 'pending',
    publish_error: null,
    publish_tx_hash: null,
    public_graph_id: PUBLIC_VULN_GRAPH_ID,
    updated_at: now,
    last_seen_at: now,
  };
}

async function publishPublicDependencyIntel(ctx: RequestContext, intel: GuardianDependencyIntelRecord): Promise<void> {
  const contextGraphId = PUBLIC_VULN_GRAPH_ID;
  try {
    await ensureContextGraph(ctx, contextGraphId, {
      name: 'Guardian Vulnerability Intelligence',
      description: 'Public Umanitek Guardian context graph for reusable package vulnerability intelligence.',
      accessPolicy: 0,
      publishPolicy: 1,
    });
    await ensureRegistered(ctx, contextGraphId);
    const result = await ctx.agent.publish(
      contextGraphId,
      buildPublicDependencyQuads(intel, contextGraphId),
      {
        accessPolicy: 'public',
      } as any,
    );
    const txHash = (result as any)?.onChainResult?.txHash ?? null;
    ctx.dashDb.updateGuardianDependencyPublish(intel.id, {
      publish_status: 'published',
      publish_tx_hash: txHash,
      public_graph_id: contextGraphId,
    });
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-vulnerability-intel',
      scope: 'public',
      contextGraphId,
      status: 'synced',
      details: { advisoryId: intel.advisory_id, package: intel.package_name, txHash },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missingPublishIdentity = /cannot be registered on-chain without an address-scoped curator|configure a default agent address|insufficient funds|insufficient balance|not enough funds/i.test(message);
    ctx.dashDb.updateGuardianDependencyPublish(intel.id, {
      publish_status: missingPublishIdentity ? 'skipped' : 'failed',
      publish_error: sanitizeText(message, 1000),
      public_graph_id: contextGraphId,
    });
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-vulnerability-intel',
      scope: 'public',
      contextGraphId,
      status: missingPublishIdentity ? 'skipped' : 'failed',
      error: message,
      details: { advisoryId: intel.advisory_id, package: intel.package_name },
    }));
  }
}

async function syncPrivateAuditGraph(
  ctx: RequestContext,
  event: ReturnType<typeof normalizeGuardianEvent>,
  findings: GuardianFindingRecord[],
): Promise<void> {
  const contextGraphId = PRIVATE_AUDIT_GRAPH_ID;
  try {
    await ensureContextGraph(ctx, contextGraphId, {
      name: 'Guardian Local Audit',
      description: 'Private local Guardian audit graph for this machine.',
      private: true,
      accessPolicy: 1,
    });
    const quads = buildPrivateAuditQuads(event, findings, contextGraphId);
    if (quads.length > 0) {
      await ctx.agent.share(contextGraphId, quads, {
        localOnly: true,
        callerAgentAddress: ctx.requestAgentAddress,
      });
    }
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-private-local-audit',
      scope: 'private',
      contextGraphId,
      status: 'synced',
      details: { eventId: event.id, findingCount: findings.length },
    }));
  } catch (err) {
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-private-local-audit',
      scope: 'private',
      contextGraphId,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      details: { eventId: event.id, findingCount: findings.length },
    }));
  }
}

async function ensureContextGraph(
  ctx: RequestContext,
  contextGraphId: string,
  opts: {
    name: string;
    description: string;
    accessPolicy?: number;
    publishPolicy?: number;
    private?: boolean;
  },
): Promise<void> {
  const exists = await ctx.agent.contextGraphExists(contextGraphId).catch(() => false);
  if (exists) return;
  await ctx.agent.createContextGraph({
    id: contextGraphId,
    name: opts.name,
    description: opts.description,
    accessPolicy: opts.accessPolicy,
    publishPolicy: opts.publishPolicy,
    private: opts.private,
    callerAgentAddress: ctx.requestAgentAddress,
  });
}

async function ensureRegistered(ctx: RequestContext, contextGraphId: string): Promise<void> {
  const onChainId = await ctx.agent.getContextGraphOnChainId(contextGraphId).catch(() => null);
  if (onChainId) return;
  await ctx.agent.registerContextGraph(contextGraphId, {
    callerAgentAddress: ctx.requestAgentAddress,
    publishPolicy: 1,
  });
}

function graphSync(opts: {
  id: string;
  scope: 'private' | 'public';
  contextGraphId: string;
  status: GuardianGraphSyncRecord['status'];
  error?: string | null;
  details: Record<string, unknown>;
}): GuardianGraphSyncRecord {
  const now = Date.now();
  return {
    id: opts.id,
    scope: opts.scope,
    context_graph_id: opts.contextGraphId,
    status: opts.status,
    last_error: opts.error ? sanitizeText(opts.error, 1000) : null,
    last_synced_at: opts.status === 'synced' ? now : null,
    details_json: JSON.stringify(redactGuardianData(opts.details)),
    updated_at: now,
  };
}

function parseDependencyComponents(raw: unknown): GuardianDependencyComponent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): GuardianDependencyComponent[] => {
    if (!item || typeof item !== 'object') return [];
    const rec = item as Record<string, unknown>;
    const ecosystem = typeof rec.ecosystem === 'string' ? rec.ecosystem : '';
    const name = typeof rec.name === 'string' ? rec.name : typeof rec.package === 'string' ? rec.package : '';
    const version = typeof rec.version === 'string' ? rec.version : '';
    if (!ecosystem || !name || !version) return [];
    return [{ ecosystem, name, version, source: typeof rec.source === 'string' ? rec.source : 'api' }];
  });
}

function dedupeComponents(components: GuardianDependencyComponent[]): GuardianDependencyComponent[] {
  const seen = new Set<string>();
  const out: GuardianDependencyComponent[] = [];
  for (const component of components) {
    if (!component.name || !component.version || !component.ecosystem) continue;
    const key = `${component.ecosystem}:${component.name.toLowerCase()}:${component.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(component);
  }
  return out;
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

function normalizeOsvRecord(value: any, id: string): OsvRecord {
  if (!value || typeof value !== 'object') return { id };
  return { ...value, id: typeof value.id === 'string' ? value.id : id };
}

function severityFromOsv(osv: OsvRecord, knownExploited: boolean): GuardianSeverity {
  if (knownExploited) return 'critical';
  const raw = osv.database_specific?.severity
    ?? osv.affected?.map((a) => a.ecosystem_specific?.severity).find(Boolean)
    ?? '';
  return normalizeSeverity(raw, 'medium');
}

function fixedVersions(osv: OsvRecord): string[] {
  const out: string[] = [];
  for (const affected of osv.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) out.push(event.fixed);
      }
    }
  }
  return [...new Set(out)];
}

function cvesFor(osv: OsvRecord): string[] {
  const values = [osv.id, ...(osv.aliases ?? [])];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && /^CVE-\d{4}-\d{4,}$/i.test(v)).map((v) => v.toUpperCase()))];
}

async function loadCisaKev(): Promise<Map<string, CisaKevEntry>> {
  if (cisaCache && Date.now() - cisaCache.loadedAt < 6 * 60 * 60 * 1000) {
    return cisaCache.byCve;
  }
  const data = await fetchJson(CISA_KEV_URL);
  const entries = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities : [];
  const byCve = new Map<string, CisaKevEntry>();
  for (const entry of entries) {
    const cve = String(entry.cveID ?? entry.cveId ?? '').toUpperCase();
    if (cve) byCve.set(cve, entry);
  }
  cisaCache = { loadedAt: Date.now(), byCve };
  return byCve;
}

async function fetchEpss(cves: string[]): Promise<{ score: number; percentile: number; date: string } | null> {
  if (cves.length === 0) return null;
  const qs = new URLSearchParams({ cve: cves.slice(0, 100).join(',') });
  const data = await fetchJson(`${EPSS_URL}?${qs.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const best = rows
    .map((row: any) => ({
      score: Number(row.epss),
      percentile: Number(row.percentile),
      date: typeof row.date === 'string' ? row.date : '',
    }))
    .filter((row: any) => Number.isFinite(row.score))
    .sort((a: any, b: any) => b.score - a.score)[0];
  return best ?? null;
}

async function fetchNvdKev(cve: string): Promise<{ knownExploited: boolean; dateAdded: string | null } | null> {
  const qs = new URLSearchParams({ cveId: cve });
  const data = await fetchJson(`${NVD_CVE_URL}?${qs.toString()}`);
  const item = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities[0]?.cve : null;
  if (!item) return null;
  return {
    knownExploited: Boolean(item.cisaExploitAdd),
    dateAdded: typeof item.cisaExploitAdd === 'string' ? item.cisaExploitAdd : null,
  };
}
