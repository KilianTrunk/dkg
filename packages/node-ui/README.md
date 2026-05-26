# @origintrail-official/dkg-node-ui

Web dashboard for DKG V10 nodes. Provides a browser-based UI for monitoring node health, exploring the knowledge graph, running SPARQL queries, and chatting with integrated agents.

## Features

- **Guardian audit dashboard** - live local-agent audit view for Hermes and OpenClaw, backed by real daemon APIs and SQLite storage
- **Dashboard** - real-time node metrics (peers, KAs published, queries served, uptime)
- **Knowledge Explorer** - browse and search Knowledge Assets with interactive graph visualization (powered by `@origintrail-official/dkg-graph-viz`)
- **SPARQL editor** - write and execute SPARQL queries with syntax highlighting and result tables
- **Integrated-agent side panel** - connect a local agent, chat in the right rail, inspect network peers, and browse persisted sessions
- **Metrics & telemetry** - `DashboardDB` (SQLite) for persistent metric snapshots, `MetricsCollector` for gauges and counters, `OperationTracker` for request tracing
- **Structured logging** - `StructuredLogger` with operation context, log levels, and JSON output

## Guardian Audit

Guardian is the default DKG UI screen in the Umanitek agent-guardian build. It
turns local agent activity into a live audit queue while preserving the
existing DKG dashboard and graph tools.

The first supported integrations are Hermes and OpenClaw:

- Hermes emits normalized events from plugin hooks for tool calls, model API
  requests/responses, and session lifecycle markers.
- OpenClaw emits normalized chat/session/tool metadata through the DKG adapter.
- The daemon stores events and findings in SQLite, enriches vulnerable
  dependency findings, and writes graph assertions best-effort.

### API Routes

| Route | Purpose |
|---|---|
| `POST /api/guardian/events` | Ingest one normalized audit event and generate findings. |
| `GET /api/guardian/events` | List stored events with optional filters. |
| `GET /api/guardian/findings` | List open or filtered findings. |
| `GET /api/guardian/summary` | Return dashboard counters, agent status, graph sync status, and dependency intel. |
| `POST /api/guardian/audit/dependencies` | Enrich package/version components through OSV, CISA KEV, NVD, and FIRST EPSS. |
| `POST /api/guardian/fix-prompt` | Build a sanitized remediation prompt from open findings. |

### Storage

Guardian data is stored in `DashboardDB` using schema version 15:

- `guardian_events`
- `guardian_findings`
- `guardian_dependency_intel`
- `guardian_graph_sync`

Events and findings use deterministic IDs so retrying an ingest does not
duplicate records. `guardian_events` follows the dashboard retention policy.

### Analysis

The shared `guardian.ts` module is the source of truth for event normalization,
redaction, finding generation, install-command parsing, graph payload builders,
and fix-prompt generation. It detects:

- OWASP LLM01-style prompt-injection strings
- sensitive filesystem access such as `~/Documents`, `~/Desktop`,
  `~/Downloads`, `~/.ssh`, cloud credentials, browser profiles, and system
  paths
- dependency installs from common package managers
- remote scripts piped into interpreters
- dependency vulnerability records from public advisory feeds

### Graph Privacy Split

Guardian writes two graph classes:

- Private local audit graph: `guardian-local-audit`
- Public vulnerability intelligence graph: `guardian-vulnerability-intel`

The public graph is restricted to reusable dependency intelligence: package,
version, advisory IDs, CVE/GHSA/OSV IDs, fixed versions, known-exploited status,
EPSS values, references, and timestamps. Local paths, prompts, usernames, raw
tool arguments, secrets, and machine identifiers must not be published there.

Graph writes are best-effort. Failures are recorded in `guardian_graph_sync`
and do not fail event ingest.

### UI Contract

The Guardian view calls only real daemon APIs. There is no mock data path.
Empty states, API errors, dependency intelligence, protected-agent status, and
the fix-prompt modal all derive from live responses.

## Architecture

The package has two sides:

1. **Server-side** (exported as a library) - `handleNodeUIRequest()` serves the built UI assets and API endpoints; `DashboardDB`, `MetricsCollector`, and `OperationTracker` provide telemetry infrastructure
2. **Client-side** (Vite/React app) - the dashboard UI, built separately via `pnpm build:ui`

## Usage

```typescript
import { handleNodeUIRequest, initTelemetry } from '@origintrail-official/dkg-node-ui';

// In the daemon's HTTP server
if (url.startsWith('/ui')) {
  return handleNodeUIRequest(req, res);
}
```

## Development

```bash
# Start the UI dev server (hot reload)
pnpm dev:ui

# Build the production UI bundle
pnpm build:ui

# Build the full package from this workspace (server + UI)
pnpm build:full

# Build all packages and the Node UI bundle from the repo root
pnpm build
```

## Internal Dependencies

- `@origintrail-official/dkg-core` - configuration types, event bus integration
- `@origintrail-official/dkg-graph-viz` - interactive RDF graph visualization component
