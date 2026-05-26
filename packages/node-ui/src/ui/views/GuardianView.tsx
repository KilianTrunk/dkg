import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  DatabaseZap,
  FileWarning,
  Globe2,
  KeyRound,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  fetchGuardianEvents,
  fetchGuardianFindings,
  fetchGuardianSummary,
  generateGuardianFixPrompt,
  runGuardianDependencyAudit,
  type GuardianDependencyIntel,
  type GuardianEvent,
  type GuardianFinding,
  type GuardianGraphSync,
  type GuardianSeverity,
  type GuardianSummary,
} from '../api.js';

const SEVERITY_ORDER: GuardianSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function severityClass(severity: string): string {
  return `guardian-severity-${severity || 'info'}`;
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

function GraphStatus({ graph }: { graph: GuardianGraphSync }) {
  return (
    <div className={`guardian-graph-row guardian-graph-${graph.status}`}>
      <div className="guardian-graph-icon">
        {graph.scope === 'public' ? <Globe2 size={16} /> : <KeyRound size={16} />}
      </div>
      <div className="guardian-graph-main">
        <span>{graph.context_graph_id}</span>
        <small>{graph.scope} graph</small>
      </div>
      <span className="guardian-graph-status">{graph.status}</span>
    </div>
  );
}

function EventRow({ event }: { event: GuardianEvent }) {
  return (
    <div className="guardian-event-row">
      <div className={`guardian-severity-dot ${severityClass(event.severity)}`} />
      <div className="guardian-row-main">
        <div className="guardian-row-title">{event.title}</div>
        <div className="guardian-row-meta">
          <span>{event.agent_framework}</span>
          <span>{event.tool_name || event.event_type}</span>
          <span>{timeAgo(event.ts)}</span>
        </div>
      </div>
      <span className={`guardian-pill ${severityClass(event.severity)}`}>{event.severity}</span>
    </div>
  );
}

function FindingRow({ finding }: { finding: GuardianFinding }) {
  return (
    <div className="guardian-finding-row">
      <div className="guardian-finding-head">
        <span className={`guardian-pill ${severityClass(finding.severity)}`}>{finding.severity}</span>
        <span className="guardian-finding-type">{finding.type.replace(/_/g, ' ')}</span>
      </div>
      <div className="guardian-finding-title">{finding.title}</div>
      <p>{finding.summary}</p>
      <div className="guardian-finding-rec">{finding.recommendation}</div>
    </div>
  );
}

function DependencyRow({ intel }: { intel: GuardianDependencyIntel }) {
  const cves = parseJsonArray(intel.cve_ids_json);
  const fixed = parseJsonArray(intel.fixed_versions_json);
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
        {intel.known_exploited ? <span className="guardian-exploited">exploited {intel.exploited_at || ''}</span> : null}
      </div>
      <div className="guardian-dep-extra">
        {intel.epss_score != null ? <span>EPSS {(intel.epss_score * 100).toFixed(1)}%</span> : <span>EPSS pending</span>}
        {fixed.length > 0 ? <span>fix {fixed.slice(0, 2).join(', ')}</span> : <span>fix unknown</span>}
      </div>
      <span className={`guardian-publish guardian-publish-${intel.publish_status}`}>{intel.publish_status}</span>
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
          <button className="guardian-icon-button" type="button" onClick={onClose} aria-label="Close">x</button>
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
  const [summary, setSummary] = useState<GuardianSummary | null>(null);
  const [events, setEvents] = useState<GuardianEvent[]>([]);
  const [findings, setFindings] = useState<GuardianFinding[]>([]);
  const [dependencyIntel, setDependencyIntel] = useState<GuardianDependencyIntel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixPrompt, setFixPrompt] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [summaryRes, eventsRes, findingsRes] = await Promise.all([
        fetchGuardianSummary(),
        fetchGuardianEvents({ limit: 50 }),
        fetchGuardianFindings({ status: 'open', limit: 50 }),
      ]);
      setSummary(summaryRes.summary);
      setDependencyIntel(summaryRes.dependencyIntel);
      setEvents(eventsRes.events);
      setFindings(findingsRes.findings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
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
              try {
                await runGuardianDependencyAudit();
                await load(true);
              } finally {
                setAuditBusy(false);
              }
            }}
          >
            <PackageSearch size={15} /> Audit Dependencies
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
        <StatTile label="Dependency Intel" value={summary?.totals.vulnerableDependencies ?? 0} detail="public-safe graph facts" icon={<DatabaseZap size={18} />} />
      </section>

      <section className="guardian-grid">
        <div className="guardian-panel guardian-panel-wide">
          <div className="guardian-panel-head">
            <h2>Findings</h2>
            <span>{findings.length} open</span>
          </div>
          {findings.length === 0 ? (
            <div className="guardian-empty"><CheckCircle2 size={18} /> No open findings.</div>
          ) : (
            <div className="guardian-list">
              {findings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
            </div>
          )}
        </div>

        <div className="guardian-panel">
          <div className="guardian-panel-head">
            <h2>Protected Agents</h2>
          </div>
          <div className="guardian-agent-list">
            {protectedAgents.map((agent) => (
              <div key={agent.framework} className="guardian-agent-row">
                <div className="guardian-agent-icon"><Bot size={16} /></div>
                <div>
                  <span>{agent.framework}</span>
                  <small>{agent.events} events - {timeAgo(agent.lastSeenAt)}</small>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="guardian-panel">
          <div className="guardian-panel-head">
            <h2>Graphs</h2>
          </div>
          {(summary?.graphs.length ?? 0) === 0 ? (
            <div className="guardian-empty">No graph writes recorded.</div>
          ) : (
            <div className="guardian-list">
              {summary?.graphs.map((graph) => <GraphStatus key={graph.id} graph={graph} />)}
            </div>
          )}
        </div>

        <div className="guardian-panel guardian-panel-wide">
          <div className="guardian-panel-head">
            <h2>Live Audit</h2>
            <span>{events.length} recent</span>
          </div>
          {events.length === 0 ? (
            <div className="guardian-empty">No Guardian events received yet.</div>
          ) : (
            <div className="guardian-list">
              {events.map((event) => <EventRow key={event.id} event={event} />)}
            </div>
          )}
        </div>

        <div className="guardian-panel guardian-panel-wide">
          <div className="guardian-panel-head">
            <h2>Dependency Intelligence</h2>
            <span>{dependencyIntel.length} advisories</span>
          </div>
          {dependencyIntel.length === 0 ? (
            <div className="guardian-empty">No vulnerable dependency intelligence recorded.</div>
          ) : (
            <div className="guardian-dep-table">
              {dependencyIntel.map((intel) => <DependencyRow key={intel.id} intel={intel} />)}
            </div>
          )}
        </div>
      </section>

      {fixPrompt && <PromptModal prompt={fixPrompt} onClose={() => setFixPrompt(null)} />}
    </div>
  );
}
