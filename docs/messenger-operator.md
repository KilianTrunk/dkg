# Universal Messenger — Operator Guide

> Status: skeleton landed in rc.9 PR-7. Full `/api/slo` reference + dashboard reading guide land in PR-12. Cross-cutting coherence pass in PR-13.

This is the operator-facing manual for running a DKG node on top of the Universal Messenger substrate. If you're trying to understand how the substrate works internally, read [`messenger.md`](./messenger.md). If you're adding a new protocol, read [`messenger-add-protocol.md`](./messenger-add-protocol.md).

## What you actually need to know

Most operators won't need any of this — the substrate is configured safely by default and the public testnet relay set is enough for reliable chat / skill / query traffic. The two surfaces you'll touch are:

1. **`--relay-preferred`** (PR-7) — when you stand up your own relay infrastructure, point your node at it first.
2. **`/api/slo`** (PR-12, coming) — per-protocol latency + delivery rate histograms exposed on localhost; the source-of-truth for "is messaging healthy".

## `--relay-preferred` — using operator-controlled relays

By default, every daemon reserves on the public testnet relay set (declared in `network/<env>.json#relays`). The public relays work well, but operators running their own infrastructure may want to prioritise relays they control — for capacity, geography, or operational independence.

### CLI flag

```bash
dkg start \
  --relay-preferred /ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne... \
  --relay-preferred /dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo...
```

Repeatable. Each `--relay-preferred` adds one multiaddr; the order you pass them is the order libp2p attempts reservations. The public testnet relays remain configured as fallback — if your operator-relay disappears, the node keeps working through the public set.

### Persistent config

For a node you run continuously, write the same list into `~/.dkg/config.json`:

```jsonc
{
  "name": "...",
  "preferredRelays": [
    "/ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne...",
    "/dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo..."
  ]
  // ... other config
}
```

CLI-flag entries take precedence over config entries; both are deduped (first-seen order) before being prepended to the network relay list.

### Verifying

After restart, the daemon logs:

```
Preferred relays (rc.9 PR-7): 2 operator-supplied multiaddr(s) prepended (sources: 2 from --relay-preferred, 0 from config.preferredRelays). Effective relayPeers count: 5.
```

You can also confirm via `/api/peer-info` (rc.9 #533) which reservations the libp2p stack is currently holding.

## Relay-setup playbook (standing up your own relay)

You'll get the most reliability lift from running 2-3 relays in geographically distinct regions. Each relay is a vanilla DKG node configured as a circuit-relay-v2 server. The full step-by-step lives in [`packages/cli/README.md`](../packages/cli/README.md#operator-relays-rc9-pr-7) — that's the authoritative playbook with infra recommendations, port-forwarding rules, and monitoring.

In summary:

1. **Provision a small cloud VM** (1 vCPU, 1 GiB RAM, 20 GiB disk is plenty for relay-only). Public IP + ports 4001/tcp open.
2. **Install + init DKG** as you would for any other node.
3. **Set `nodeRole: "core"` + `enableRelayServer: true`** in `config.json` so libp2p flips into relay-server mode (HOP streams + reservations).
4. **Capture the relay's multiaddr** from the startup log: `/ip4/<public-ip>/tcp/4001/p2p/<peer-id>` — this is what you share with your other nodes' `--relay-preferred`.
5. **Wire it up** on every node that should prefer your relay:

   ```bash
   dkg start --relay-preferred /ip4/<public-ip>/tcp/4001/p2p/<peer-id>
   ```

6. **Monitor** — the relay exposes the same `/api/peer-info` diagnostic, so a simple HTTP probe + a "reservations > 0" alert tells you if it's healthy.

## What's coming

- **`/api/slo`** (PR-12) — per-protocol p50/p95/p99 latency + delivered/queued counts. Localhost-only by default; this guide will explain how to read it and how to wire it into your dashboard via a reverse proxy.
- **Cross-cutting coherence pass** (PR-13) — sequence diagrams polished into `messenger.md`, changelog notes, broken-link check.

## Debugging a stuck outbox entry

```bash
sqlite3 ~/.dkg/dashboard.db "SELECT peer_id, protocol, message_id, attempts, last_error \
  FROM protocol_outbox \
  ORDER BY last_attempt_at DESC \
  LIMIT 20;"
```

Or via the dashboard UI (`/ui/chat`) for chat-specific entries.

If you see entries with `attempts >= 5` and `last_error LIKE '%no valid addresses%'`, the daemon is already retrying via the DHT-walk recovery primitive (PR-5) and the entry will heal as soon as the peer's reservations get re-discovered. If `attempts` keeps climbing past 10 with the same error, the peer may be genuinely unreachable — check your own internet connectivity (the soak data so far suggests "no valid addresses" tails are often correlated with sender-side network blips, not receiver-side outages).
