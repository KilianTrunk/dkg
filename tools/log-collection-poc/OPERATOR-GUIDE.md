# Forwarding your DKG node logs (opt-in)

Every DKG node keeps full local logs by default (SQLite + `~/.dkg/daemon.log`).
If you *also* want to forward them to your own log backend (or an
OriginTrail-provided collector), enable the OTLP exporter. **Forwarding is off
until you turn it on**, and secrets (wallet keys, mnemonics, tokens) are
redacted on the node before anything is sent.

## Enable it
Add to your `config.json`:

```json
"name": "my-node-01",
"telemetry": {
  "enabled": true,
  "logs": {
    "exporter": "otlp",
    "endpoint": "https://<your-collector>/v1/logs",
    "token": "<optional-bearer-token>",
    "level": "info"
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Your node's name — becomes the `service_instance_id` label, i.e. how you pick this node in Grafana. Use a unique value. |
| `telemetry.enabled` | Master switch. `false` (default) = nothing leaves the node. |
| `logs.exporter` | `otlp` (recommended), `syslog` (legacy Graylog), or `none` (local only). |
| `logs.endpoint` | Your OTLP/HTTP logs URL (an OpenTelemetry Collector, Grafana Alloy, or Loki ≥3.0 `/otlp/v1/logs`). |
| `logs.token` | Optional bearer token sent as `Authorization: Bearer …`. |
| `logs.level` | Minimum level forwarded (`debug`/`info`/`warn`/`error`). Default `info` — `debug` stays local. |
| `logs.redact` | Extra sensitive key names to scrub from messages, on top of the built-in set. |

Restart the node. It now pushes redacted, structured logs to your collector;
local logging is unchanged. The exporter is non-blocking and buffered — if your
collector is down, the node keeps running and logs are dropped-oldest, never
queued unboundedly.

## What gets sent
- **Resource labels:** `service.name=dkg-node`, `service.instance.id=<name>`, `deployment.environment=<network>`, `dkg.node_role`.
- **Per-record attributes:** `dkg.operation_id`, `dkg.operation_name`, `dkg.source_operation_id`, `dkg.module`, severity.
- **Body:** the log message, with secrets already redacted.

## Viewing
Point Grafana at your log store and import `production/grafana-dashboard-dkg-node-logs.json`
(per-node) and/or `production/grafana-dashboard-dkg-fleet-logs.json` (fleet),
then pick your node and a time range. If your store is Loki < 3.0, front it with
Grafana Alloy (see `production/RUNBOOK.md`).
