import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  DatabaseZap,
  FileWarning,
  Flag,
  Globe2,
  KeyRound,
  Network,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);
import {
  endorseGuardianThreat,
  flagGuardianThreatFalsePositive,
  fetchGuardianEvents,
  fetchGuardianFindings,
  fetchGuardianSummary,
  fetchGuardianThreats,
  generateGuardianFixPrompt,
  runGuardianDependencyAudit,
  seedGuardianThreats,
  type GuardianDependencyIntel,
  type GuardianEvent,
  type GuardianFinding,
  type GuardianGraphSync,
  type GuardianPublicThreat,
  type GuardianSeverity,
  type GuardianSummary,
} from '../api.js';
import { useProjectsStore } from '../stores/projects.js';
import { useTabsStore } from '../stores/tabs.js';

const PUBLIC_THREAT_CG = 'guardian-vulnerability-intel';
const UMANITEK_LOGO_URL = new URL('../assets/umanitek-icon.svg', import.meta.url).href;

const G = 'http://umanitek.ai/ontology/guardian/';
const SCHEMA = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Hub node URIs — shared by multiple threats, creating the clustering edges
const HUBS = {
  dependency: 'urn:guardian:hub:supply-chain',
  injection:  'urn:guardian:hub:prompt-injection',
  escalation: 'urn:guardian:hub:privilege-escalation',
  unknown:    'urn:guardian:hub:other',
  critical:   'urn:guardian:hub:sev-critical',
  high:       'urn:guardian:hub:sev-high',
  medium:     'urn:guardian:hub:sev-medium',
  low:        'urn:guardian:hub:sev-low',
  umanitek:   'urn:guardian:curator:umanitek',
  npm:        'urn:guardian:ecosystem:npm',
  pypi:       'urn:guardian:ecosystem:pypi',
};

const THREAT_GRAPH_VIEW_CONFIG = {
  name: 'guardian-threats',
  // focal makes the Umanitek node large with the logo — the only reliable
  // sizeMultiplier path in applyViewConfig (nodeTypes.sizeMultiplier is not applied)
  focal: {
    uri: HUBS.umanitek,
    image: UMANITEK_LOGO_URL,
    sizeMultiplier: 4,
  },
  nodeTypes: {
    [`${G}Curator`]: {
      icon: UMANITEK_LOGO_URL,
      shape: 'circle' as const,
    },
  },
};

const THREAT_GRAPH_OPTIONS = {
  labelMode: 'humanized' as const,
  renderer: '2d' as const,
  labels: {
    predicates: [
      `${SCHEMA}name`,
      `${G}severity`,
      `${G}category`,
    ],
  },
  style: {
    classColors: {
      [`${G}Threat`]:              '#ef4444',   // red   — individual threat
      [`${G}ThreatCategory`]:      '#6366f1',   // indigo — type hub
      [`${G}SeverityLevel`]:       '#f97316',   // orange — severity hub
      [`${G}Curator`]:             '#111111',   // dark bg — white flag logo shows clearly
      [`${G}Ecosystem`]:           '#a3e635',   // lime  — npm / PyPI
      [`${G}Endorsement`]:         '#22c55e',   // green — endorsement
    },
    defaultNodeColor: '#64748b',
    defaultEdgeColor: '#334155',
    edgeWidth: 1.2,
    borderWidth: 0,
  },
  hexagon: { baseSize: 4, minSize: 2.5, maxSize: 7, scaleWithDegree: true },
  focus: { maxNodes: 500, hops: 3 },
  // Cool down simulation quickly — graph settles in ~3s then stays still.
  // User can still zoom + pan freely after it freezes.
  simulation: {
    cooldownTime: 3000,
    d3AlphaDecay: 0.04,
    d3VelocityDecay: 0.35,
  },
};

/** Build graph triples from clean PublicThreat objects — avoids raw URI slugs and
 *  adds shared hub nodes so every threat has 3–5 edges, making the graph connected. */
function buildThreatGraphTriples(
  threats: GuardianPublicThreat[],
): Array<{ subject: string; predicate: string; object: string }> {
  const triples: Array<{ subject: string; predicate: string; object: string }> = [];
  const lit = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const t = (s: string, p: string, o: string) => triples.push({ subject: s, predicate: p, object: o });

  // Define hub nodes
  const hubDefs: Array<{ uri: string; label: string; type: string }> = [
    { uri: HUBS.dependency,  label: 'Supply Chain',        type: `${G}ThreatCategory` },
    { uri: HUBS.injection,   label: 'Prompt Injection',    type: `${G}ThreatCategory` },
    { uri: HUBS.escalation,  label: 'Privilege Escalation',type: `${G}ThreatCategory` },
    { uri: HUBS.critical,    label: 'Critical',            type: `${G}SeverityLevel` },
    { uri: HUBS.high,        label: 'High',                type: `${G}SeverityLevel` },
    { uri: HUBS.medium,      label: 'Medium',              type: `${G}SeverityLevel` },
    { uri: HUBS.low,         label: 'Low',                 type: `${G}SeverityLevel` },
    { uri: HUBS.umanitek,    label: 'Umanitek',            type: `${G}Curator` },
    { uri: HUBS.npm,         label: 'npm',                 type: `${G}Ecosystem` },
    { uri: HUBS.pypi,        label: 'PyPI',                type: `${G}Ecosystem` },
  ];
  // Only emit hubs that are actually used (prune unused to keep graph clean)
  const usedHubs = new Set<string>();
  for (const threat of threats) {
    usedHubs.add(HUBS[threat.type as keyof typeof HUBS] ?? HUBS.unknown);
    usedHubs.add(HUBS[threat.severity as keyof typeof HUBS] ?? '');
    if (threat.curated) usedHubs.add(HUBS.umanitek);
    if (threat.type === 'dependency') {
      const id = threat.identifier;
      if (id.startsWith('dep:npm:')) usedHubs.add(HUBS.npm);
      if (id.startsWith('dep:pypi:')) usedHubs.add(HUBS.pypi);
    }
  }

  for (const hub of hubDefs) {
    if (!usedHubs.has(hub.uri)) continue;
    t(hub.uri, RDF_TYPE, hub.type);
    t(hub.uri, `${SCHEMA}name`, lit(hub.label));
  }

  for (const threat of threats) {
    const uri = `urn:guardian:threat:${threat.identifier.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;

    t(uri, RDF_TYPE, `${G}Threat`);
    t(uri, `${SCHEMA}name`, lit(threat.title));
    t(uri, `${G}severity`, lit(threat.severity));

    // Hub edges — these are what make the graph connected
    const typeHub = HUBS[threat.type as keyof typeof HUBS] ?? HUBS.unknown;
    t(uri, `${G}category`, typeHub);

    const sevHub = HUBS[threat.severity as keyof typeof HUBS];
    if (sevHub) t(uri, `${G}hasSeverityLevel`, sevHub);

    if (threat.curated) t(uri, `${G}curatedBy`, HUBS.umanitek);

    if (threat.type === 'dependency') {
      const ecoHub = threat.identifier.startsWith('dep:npm:') ? HUBS.npm
        : threat.identifier.startsWith('dep:pypi:') ? HUBS.pypi
        : null;
      if (ecoHub) t(uri, `${G}inEcosystem`, ecoHub);
    }

    // Endorsement nodes (one per endorser, shown as small green nodes)
    for (let i = 0; i < threat.endorsementCount; i++) {
      const eUri = `urn:guardian:endorsement:${threat.identifier.replace(/[^a-z0-9]/gi, '-')}-${i}`;
      t(eUri, RDF_TYPE, `${G}Endorsement`);
      t(eUri, `${SCHEMA}name`, lit('Endorsed'));
      t(eUri, `${G}endorses`, uri);
    }
  }
  return triples;
}

const SEVERITY_ORDER: GuardianSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
type JsonRecord = Record<string, unknown>;
type GuardianEventState = 'ok' | 'failed' | 'warning';
type GuardianThreat = {
  severity: GuardianSeverity;
  type: string;
};

function severityClass(severity: string): string {
  return `guardian-severity-${severity || 'info'}`;
}

function severityRank(severity: GuardianSeverity): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? 0 : SEVERITY_ORDER.length - index;
}

function topFindingSeverity(findings: GuardianFinding[]): GuardianSeverity | null {
  if (findings.length === 0) return null;
  return findings.reduce<GuardianSeverity>(
    (best, finding) => (severityRank(finding.severity) > severityRank(best) ? finding.severity : best),
    findings[0].severity,
  );
}

function primaryThreat(findings: GuardianFinding[]): GuardianThreat | null {
  const severity = topFindingSeverity(findings);
  if (!severity) return null;
  const finding = findings.find((item) => item.severity === severity) ?? findings[0];
  return { severity, type: finding.type.replace(/_/g, ' ') };
}

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function displayText(value: unknown, maxLength = 260): string {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const homeSafe = raw
    .replace(/[A-Z]:\\Users\\[^\\\s"']+/g, '~')
    .replace(/\/Users\/[^/\s"']+/g, '~')
    .replace(/\/home\/[^/\s"']+/g, '~');
  return homeSafe.length > maxLength ? `${homeSafe.slice(0, maxLength)}...` : homeSafe;
}

function recordAt(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)[key]
    : undefined;
}

function rawEventData(event: GuardianEvent): JsonRecord {
  const raw = parseJsonRecord(event.raw_json);
  const data = raw.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data as JsonRecord : {};
}

function eventInstanceLabel(event: GuardianEvent): string {
  const raw = parseJsonRecord(event.raw_json);
  const source = raw.sourceAgent;
  const instance = recordAt(source, 'instanceId');
  return typeof instance === 'string' && instance.trim()
    ? displayText(instance, 120)
    : displayText(event.source_agent, 120);
}

function commandFromEvent(event: GuardianEvent): string {
  const data = rawEventData(event);
  for (const key of ['command', 'cmd', 'shell', 'input']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return displayText(value, 900);
  }
  const args = data.args;
  for (const key of ['command', 'cmd']) {
    const value = recordAt(args, key);
    if (typeof value === 'string' && value.trim()) return displayText(value, 900);
  }
  return '';
}

function parsedResultFromEvent(event: GuardianEvent): JsonRecord {
  const data = rawEventData(event);
  const result = data.result;
  if (typeof result === 'string') return parseJsonRecord(result);
  return result && typeof result === 'object' && !Array.isArray(result) ? result as JsonRecord : {};
}

function resultOutputFromEvent(event: GuardianEvent): string {
  const result = parsedResultFromEvent(event);
  const output = result.output ?? result.error;
  return typeof output === 'string' && output.trim() ? displayText(output, 900) : '';
}

function eventExitCode(event: GuardianEvent): number | null {
  const result = parsedResultFromEvent(event);
  const rawCode = result.exit_code ?? result.exitCode ?? rawEventData(event).returnCode;
  return typeof rawCode === 'number' ? rawCode : null;
}

function eventState(event: GuardianEvent, threat?: GuardianThreat | null): GuardianEventState {
  const exitCode = eventExitCode(event);
  if (exitCode != null && exitCode !== 0) return 'failed';
  if (threat?.severity === 'critical' || threat?.severity === 'high') return 'failed';
  if (threat?.severity === 'medium' || threat?.severity === 'low') return 'warning';
  if (event.severity === 'critical' || event.severity === 'high') return 'failed';
  if (event.severity === 'medium' || event.severity === 'low') return 'warning';
  return 'ok';
}

function eventKind(event: GuardianEvent): string {
  if (event.event_type === 'agent_activity') return 'supervisor';
  if (event.event_type === 'api_request' || event.event_type === 'api_response') return 'model';
  if (event.event_type === 'tool_call') return event.tool_name || 'tool';
  return event.event_type.replace(/_/g, ' ');
}

function promptFromEvent(event: GuardianEvent): string {
  const data = rawEventData(event);
  const direct = data.prompt ?? data.input ?? data.user_message ?? data.userMessage ?? data.assistantSample;
  if (typeof direct === 'string' && direct.trim()) return displayText(direct, 900);
  const messages = data.messages ?? data.requestMessages;
  if (Array.isArray(messages)) {
    const text = messages
      .map((item) => {
        const role = recordAt(item, 'role');
        const content = recordAt(item, 'content') ?? recordAt(item, 'text');
        return typeof content === 'string' ? `${typeof role === 'string' ? role : 'message'}: ${content}` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return displayText(text, 900);
  }
  return '';
}

function evidenceFromFinding(finding: GuardianFinding): JsonRecord {
  return parseJsonRecord(finding.evidence_json);
}

function dependencyDates(intel: GuardianDependencyIntel): { published: string; modified: string } {
  const osv = parseJsonRecord(intel.osv_json);
  return {
    published: formatDate(osv.published),
    modified: formatDate(osv.modified),
  };
}

function findingAction(finding: GuardianFinding, event?: GuardianEvent): string {
  const evidence = evidenceFromFinding(finding);
  const command = displayText(evidence.command, 900) || (event ? commandFromEvent(event) : '');
  if (command) return command;
  const sample = displayText(evidence.sample, 900);
  if (sample) return sample;
  const path = displayText(evidence.path, 300);
  if (path) return path;
  return event ? (promptFromEvent(event) || displayText(event.summary, 300)) : '';
}

function publishDisplay(status: GuardianDependencyIntel['publish_status'] | GuardianGraphSync['status'], error?: string | null) {
  const blocked = Boolean(error && /insufficient funds|funds|balance|cannot be registered|default agent address|curator/i.test(error));
  if (status === 'published' || status === 'synced') return { label: 'synced', className: 'published', title: 'Stored and published to the configured graph.' };
  if (status === 'pending') return { label: 'pending', className: 'pending', title: 'Waiting to publish.' };
  if (status === 'skipped' || blocked) return { label: 'local only', className: 'skipped', title: error ? displayText(error, 500) : 'Stored locally; public publishing is not configured for this node.' };
  return { label: 'failed', className: 'failed', title: error ? displayText(error, 500) : 'Publish failed.' };
}

function StatTile({
  label,
  value,
  detail,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon: React.ReactNode;
  tone?: 'neutral' | 'danger' | 'warn' | 'good';
}) {
  return (
    <div className={`guardian-stat guardian-stat-${tone}`}>
      <div className="guardian-stat-icon">{icon}</div>
      <div>
        <div className="guardian-stat-label">{label}</div>
        <div className="guardian-stat-value">{value}</div>
        {detail && <div className="guardian-stat-detail">{detail}</div>}
      </div>
    </div>
  );
}

function GraphStatus({ graph, onOpen }: { graph: GuardianGraphSync; onOpen: (graph: GuardianGraphSync) => void }) {
  const status = publishDisplay(graph.status, graph.last_error);
  return (
    <button
      type="button"
      className={`guardian-graph-row guardian-graph-${status.className}`}
      title={`${status.title} Open graph.`}
      onClick={() => onOpen(graph)}
    >
      <div className="guardian-graph-icon">
        {graph.scope === 'public' ? <Globe2 size={16} /> : <KeyRound size={16} />}
      </div>
      <div className="guardian-graph-main">
        <span>{graph.context_graph_id}</span>
        <small>{graph.scope} graph</small>
      </div>
      <span className="guardian-graph-status">{status.label}</span>
    </button>
  );
}

function EventRow({ event, findings = [] }: { event: GuardianEvent; findings?: GuardianFinding[] }) {
  const command = commandFromEvent(event);
  const prompt = promptFromEvent(event);
  const exitCode = eventExitCode(event);
  const output = resultOutputFromEvent(event);
  const threat = primaryThreat(findings);
  const effectiveSeverity = threat?.severity ?? event.severity;
  const state = eventState(event, threat);
  return (
    <div className={`guardian-event-row guardian-event-${state} ${threat ? `guardian-event-threat guardian-event-threat-${threat.severity}` : ''}`}>
      <div className={`guardian-severity-dot ${severityClass(effectiveSeverity)}`} />
      <div className="guardian-row-main">
        <div className="guardian-row-title-line">
          <div className="guardian-row-title">{event.title}</div>
          <div className="guardian-row-badges">
            {threat && <span className={`guardian-threat-badge ${severityClass(threat.severity)}`}>Threat: {threat.type}</span>}
            <span className="guardian-event-kind">{eventKind(event)}</span>
          </div>
        </div>
        <div className="guardian-row-meta">
          <span>{event.agent_framework}</span>
          <span>{eventInstanceLabel(event)}</span>
          {exitCode != null && <span>exit {exitCode}</span>}
          <span>{timeAgo(event.ts)}</span>
        </div>
        {event.summary && <p className="guardian-event-summary">{displayText(event.summary, 420)}</p>}
        {output && <pre className="guardian-event-output">{output}</pre>}
        {(command || prompt) && (
          <details className="guardian-event-detail">
            <summary>{command ? 'Command' : 'Prompt / context'}</summary>
            <pre>{command || prompt}</pre>
          </details>
        )}
      </div>
      <span className={`guardian-pill ${severityClass(effectiveSeverity)}`}>{threat ? `${effectiveSeverity} threat` : event.severity}</span>
    </div>
  );
}

function FindingRow({ finding, event }: { finding: GuardianFinding; event?: GuardianEvent }) {
  const action = findingAction(finding, event);
  const evidence = evidenceFromFinding(finding);
  return (
    <div className="guardian-finding-row">
      <div className="guardian-finding-head">
        <span className={`guardian-pill ${severityClass(finding.severity)}`}>{finding.severity}</span>
        <span className="guardian-finding-type">{finding.type.replace(/_/g, ' ')}</span>
      </div>
      <div className="guardian-finding-title">{finding.title}</div>
      <div className="guardian-row-meta guardian-finding-source">
        <span>{event?.agent_framework ?? 'unknown agent'}</span>
        {event ? <span>{eventInstanceLabel(event)}</span> : null}
        <span>{event?.tool_name || event?.event_type || 'event unavailable'}</span>
        <span>{timeAgo(finding.ts)}</span>
      </div>
      <p>{displayText(finding.summary, 700)}</p>
      {action && (
        <div className="guardian-evidence">
          <span>{finding.type === 'prompt_injection' ? 'Observed prompt/context' : finding.type === 'dependency_install' ? 'Observed command' : 'Observed evidence'}</span>
          <pre>{action}</pre>
        </div>
      )}
      <div className="guardian-finding-rec">{finding.recommendation}</div>
      {Object.keys(evidence).length > 0 && (
        <details className="guardian-event-detail">
          <summary>Structured evidence</summary>
          <pre>{displayText(evidence, 1200)}</pre>
        </details>
      )}
    </div>
  );
}

function DependencyRow({ intel }: { intel: GuardianDependencyIntel }) {
  const cves = parseJsonArray(intel.cve_ids_json);
  const fixed = parseJsonArray(intel.fixed_versions_json);
  const refs = parseJsonArray(intel.references_json);
  const dates = dependencyDates(intel);
  const status = publishDisplay(intel.publish_status, intel.publish_error);
  const epss = intel.epss_score != null ? `${(intel.epss_score * 100).toFixed(1)}%` : 'pending';
  const percentile = intel.epss_percentile != null ? `p${Math.round(intel.epss_percentile * 100)}` : '';
  return (
    <div className="guardian-dep-row">
      <div className="guardian-dep-package">
        <span>{intel.package_name}</span>
        <small>{intel.ecosystem} {intel.package_version}</small>
      </div>
      <div className="guardian-dep-advisory">
        <span>{intel.advisory_id}</span>
        <small>{cves.slice(0, 2).join(', ') || 'OSV advisory'}</small>
      </div>
      <div className="guardian-dep-risk">
        <span className={`guardian-pill ${severityClass(intel.severity)}`}>{intel.severity}</span>
        {intel.known_exploited ? <span className="guardian-exploited">KEV {intel.exploited_at || ''}</span> : <span className="guardian-muted-pill">not KEV</span>}
      </div>
      <div className="guardian-dep-facts">
        <span><strong>EPSS</strong> {epss} {percentile}</span>
        <span><strong>Fix</strong> {fixed.length > 0 ? fixed.slice(0, 2).join(', ') : 'unknown'}</span>
        {dates.published ? <span><strong>Published</strong> {dates.published}</span> : null}
        {dates.modified ? <span><strong>Updated</strong> {dates.modified}</span> : null}
      </div>
      <p className="guardian-dep-summary">{displayText(intel.summary, 220)}</p>
      <div className="guardian-dep-actions">
        {refs[0] ? <a className="guardian-dep-link" href={refs[0]} target="_blank" rel="noreferrer">source</a> : null}
        <span className={`guardian-publish guardian-publish-${status.className}`} title={status.title}>{status.label}</span>
      </div>
    </div>
  );
}

function PromptModal({
  prompt,
  onClose,
}: {
  prompt: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="guardian-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="guardian-modal" role="dialog" aria-modal="true" aria-label="Generated fix prompt" onClick={(e) => e.stopPropagation()}>
        <div className="guardian-modal-head">
          <div>
            <h2>Fix Prompt</h2>
            <p>Sanitized from open Guardian findings.</p>
          </div>
          <button className="guardian-icon-button" type="button" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <pre className="guardian-prompt">{prompt}</pre>
        <div className="guardian-modal-actions">
          <button
            type="button"
            className="guardian-button guardian-button-primary"
            onClick={() => {
              navigator.clipboard.writeText(prompt).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }).catch(() => {});
            }}
          >
            <Copy size={15} /> {copied ? 'Copied' : 'Copy Prompt'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GuardianView() {
  const openTab = useTabsStore((state) => state.openTab);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const [summary, setSummary] = useState<GuardianSummary | null>(null);
  const [events, setEvents] = useState<GuardianEvent[]>([]);
  const [findings, setFindings] = useState<GuardianFinding[]>([]);
  const [dependencyIntel, setDependencyIntel] = useState<GuardianDependencyIntel[]>([]);
  const [publicThreats, setPublicThreats] = useState<GuardianPublicThreat[]>([]);
  const [endorsingId, setEndorsingId] = useState<string | null>(null);
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [seedingThreats, setSeedingThreats] = useState(false);
  const [graphActive, setGraphActive] = useState(false);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  // Stable triples — only rebuild when identifiers or endorsement counts actually
  // change, not on every 5s poll that returns the same data (new array reference).
  const [stableTriples, setStableTriples] = useState<Array<{ subject: string; predicate: string; object: string }>>([]);
  const threatDataKeyRef = useRef('');
  const [threatTriplesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixPrompt, setFixPrompt] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [dependencyAuditMessage, setDependencyAuditMessage] = useState<string | null>(null);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [summaryRes, eventsRes, findingsRes, threatsRes] = await Promise.all([
        fetchGuardianSummary(),
        fetchGuardianEvents({ limit: 100 }),
        fetchGuardianFindings({ status: 'open', limit: 50 }),
        fetchGuardianThreats(50).catch(() => ({ threats: [] as GuardianPublicThreat[] })),
      ]);
      setSummary(summaryRes.summary);
      setDependencyIntel(summaryRes.dependencyIntel);
      setEvents(eventsRes.events);
      setFindings(findingsRes.findings);
      setPublicThreats(threatsRes.threats ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Derive graph triples — only recompute when content changes, not on every poll.
  // The key compares identifier + endorsement count so the graph freezes in place
  // during idle polling and only re-lays-out when something actually changed.
  useEffect(() => {
    if (publicThreats.length === 0) return;
    const key = publicThreats.map(t => `${t.identifier}:${t.endorsementCount}`).join('|');
    if (key === threatDataKeyRef.current) return;
    threatDataKeyRef.current = key;
    setStableTriples(buildThreatGraphTriples(publicThreats));
  }, [publicThreats]);
  const threatTriples = stableTriples;

  const handleFlagFalse = useCallback(async (identifier: string) => {
    setFlaggingId(identifier);
    try {
      await flagGuardianThreatFalsePositive(identifier);
      setFlaggedIds((prev) => new Set([...prev, identifier]));
    } catch (err) {
      setError(err instanceof Error ? `Flag failed: ${err.message}` : `Flag failed: ${String(err)}`);
    } finally {
      setFlaggingId(null);
    }
  }, []);

  const handleEndorse = useCallback(async (identifier: string) => {
    setEndorsingId(identifier);
    try {
      const res = await endorseGuardianThreat(identifier);
      setPublicThreats((prev) => prev.map((t) =>
        t.identifier === identifier ? { ...t, endorsementCount: res.endorsementCount } : t,
      ));
    } catch (err) {
      setError(err instanceof Error ? `Endorse failed: ${err.message}` : `Endorse failed: ${String(err)}`);
    } finally {
      setEndorsingId(null);
    }
  }, []);

  // Deactivate graph when clicking outside it or pressing Escape
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (graphContainerRef.current && !graphContainerRef.current.contains(e.target as Node)) {
        setGraphActive(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGraphActive(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 5_000);
    return () => clearInterval(iv);
  }, [load]);

  const protectedAgents = useMemo(() => {
    const seen = new Map<string, { framework: string; name: string; events: number; lastSeenAt: number }>();
    for (const agent of summary?.agents ?? []) seen.set(agent.framework, agent);
    for (const framework of ['hermes', 'openclaw']) {
      if (!seen.has(framework)) seen.set(framework, { framework, name: framework, events: 0, lastSeenAt: 0 });
    }
    return [...seen.values()].sort((a, b) => {
      const idx = (v: string) => (v === 'hermes' ? 0 : v === 'openclaw' ? 1 : 2);
      return idx(a.framework) - idx(b.framework) || b.lastSeenAt - a.lastSeenAt;
    });
  }, [summary?.agents]);

  const topSeverity = useMemo(() => {
    const by = summary?.bySeverity;
    if (!by) return 'info';
    return SEVERITY_ORDER.find((severity) => by[severity] > 0) ?? 'info';
  }, [summary]);

  const eventById = useMemo(() => {
    const map = new Map<string, GuardianEvent>();
    for (const event of events) map.set(event.id, event);
    return map;
  }, [events]);

  const openGraph = useCallback((graph: GuardianGraphSync) => {
    const graphId = graph.context_graph_id;
    setActiveProject(graphId);
    openTab({
      id: `project:${graphId}`,
      label: graphId,
      closable: true,
    });
  }, [openTab, setActiveProject]);

  const findingsByEventId = useMemo(() => {
    const map = new Map<string, GuardianFinding[]>();
    for (const finding of findings) {
      if (!finding.event_id) continue;
      const list = map.get(finding.event_id) ?? [];
      list.push(finding);
      map.set(finding.event_id, list);
    }
    return map;
  }, [findings]);

  if (loading) {
    return (
      <div className="guardian-view">
        <div className="guardian-loading">Loading Guardian audit...</div>
      </div>
    );
  }

  return (
    <div className="guardian-view">
      <div className="guardian-dot-field" aria-hidden="true" />
      <section className="guardian-hero">
        <div>
          <div className="guardian-kicker"><ShieldCheck size={15} /> Umanitek Guardian</div>
          <h1>Agent Audit</h1>
          <p className="guardian-hero-copy">Supervise local Hermes runs and review anything Guardian flags.</p>
        </div>
        <div className="guardian-actions">
          <button type="button" className="guardian-button" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'guardian-spin' : ''} /> Refresh
          </button>
          <button
            type="button"
            className="guardian-button"
            disabled={auditBusy}
            onClick={async () => {
              setAuditBusy(true);
              setError(null);
              setDependencyAuditMessage(null);
              try {
                const res = await runGuardianDependencyAudit();
                setDependencyAuditMessage(
                  res.dependencyIntel.length > 0
                    ? `Found ${res.dependencyIntel.length} vulnerable dependency advisories.`
                    : 'No pinned dependency installs found to audit yet.',
                );
                await load(true);
              } catch (err) {
                setError(err instanceof Error ? `Dependency audit failed: ${err.message}` : `Dependency audit failed: ${String(err)}`);
              } finally {
                setAuditBusy(false);
              }
            }}
          >
            <PackageSearch size={15} /> {auditBusy ? 'Auditing...' : 'Audit Dependencies'}
          </button>
          <button
            type="button"
            className="guardian-button guardian-button-primary"
            onClick={async () => {
              const res = await generateGuardianFixPrompt();
              setFixPrompt(res.prompt);
            }}
          >
            <Sparkles size={15} /> Generate Fix Prompt
          </button>
        </div>
      </section>

      {error && (
        <div className="guardian-error">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <section className="guardian-stats">
        <StatTile label="Open Findings" value={summary?.totals.openFindings ?? 0} detail={`${summary?.totals.criticalFindings ?? 0} critical`} icon={<AlertTriangle size={18} />} tone={topSeverity === 'critical' || topSeverity === 'high' ? 'danger' : 'neutral'} />
        <StatTile label="Agent Events" value={summary?.totals.events ?? 0} detail="Hermes and OpenClaw" icon={<Bot size={18} />} />
        <StatTile label="Sensitive Access" value={summary?.totals.sensitivePathFindings ?? 0} detail="outside normal workspace" icon={<FileWarning size={18} />} tone={(summary?.totals.sensitivePathFindings ?? 0) > 0 ? 'warn' : 'good'} />
        <StatTile label="Dependency Intel" value={summary?.totals.vulnerableDependencies ?? 0} detail="OSV, EPSS, KEV facts" icon={<DatabaseZap size={18} />} />
      </section>

      <section className="guardian-panel guardian-panel-threats">
        <div className="guardian-panel-head">
          <h2>Public Threat Graph</h2>
          <span>{publicThreats.length} threats</span>
        </div>

        {publicThreats.length === 0 ? (
          <div className="guardian-empty">
            <span>No public threats yet. Seed the curated set or wait for peer publishes.</span>
            <button
              type="button"
              className="guardian-button"
              disabled={seedingThreats}
              onClick={async () => {
                setSeedingThreats(true);
                try {
                  await seedGuardianThreats();
                  await load(true);
                } catch (err) {
                  setError(err instanceof Error ? `Seed failed: ${err.message}` : `Seed failed: ${String(err)}`);
                } finally {
                  setSeedingThreats(false);
                }
              }}
            >
              <Sparkles size={14} /> {seedingThreats ? 'Seeding...' : 'Seed curated threats'}
            </button>
          </div>
        ) : (
          <div className="guardian-threat-split">
            {/* Left: sidebar list with endorse */}
            <div className="guardian-threat-sidebar">
              {publicThreats.map((threat) => (
                <div key={threat.identifier} className="guardian-threat-sidebar-row">
                  <div className="guardian-threat-sidebar-head">
                    <span className={`guardian-pill ${severityClass(threat.severity)}`}>{threat.severity}</span>
                  </div>
                  <div className="guardian-threat-sidebar-title">{threat.title}</div>
                  <div className="guardian-row-meta" style={{ marginTop: 2 }}>
                    <span>{threat.type}</span>
                  </div>
                  <div className="guardian-threat-actions">
                    <button
                      type="button"
                      className="guardian-button guardian-threat-endorse-btn"
                      disabled={endorsingId === threat.identifier}
                      onClick={() => handleEndorse(threat.identifier)}
                      title="Corroborate this threat"
                    >
                      <CheckCircle2 size={14} />
                      {threat.endorsementCount > 0 && <span>{threat.endorsementCount}</span>}
                      <span>{endorsingId === threat.identifier ? 'endorsing...' : 'endorse'}</span>
                    </button>
                    <button
                      type="button"
                      className={`guardian-button guardian-threat-false-btn${flaggedIds.has(threat.identifier) ? ' guardian-threat-false-flagged' : ''}`}
                      title={flaggedIds.has(threat.identifier) ? 'Flagged as false positive' : 'Flag as false positive'}
                      disabled={flaggingId === threat.identifier || flaggedIds.has(threat.identifier)}
                      onClick={() => handleFlagFalse(threat.identifier)}
                    >
                      <Flag size={14} />
                      <span>{flaggingId === threat.identifier ? 'flagging...' : flaggedIds.has(threat.identifier) ? 'flagged' : 'false'}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Right: DKG knowledge graph */}
            <div
              ref={graphContainerRef}
              className={`guardian-threat-graph-canvas${graphActive ? ' guardian-graph-active' : ''}`}
              onClick={() => setGraphActive(true)}
            >
              {!graphActive && (
                <div className="guardian-graph-overlay" aria-hidden="true">
                  <span>Click to pan &amp; zoom</span>
                </div>
              )}
              <div style={{ width: '100%', height: '100%', pointerEvents: graphActive ? 'auto' : 'none' }}>
              {threatTriplesLoading ? (
                <div className="guardian-graph-placeholder">
                  <Network size={32} style={{ opacity: 0.3 }} />
                  <span>Loading graph...</span>
                </div>
              ) : threatTriples.length === 0 ? (
                <div className="guardian-graph-placeholder">
                  <Network size={32} style={{ opacity: 0.2 }} />
                  <span>Graph data loading...</span>
                </div>
              ) : (
                <Suspense fallback={<div className="guardian-graph-placeholder"><Network size={32} style={{ opacity: 0.3 }} /><span>Loading renderer...</span></div>}>
                  <RdfGraph
                    data={threatTriples}
                    format="triples"
                    options={THREAT_GRAPH_OPTIONS}
                    viewConfig={THREAT_GRAPH_VIEW_CONFIG}
                    style={{ width: '100%', height: '100%' }}
                    initialFit
                  />
                </Suspense>
              )}
              </div>{/* end pointer-events wrapper */}
            </div>{/* end graph-canvas */}

          </div>
        )}
      </section>

      <section className="guardian-grid guardian-grid-top">
        <div className="guardian-panel guardian-panel-deps">
          <div className="guardian-panel-head">
            <h2>Dependency Intelligence</h2>
            <span>{dependencyIntel.length} advisories</span>
          </div>
          {dependencyAuditMessage && <div className="guardian-inline-note">{dependencyAuditMessage}</div>}
          {dependencyIntel.length === 0 ? (
            <div className="guardian-empty">No vulnerable dependency intelligence recorded. Run a pinned install such as npm install lodash@4.17.20, then audit dependencies.</div>
          ) : (
            <div className="guardian-dep-table">
              {dependencyIntel.map((intel) => <DependencyRow key={intel.id} intel={intel} />)}
            </div>
          )}
        </div>

        <div className="guardian-panel guardian-panel-agents">
          <div className="guardian-panel-head">
            <h2>Protected Agents</h2>
          </div>
          <div className="guardian-agent-list">
            {protectedAgents.map((agent) => (
              <div key={agent.framework} className="guardian-agent-row">
                <div className="guardian-agent-icon"><Bot size={16} /></div>
                <div>
                  <div className="guardian-agent-name">
                    <span>{agent.framework}</span>
                    <em className={`guardian-agent-state ${agent.events > 0 ? (Date.now() - agent.lastSeenAt < 120_000 ? 'active' : 'seen') : 'offline'}`}>
                      {agent.events > 0 ? (Date.now() - agent.lastSeenAt < 120_000 ? 'active' : 'seen') : 'not connected'}
                    </em>
                  </div>
                  <small>{agent.events} events - {timeAgo(agent.lastSeenAt)}</small>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="guardian-panel guardian-panel-graphs">
          <div className="guardian-panel-head">
            <h2>Graphs</h2>
          </div>
          {(summary?.graphs.length ?? 0) === 0 ? (
            <div className="guardian-empty">No graph writes recorded.</div>
          ) : (
            <div className="guardian-list">
              {summary?.graphs.map((graph) => <GraphStatus key={graph.id} graph={graph} onOpen={openGraph} />)}
            </div>
          )}
        </div>
      </section>

      <section className="guardian-grid guardian-grid-audit">
        <div className="guardian-panel guardian-panel-events">
          <div className="guardian-panel-head">
            <h2>Live Audit</h2>
            <span>{events.length} recent</span>
          </div>
          {events.length === 0 ? (
            <div className="guardian-empty">No Guardian events received yet. Start a supervised Hermes run to populate this feed.</div>
          ) : (
            <div className="guardian-list">
              {events.map((event) => <EventRow key={event.id} event={event} findings={findingsByEventId.get(event.id)} />)}
            </div>
          )}
        </div>

        <div className="guardian-panel guardian-panel-findings">
          <div className="guardian-panel-head">
            <h2>Findings</h2>
            <span>{findings.length} open</span>
          </div>
          {findings.length === 0 ? (
            <div className="guardian-empty guardian-empty-good">
              <CheckCircle2 size={18} />
              Audit is receiving events, but no open rule findings matched yet.
            </div>
          ) : (
            <div className="guardian-list">
              {findings.map((finding) => <FindingRow key={finding.id} finding={finding} event={finding.event_id ? eventById.get(finding.event_id) : undefined} />)}
            </div>
          )}
        </div>
      </section>

      {fixPrompt && <PromptModal prompt={fixPrompt} onClose={() => setFixPrompt(null)} />}
    </div>
  );
}
