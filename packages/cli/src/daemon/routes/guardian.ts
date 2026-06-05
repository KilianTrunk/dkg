// daemon/routes/guardian.ts
//
// First-class Umanitek Guardian audit routes. These routes ingest local agent
// telemetry from Hermes/OpenClaw adapters, run deterministic security analysis,
// persist findings in the Node UI DB, and write public-safe vulnerability
// intelligence into DKG.

import {
  analyzeGuardianEvent,
  buildEndorsementQuads,
  buildFalsePositiveQuads,
  buildFixPrompt,
  buildPrivateAuditQuads,
  buildPublicDependencyQuads,
  buildPublicEscalationThreatQuads,
  buildPublicInjectionThreatQuads,
  componentsFromFindings,
  GUARDIAN_PUBLIC_THREAT_GRAPH_ID,
  guardianDependencyIntelId,
  normalizeGuardianEvent,
  normalizeSeverity,
  redactGuardianData,
  sanitizeText,
  stableHash,
  threatIdentifierFor,
  threatUriFor,
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
const PUBLIC_VULN_GRAPH_ID = GUARDIAN_PUBLIC_THREAT_GRAPH_ID;
const GUARDIAN_CRON_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ─── In-memory graph pattern cache ───────────────────────────────────────────
// Refreshed every 10 min by the background cron. The event route uses these
// patterns to supplement the hardcoded baseline with anything the network
// has published since startup.
interface GraphPatternCache {
  injectionPatterns: Array<{ pattern: string; severity: GuardianSeverity; identifier: string }>;
  escalationShapes: Set<string>; // `toolName::argShape` signatures
  lastRefreshed: number;
}
let _patternCache: GraphPatternCache = {
  injectionPatterns: [],
  escalationShapes: new Set(),
  lastRefreshed: 0,
};
let _cronStarted = false;
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

  // Lazy-start the background cron on first request — no daemon lifecycle changes needed.
  if (!_cronStarted) {
    _cronStarted = true;
    void refreshGraphPatternCache(ctx).catch(() => {});
    setInterval(() => { void refreshGraphPatternCache(ctx).catch(() => {}); }, GUARDIAN_CRON_INTERVAL_MS);
  }

  if (req.method === 'POST' && path === '/api/guardian/events') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const result = await recordGuardianEvent(ctx, parsed as GuardianEventInput);
    return jsonResponse(res, 200, { ok: true, ...result });
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

  if (req.method === 'GET' && path === '/api/guardian/threats') {
    const limit = boundedInt(url.searchParams.get('limit'), 50, 1, 200);
    const threats = await listPublicThreats(ctx, limit);
    return jsonResponse(res, 200, { threats });
  }

  if (req.method === 'POST' && path === '/api/guardian/seed-threats') {
    try {
      const result = await seedPublicThreatGraph(ctx);
      return jsonResponse(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: sanitizeText(message, 500) });
    }
  }

  if (req.method === 'POST' && path === '/api/guardian/threats/endorse') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const identifier = typeof parsed.identifier === 'string' ? parsed.identifier.trim() : '';
    if (!identifier) {
      return jsonResponse(res, 400, { error: 'Missing identifier' });
    }
    const endorserAddress = ctx.requestAgentAddress;
    if (!endorserAddress) {
      return jsonResponse(res, 401, {
        error: 'Endorsement requires an authenticated agent. Provide a bearer token tied to a registered agent.',
      });
    }
    try {
      await ensureContextGraph(ctx, PUBLIC_VULN_GRAPH_ID, {
        name: 'Guardian Vulnerability Intelligence',
        description: 'Public Umanitek Guardian context graph for reusable threat intelligence.',
        accessPolicy: 0,
        publishPolicy: 1,
      });
      const quads = buildEndorsementQuads({
        threatIdentifier: identifier,
        endorserAddress,
      }, PUBLIC_VULN_GRAPH_ID);
      await ctx.agent.share(PUBLIC_VULN_GRAPH_ID, quads, {
        callerAgentAddress: endorserAddress,
      });
      const endorsementCount = await countEndorsements(ctx, identifier);
      return jsonResponse(res, 200, { ok: true, identifier, endorsementCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: sanitizeText(message, 500) });
    }
  }

  if (req.method === 'POST' && path === '/api/guardian/threats/false-positive') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const identifier = typeof parsed.identifier === 'string' ? parsed.identifier.trim() : '';
    if (!identifier) {
      return jsonResponse(res, 400, { error: 'Missing identifier' });
    }
    const reporterAddress = ctx.requestAgentAddress;
    if (!reporterAddress) {
      return jsonResponse(res, 401, { error: 'Authentication required.' });
    }
    try {
      await ensureContextGraph(ctx, PUBLIC_VULN_GRAPH_ID, {
        name: 'Guardian Vulnerability Intelligence',
        description: 'Public Umanitek Guardian context graph for reusable threat intelligence.',
        accessPolicy: 0,
        publishPolicy: 1,
      });
      const quads = buildFalsePositiveQuads({
        threatIdentifier: identifier,
        reporterAddress,
      }, PUBLIC_VULN_GRAPH_ID);
      await ctx.agent.share(PUBLIC_VULN_GRAPH_ID, quads, {
        callerAgentAddress: reporterAddress,
      });
      return jsonResponse(res, 200, { ok: true, identifier, flagged: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: sanitizeText(message, 500) });
    }
  }
}

/**
 * Shared event ingestion pipeline — used by `POST /api/guardian/events` and by
 * any in-process emitter (e.g. the Hermes route handler after a turn is
 * persisted). Normalizes the event, runs the analyzer, persists, syncs
 * private + public graphs, and resolves dependency intel.
 */
export async function recordGuardianEvent(
  ctx: RequestContext,
  input: GuardianEventInput,
): Promise<{
  event: ReturnType<typeof normalizeGuardianEvent>;
  findings: GuardianFindingRecord[];
  inserted: boolean;
  dependencyIntel: GuardianDependencyIntelRecord[];
}> {
  const event = normalizeGuardianEvent(input);
  const localFindings = analyzeGuardianEvent(event);
  // Graph-first: check cached threat patterns from the DKG before trusting
  // only the hardcoded baseline — any threat published by any node on the
  // network enriches detection for every subscriber.
  const graphFindings = applyGraphPatterns(event);
  const findings = dedupeGuardianFindings([...localFindings, ...graphFindings]);
  const stored = ctx.dashDb.upsertGuardianEvent(event);
  ctx.dashDb.upsertGuardianFindings(findings);

  await syncPrivateAuditGraph(ctx, event, findings);
  await publishPublicNonDependencyThreats(ctx, findings);

  const components = componentsFromFindings(findings);
  const dependencyIntel = components.length > 0
    ? await enrichAndStoreDependencies(ctx, components)
    : [];

  return { event, findings, inserted: stored.inserted, dependencyIntel };
}

async function enrichAndStoreDependencies(
  ctx: RequestContext,
  components: GuardianDependencyComponent[],
): Promise<GuardianDependencyIntelRecord[]> {
  const unique = dedupeComponents(components);
  if (unique.length === 0) return [];

  // Graph-first: ask the public threat CG before paying for an osv round-trip.
  // Components found there as curated / corroborated short-circuit the network
  // path and feed the same UI surface as fresh osv intel.
  const fromGraph: GuardianDependencyIntelRecord[] = [];
  const missing: GuardianDependencyComponent[] = [];
  for (const component of unique) {
    const cached = await lookupCuratedDependencyThreat(ctx, component);
    if (cached) {
      fromGraph.push(cached);
    } else {
      missing.push(component);
    }
  }

  const fromOsv = missing.length > 0 ? await queryOsv(missing) : [];
  const records = [...fromGraph, ...fromOsv];

  for (const record of records) {
    ctx.dashDb.upsertGuardianDependencyIntel(record);
  }
  // Only fresh osv results need write-back; graph hits already live in the CG.
  for (const record of fromOsv) {
    await publishPublicDependencyIntel(ctx, record);
  }
  return records;
}

const GRAPH_TRUST_THRESHOLD = Number.parseInt(process.env.UMANITEK_TRUST_THRESHOLD_COUNT ?? '3', 10);

/**
 * Query the public threat CG for a curated or corroborated entry matching the
 * component identifier. Returns a synthesized intel record (marked as
 * `published`) so callers can short-circuit the osv pipeline.
 *
 * "Corroborated" = `umanitek:curated true` OR endorsement count
 * >= UMANITEK_TRUST_THRESHOLD_COUNT (default 3). If the SPARQL endpoint is
 * unavailable for any reason, we fall through to osv silently — graph-first is
 * an optimization, not a precondition.
 */
async function lookupCuratedDependencyThreat(
  ctx: RequestContext,
  component: GuardianDependencyComponent,
): Promise<GuardianDependencyIntelRecord | null> {
  const identifier = threatIdentifierFor({
    type: 'dependency',
    ecosystem: component.ecosystem,
    name: component.name,
    version: component.version,
  });
  const sparql = `
    PREFIX g: <http://umanitek.ai/ontology/guardian/>
    PREFIX schema: <http://schema.org/>
    SELECT ?threat ?advisoryId ?severity ?summary ?curated (COUNT(DISTINCT ?endorser) AS ?endorsementCount)
    WHERE {
      ?threat g:identifier "${identifier.replace(/"/g, '\\"')}" .
      FILTER(STRSTARTS(STR(?threat), "urn:guardian:threat:"))
      OPTIONAL { ?threat g:curated ?curated . }
      OPTIONAL { ?threat g:severity ?severity . }
      OPTIONAL { ?threat schema:description ?summary . }
      OPTIONAL { ?threat schema:identifier ?advisoryId . }
      OPTIONAL { ?endorsement g:endorses ?threat . ?endorsement g:endorser ?endorser . }
    }
    GROUP BY ?threat ?advisoryId ?severity ?summary ?curated
    LIMIT 1
  `;
  try {
    const result = await (ctx.agent as any).query(sparql, {
      contextGraphId: PUBLIC_VULN_GRAPH_ID,
      view: 'shared-working-memory',
    });
    const bindings = (result as any)?.bindings ?? [];
    const row = bindings[0];
    if (!row) return null;
    const curated = literalEquals(row.curated, 'true');
    const rawCount = extractLiteral(row.endorsementCount) ?? '0';
    const endorsementCount = Number.isFinite(Number(rawCount)) ? Number(rawCount) : 0;
    if (!curated && endorsementCount < GRAPH_TRUST_THRESHOLD) return null;
    const severity = normalizeSeverity(extractLiteral(row.severity), 'medium');
    const advisoryId = extractLiteral(row.advisoryId) || identifier;
    const summary = extractLiteral(row.summary) || `Threat published via Umanitek graph (${identifier}).`;
    const now = Date.now();
    return {
      id: guardianDependencyIntelId(component, advisoryId),
      ecosystem: component.ecosystem,
      package_name: component.name,
      package_version: component.version,
      advisory_id: advisoryId,
      cve_ids_json: '[]',
      severity,
      summary: sanitizeText(summary, 1200),
      fixed_versions_json: '[]',
      references_json: '[]',
      known_exploited: 0,
      exploited_at: null,
      epss_score: null,
      epss_percentile: null,
      epss_date: null,
      osv_json: JSON.stringify({ source: 'umanitek-graph', identifier, curated, endorsementCount }),
      publish_status: 'published',
      publish_error: null,
      publish_tx_hash: null,
      public_graph_id: PUBLIC_VULN_GRAPH_ID,
      updated_at: now,
      last_seen_at: now,
    };
  } catch {
    return null;
  }
}

/**
 * Extract a plain string value from a SPARQL binding entry.
 *
 * Handles three shapes:
 *   - Plain string URI:        `urn:guardian:...`     → returned as-is
 *   - Plain string literal:    `"foo"`                → `foo`
 *   - Typed literal:           `"0"^^<xsd:integer>`   → `0`
 *   - Lang-tagged literal:     `"hello"@en`           → `hello`
 *   - SPARQL-JSON object:      `{ value: "foo" }`     → `foo`
 */
// ─── Cron: pull new threats from the public graph every 10 min ───────────────
/**
 * Refresh the in-memory graph pattern cache from the public threat CG.
 * Runs once at startup (lazy, first request) and every 10 minutes thereafter.
 * New threats published by ANY connected peer flow into local detection
 * without a daemon restart — this is how the network improves every node.
 */
async function refreshGraphPatternCache(ctx: RequestContext): Promise<void> {
  const sparql = `
    PREFIX g: <http://umanitek.ai/ontology/guardian/>
    PREFIX schema: <http://schema.org/>
    SELECT ?identifier ?type ?pattern ?toolName ?argShape ?severity WHERE {
      ?threat g:identifier ?identifier .
      OPTIONAL { ?threat g:pattern ?pattern . }
      OPTIONAL { ?threat g:toolName ?toolName . }
      OPTIONAL { ?threat g:argShape ?argShape . }
      OPTIONAL { ?threat g:severity ?severity . }
    }
    LIMIT 500
  `;
  try {
    const result = await (ctx.agent as any).query(sparql, {
      contextGraphId: PUBLIC_VULN_GRAPH_ID,
      view: 'shared-working-memory',
    });
    const bindings = (result as any)?.bindings ?? [];
    const injectionPatterns: GraphPatternCache['injectionPatterns'] = [];
    const escalationShapes = new Set<string>();

    for (const row of bindings) {
      const identifier = extractLiteral(row.identifier) ?? '';
      const severity = normalizeSeverity(extractLiteral(row.severity), 'high');

      if (identifier.startsWith('injection:')) {
        const pattern = extractLiteral(row.pattern);
        if (pattern) injectionPatterns.push({ pattern, severity, identifier });
      } else if (identifier.startsWith('escalation:')) {
        const toolName = extractLiteral(row.toolName);
        const argShape = extractLiteral(row.argShape);
        if (toolName && argShape) escalationShapes.add(`${toolName.toLowerCase()}::${argShape}`);
      }
    }

    _patternCache = { injectionPatterns, escalationShapes, lastRefreshed: Date.now() };
    console.info(`[guardian-cron] cache refreshed: ${injectionPatterns.length} injection patterns, ${escalationShapes.size} escalation shapes`);
  } catch (err) {
    // Degrade gracefully — local hardcoded baseline still protects
    console.debug('[guardian-cron] pattern cache refresh failed (non-fatal):', err);
  }
}

/**
 * Apply cached graph patterns to an event — supplements the hardcoded
 * `analyzeGuardianEvent` baseline with anything the network has published.
 */
function applyGraphPatterns(
  event: ReturnType<typeof normalizeGuardianEvent>,
): GuardianFindingRecord[] {
  const findings: GuardianFindingRecord[] = [];
  if (_patternCache.injectionPatterns.length === 0 && _patternCache.escalationShapes.size === 0) {
    return findings;
  }

  const now = Date.now();
  const textSamples = [
    event.summary,
    ...Object.values(JSON.parse(event.raw_json)?.data ?? {} as Record<string, unknown>)
      .filter((v): v is string => typeof v === 'string'),
  ].join(' ');

  // Injection: test each cached pattern against the event text
  for (const { pattern, severity, identifier } of _patternCache.injectionPatterns) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(textSamples)) {
        findings.push({
          id: `guardian-finding-graph-${stableHash({ eventId: event.id, identifier }, 24)}`,
          event_id: event.id,
          ts: now,
          type: 'prompt_injection',
          severity,
          title: 'Prompt injection — matched graph pattern',
          summary: `Graph threat ${identifier} matched. Pattern: ${pattern.slice(0, 120)}`,
          recommendation: 'Treat the source content as untrusted. Review against the DKG threat graph.',
          evidence_json: JSON.stringify({ identifier, pattern: pattern.slice(0, 200) }),
          status: 'open',
          public_safe: 0,
          package_name: null,
          package_version: null,
          package_ecosystem: null,
          advisory_id: null,
          graph_scope: 'private',
          created_at: now,
          updated_at: now,
        });
      }
    } catch {
      // Malformed pattern in graph — skip
    }
  }

  // Escalation: check tool calls for known dangerous shapes
  const toolCalls: Array<{ toolName?: string; args?: Record<string, unknown> }> = (() => {
    try { return JSON.parse(event.raw_json)?.data?.toolCalls ?? []; } catch { return []; }
  })();
  for (const tc of toolCalls) {
    const toolName = tc.toolName?.toLowerCase() ?? '';
    for (const shape of _patternCache.escalationShapes) {
      const [shapeToolName] = shape.split('::');
      if (toolName === shapeToolName) {
        findings.push({
          id: `guardian-finding-graph-${stableHash({ eventId: event.id, shape }, 24)}`,
          event_id: event.id,
          ts: now,
          type: 'risky_shell',
          severity: 'critical',
          title: 'Dangerous tool call — matched graph escalation shape',
          summary: `Tool call matched DKG escalation threat: ${shape}`,
          recommendation: 'Review this tool call against the known dangerous shapes in the threat graph.',
          evidence_json: JSON.stringify({ shape }),
          status: 'open',
          public_safe: 0,
          package_name: null,
          package_version: null,
          package_ecosystem: null,
          advisory_id: null,
          graph_scope: 'private',
          created_at: now,
          updated_at: now,
        });
        break;
      }
    }
  }

  return findings;
}

/** Deduplicate findings by id — prevents the same finding from appearing twice
 *  when both local baseline and graph patterns match the same event. */
function dedupeGuardianFindings(findings: GuardianFindingRecord[]): GuardianFindingRecord[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

// ─── SPARQL helpers ───────────────────────────────────────────────────────────
function extractLiteral(value: unknown): string | null {
  if (typeof value === 'string') {
    if (value.startsWith('"')) {
      // Find the closing unescaped quote
      let i = 1;
      while (i < value.length) {
        if (value[i] === '"' && value[i - 1] !== '\\') break;
        i++;
      }
      return i < value.length ? (value.slice(1, i) || null) : null;
    }
    return value || null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as { value?: unknown };
  return typeof v.value === 'string' ? (v.value || null) : null;
}

function literalEquals(value: unknown, expected: string): boolean {
  return extractLiteral(value)?.toLowerCase() === expected.toLowerCase();
}

export interface PublicThreat {
  identifier: string;
  type: 'dependency' | 'injection' | 'escalation' | 'unknown';
  severity: GuardianSeverity;
  title: string;
  summary: string;
  curated: boolean;
  endorsementCount: number;
}

/**
 * List Threats in the public CG with their corroboration counts. Used by the
 * Guardian UI's "Public threat graph" panel — concise enough to render in a
 * single list without extra round-trips.
 */
async function listPublicThreats(ctx: RequestContext, limit: number): Promise<PublicThreat[]> {
  const sparql = `
    PREFIX g: <http://umanitek.ai/ontology/guardian/>
    PREFIX schema: <http://schema.org/>
    SELECT ?threat ?identifier ?severity ?title ?summary ?curated (COUNT(DISTINCT ?endorser) AS ?endorsementCount)
    WHERE {
      ?threat g:identifier ?identifier .
      FILTER(STRSTARTS(STR(?threat), "urn:guardian:threat:"))
      OPTIONAL { ?threat g:severity ?severity . }
      OPTIONAL { ?threat schema:name ?title . }
      OPTIONAL { ?threat schema:description ?summary . }
      OPTIONAL { ?threat g:curated ?curated . }
      OPTIONAL { ?endorsement g:endorses ?threat . ?endorsement g:endorser ?endorser . }
    }
    GROUP BY ?threat ?identifier ?severity ?title ?summary ?curated
    ORDER BY DESC(?endorsementCount)
    LIMIT ${Math.max(1, Math.min(limit, 200))}
  `;
  try {
    const result = await (ctx.agent as any).query(sparql, {
      contextGraphId: PUBLIC_VULN_GRAPH_ID,
      view: 'shared-working-memory',
    });
    const bindings = (result as any)?.bindings ?? [];
    return bindings.map((row: any): PublicThreat => {
      const identifier = extractLiteral(row.identifier) ?? '';
      const prefix = identifier.split(':', 1)[0];
      const type: PublicThreat['type'] = prefix === 'dep' ? 'dependency'
        : prefix === 'injection' ? 'injection'
        : prefix === 'escalation' ? 'escalation'
        : 'unknown';
      return {
        identifier,
        type,
        severity: normalizeSeverity(extractLiteral(row.severity), 'medium'),
        title: extractLiteral(row.title) ?? identifier,
        summary: extractLiteral(row.summary) ?? '',
        curated: literalEquals(row.curated, 'true'),
        endorsementCount: Number(extractLiteral(row.endorsementCount) ?? '0'),
      };
    }).filter((t: PublicThreat) => t.identifier.length > 0);
  } catch {
    return [];
  }
}

/** Curated seed data inlined at build time — no file read needed at runtime. */
const SEED_DATA = {
  dependencies: [
    { ecosystem: 'npm', name: 'event-stream', version: '3.3.6', advisoryId: 'GHSA-mh6f-8j2x-4483', severity: 'critical' as GuardianSeverity, summary: 'Backdoored release that exfiltrated bitcoin wallet credentials via the flatmap-stream dependency.' },
    { ecosystem: 'npm', name: 'ua-parser-js', version: '0.7.29', advisoryId: 'GHSA-pjwm-rvh2-c87w', severity: 'critical' as GuardianSeverity, summary: 'Compromised release that shipped cryptominers and credential stealers; affected 0.7.29, 0.8.0, 1.0.0.' },
    { ecosystem: 'npm', name: 'colors', version: '1.4.1', advisoryId: 'GHSA-2qrg-x229-3v8q', severity: 'high' as GuardianSeverity, summary: 'Maintainer-introduced infinite loop in 1.4.1 that crashes downstream consumers (also affects faker@6.6.6).' },
    { ecosystem: 'npm', name: 'node-ipc', version: '10.1.1', advisoryId: 'GHSA-97m3-w2cp-4xx6', severity: 'critical' as GuardianSeverity, summary: 'Maintainer-injected wiper targeting Russian and Belarusian IP geolocations.' },
    { ecosystem: 'PyPI', name: 'ctx', version: '0.2.2', advisoryId: 'PYSEC-2022-200', severity: 'high' as GuardianSeverity, summary: 'Hijacked release that exfiltrated environment variables to an external endpoint.' },
  ],
  injection: [
    { pattern: 'ignore (?:all )?(?:previous|prior|above|system|developer) instructions', severity: 'high' as GuardianSeverity, title: 'Instruction override: ignore previous instructions', summary: 'Classic prompt-injection lead used to overwrite system or developer prompts.', owaspCategory: 'LLM01' },
    { pattern: 'reveal (?:the )?(?:system|developer|hidden) prompt', severity: 'high' as GuardianSeverity, title: 'System prompt disclosure attempt', summary: 'Attempts to coax the model into emitting its system or developer prompt.', owaspCategory: 'LLM01' },
    { pattern: 'you are now (?:in )?(?:developer|system|admin|root) mode', severity: 'high' as GuardianSeverity, title: 'Role override: developer/admin mode', summary: 'Tries to switch the assistant into an elevated role with relaxed safety boundaries.', owaspCategory: 'LLM01' },
    { pattern: 'exfiltrat(?:e|ion)|steal (?:the )?(?:secret|token|key|credential)', severity: 'critical' as GuardianSeverity, title: 'Credential exfiltration intent', summary: 'Direct request to siphon secrets, tokens, or credentials out of the context.', owaspCategory: 'LLM06' },
  ],
  escalation: [
    { toolName: 'shell', argShape: 'remote-script-pipe', severity: 'critical' as GuardianSeverity, title: 'Remote script piped to a shell', summary: 'Agent invoked curl/wget piped directly into bash/sh/python — no integrity check, no inspection.' },
    { toolName: 'shell', argShape: 'rm-rf-system-paths', severity: 'critical' as GuardianSeverity, title: 'Destructive recursive remove against system paths', summary: 'Agent issued rm -rf against /etc, /usr, /var, or the user home — high blast radius.' },
  ],
};

function loadSeed(): typeof SEED_DATA {
  return SEED_DATA;
}

/**
 * Publish the curated seed entries to the public threat CG. Marked
 * `curated=true` so graph-first lookup short-circuits on them without needing
 * peer corroboration. Safe to re-run — `?threat g:identifier` deduplicates by
 * identifier, so subsequent calls are no-ops on already-seeded entries.
 */
async function seedPublicThreatGraph(ctx: RequestContext): Promise<{ published: number; identifiers: string[] }> {
  const seed = loadSeed();
  const contextGraphId = PUBLIC_VULN_GRAPH_ID;
  await ensureContextGraph(ctx, contextGraphId, {
    name: 'Guardian Vulnerability Intelligence',
    description: 'Public Umanitek Guardian context graph for reusable threat intelligence.',
    accessPolicy: 0,
    publishPolicy: 1,
  });
  await ensureRegistered(ctx, contextGraphId);

  // Seeding uses SWM (share) rather than VM (publish) — no core peers needed,
  // free, immediate, and the SPARQL lookup already queries shared-working-memory.
  // Operators can promote to VM later via the publish pipeline if they want
  // permanent on-chain anchoring.
  const identifiers: string[] = [];
  const errors: string[] = [];

  async function shareOne(quads: Array<{ subject: string; predicate: string; object: string; graph: string }>, id: string): Promise<void> {
    try {
      await ctx.agent.share(contextGraphId, quads, {
        callerAgentAddress: ctx.requestAgentAddress,
      });
      identifiers.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${id}: ${msg.slice(0, 120)}`);
    }
  }

  for (const dep of seed.dependencies ?? []) {
    const id = threatIdentifierFor({ type: 'dependency', ecosystem: dep.ecosystem, name: dep.name, version: dep.version });
    if (await hasThreat(ctx, id)) continue;
    const now = Date.now();
    await shareOne(buildPublicDependencyQuads({
      id: guardianDependencyIntelId({ ecosystem: dep.ecosystem, name: dep.name, version: dep.version }, dep.advisoryId),
      ecosystem: dep.ecosystem,
      package_name: dep.name,
      package_version: dep.version,
      advisory_id: dep.advisoryId,
      cve_ids_json: '[]',
      severity: dep.severity,
      summary: dep.summary,
      fixed_versions_json: '[]',
      references_json: '[]',
      known_exploited: 0,
      exploited_at: null,
      epss_score: null,
      epss_percentile: null,
      epss_date: null,
      osv_json: JSON.stringify({ source: 'umanitek-seed' }),
      publish_status: 'published',
      publish_error: null,
      publish_tx_hash: null,
      public_graph_id: contextGraphId,
      updated_at: now,
      last_seen_at: now,
    }, contextGraphId, { curated: true }), id);
  }

  for (const inj of seed.injection ?? []) {
    const id = threatIdentifierFor({ type: 'injection', pattern: inj.pattern });
    if (await hasThreat(ctx, id)) continue;
    await shareOne(buildPublicInjectionThreatQuads({
      pattern: inj.pattern,
      severity: inj.severity,
      title: inj.title,
      summary: inj.summary,
      owaspCategory: inj.owaspCategory,
    }, contextGraphId, { curated: true }), id);
  }

  for (const esc of seed.escalation ?? []) {
    const id = threatIdentifierFor({ type: 'escalation', toolName: esc.toolName, argShape: esc.argShape });
    if (await hasThreat(ctx, id)) continue;
    await shareOne(buildPublicEscalationThreatQuads({
      toolName: esc.toolName,
      argShape: esc.argShape,
      severity: esc.severity,
      title: esc.title,
      summary: esc.summary,
    }, contextGraphId, { curated: true }), id);
  }

  return { published: identifiers.length, identifiers, ...(errors.length > 0 ? { errors } : {}) } as any;
}

async function hasThreat(ctx: RequestContext, identifier: string): Promise<boolean> {
  // Check for the canonical URI directly (not by identifier) so old-format
  // entries with a different subject URI don't mask re-seeding.
  const threatUri = threatUriFor(identifier);
  const sparql = `SELECT ?p WHERE { <${threatUri}> ?p ?o . } LIMIT 1`;
  try {
    const result = await (ctx.agent as any).query(sparql, {
      contextGraphId: PUBLIC_VULN_GRAPH_ID,
      view: 'shared-working-memory',
    });
    const bindings = (result as any)?.bindings ?? (result as any)?.result?.bindings ?? [];
    return Array.isArray(bindings) && bindings.length > 0;
  } catch {
    return false;
  }
}

async function countEndorsements(ctx: RequestContext, identifier: string): Promise<number> {
  const sparql = `
    PREFIX g: <http://umanitek.ai/ontology/guardian/>
    SELECT (COUNT(DISTINCT ?endorser) AS ?n) WHERE {
      ?threat g:identifier "${identifier.replace(/"/g, '\\"')}" .
      ?endorsement g:endorses ?threat .
      ?endorsement g:endorser ?endorser .
    }
  `;
  try {
    const result = await (ctx.agent as any).query(sparql, {
      contextGraphId: PUBLIC_VULN_GRAPH_ID,
      view: 'shared-working-memory',
    });
    const row = (result as any)?.bindings?.[0];
    const n = Number(extractLiteral(row?.n) ?? '0');
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
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
    // Use share() (SWM) — free, no core peers required, immediately queryable
    // by any node subscribed to the CG. New discoveries flow into the graph
    // the same way as seeded threats. Any node can then endorse / flag them.
    await ctx.agent.share(
      contextGraphId,
      buildPublicDependencyQuads(intel, contextGraphId),
      { callerAgentAddress: ctx.requestAgentAddress },
    );
    ctx.dashDb.updateGuardianDependencyPublish(intel.id, {
      publish_status: 'published',
      publish_tx_hash: null,
      public_graph_id: contextGraphId,
    });
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-vulnerability-intel',
      scope: 'public',
      contextGraphId,
      status: 'synced',
      details: { advisoryId: intel.advisory_id, package: intel.package_name },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.dashDb.updateGuardianDependencyPublish(intel.id, {
      publish_status: 'failed',
      publish_error: sanitizeText(message, 1000),
      public_graph_id: contextGraphId,
    });
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-vulnerability-intel',
      scope: 'public',
      contextGraphId,
      status: 'failed',
      error: message,
      details: { advisoryId: intel.advisory_id, package: intel.package_name },
    }));
  }
}

/**
 * Publish injection + escalation threats to the public CG. We only emit the
 * matched signature, not the observed prompt or command, so private data never
 * leaves the box. Each unique identifier (regex pattern, tool+argShape) makes
 * one Threat KA that other nodes can endorse — corroboration via social proof.
 */
async function publishPublicNonDependencyThreats(
  ctx: RequestContext,
  findings: GuardianFindingRecord[],
): Promise<void> {
  const contextGraphId = PUBLIC_VULN_GRAPH_ID;
  const injectionPatterns = new Set<string>();
  const escalationKeys = new Set<string>();
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];

  for (const finding of findings) {
    if (finding.type === 'prompt_injection') {
      const evidence = safeParse(finding.evidence_json);
      const patterns = Array.isArray(evidence?.matchedPatterns)
        ? (evidence!.matchedPatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      for (const pattern of patterns.slice(0, 5)) {
        if (injectionPatterns.has(pattern)) continue;
        injectionPatterns.add(pattern);
        quads.push(...buildPublicInjectionThreatQuads({
          pattern,
          severity: finding.severity,
          title: `Prompt injection pattern: ${truncate(pattern, 80)}`,
          summary: finding.summary,
          owaspCategory: 'LLM01',
          ts: finding.ts,
        }, contextGraphId));
      }
      continue;
    }
    if (finding.type === 'risky_shell') {
      // Publish the generic shape only — the observed command stays private.
      const key = 'shell::remote-script-pipe';
      if (escalationKeys.has(key)) continue;
      escalationKeys.add(key);
      quads.push(...buildPublicEscalationThreatQuads({
        toolName: 'shell',
        argShape: 'remote-script-pipe',
        severity: finding.severity,
        title: 'Remote script piped to a shell',
        summary: finding.summary,
        ts: finding.ts,
      }, contextGraphId));
    }
  }

  if (quads.length === 0) return;

  try {
    await ensureContextGraph(ctx, contextGraphId, {
      name: 'Guardian Vulnerability Intelligence',
      description: 'Public Umanitek Guardian context graph for reusable threat intelligence.',
      accessPolicy: 0,
      publishPolicy: 1,
    });
    await ctx.agent.share(
      contextGraphId,
      quads,
      { callerAgentAddress: ctx.requestAgentAddress },
    );
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-threat-intel',
      scope: 'public',
      contextGraphId,
      status: 'synced',
      details: {
        injectionPatterns: [...injectionPatterns].slice(0, 5),
        escalationKeys: [...escalationKeys],
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.dashDb.upsertGuardianGraphSync(graphSync({
      id: 'guardian-public-threat-intel',
      scope: 'public',
      contextGraphId,
      status: 'failed',
      error: message,
      details: {
        injectionPatterns: [...injectionPatterns].slice(0, 5),
        escalationKeys: [...escalationKeys],
      },
    }));
  }
}

function safeParse(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
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
