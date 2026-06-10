# Upgrading to `v10.0.0-rc.17` — land it clean

**Audience:** DKG **node operators** (edge + core) on V10 Testnet (Base
Sepolia) upgrading from any pre-rc.17 build (rc.12 → rc.16), plus anyone
spinning up a node for the first time on rc.17.

**Compatibility posture:** rc.17 ships the **per-KA memory model** — a new,
uniform per-Knowledge-Asset named-graph layout in the local RDF store. This
is an **off-chain breaking change**. It is **not** a contract redeploy, so it
does **not** bump `chainResetMarker`, which means the daemon's automatic
chain-reset wipe **does not fire** on this upgrade, and **there is no
boot-time layout migration**. A node that simply auto-updates rc.16 → rc.17
keeps its old data in the *old* layout while writing all new data in the
*new* layout — a split-brain store with only partial read-both coverage.

**Bottom line:** to land rc.17 cleanly you do a **one-time local store wipe**
when you take the upgrade. The chain is untouched; your wallet/identity and
on-chain assets are preserved, and Verifiable Memory re-syncs. **One exception:**
local Working/Shared Memory you authored but never published is *not*
re-derivable — if you have any, export it first (**§5**) before you wipe.

> **New operators:** there is nothing to migrate — just install rc.17 fresh
> (see §4.1) and skip the rest.

---

## 0. Did this already happen to you? (for most operators — yes)

If your node **auto-updated** from rc.16 (or any pre-rc.17 build) to rc.17, it
is now running rc.17 code over old-layout data — the split-brain state above.
This hit essentially every node that had auto-update enabled. **Confirm in 30
seconds:**

```bash
# A) On rc.17, but the store still holds a large pre-upgrade quad count?
curl -s :9200/api/status | jq '{version, storeQuads}'
#    version 10.0.0-rc.17 + tens/hundreds of thousands of quads = strong signal

# B) Definitive — do OLD /assertion/ graphs still exist? Query your store's
#    SPARQL endpoint (oxigraph-server default shown; adjust host/port for your
#    backend):
curl -s -G http://127.0.0.1:7878/query -H 'Accept: text/csv' \
  --data-urlencode 'query=SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g),"/assertion/")) }'
```

- **Count > 0 — or you simply auto-updated in place (didn't fresh-install
  rc.17):** you're affected → do the one-time wipe in **§4.2**. Wallet,
  identity, and on-chain assets are safe.
- **Count = 0 and you fresh-installed rc.17:** already clean — nothing to do.

> **Why your node didn't self-heal:** rc.17 is an *off-chain* breaking change,
> so it does **not** bump `chainResetMarker` — the daemon's automatic
> chain-reset wipe never fired, and there is no boot-time migration. The wipe
> is manual, once. (See §8 for the durable fleet-wide fix.)
>
> **It can recur.** The in-place update happened because auto-update has
> prereleases enabled. To opt out of automatic RC updates, set
> `autoUpdate.allowPrerelease: false` in `~/.dkg/config.json` — your node then
> stays on its current build until you update manually and run this guide
> deliberately (stable releases still auto-update). Watch **#builders** for a
> heads-up on each off-chain-breaking RC.

---

## 1. TL;DR

| # | Area | Change | What it means for you |
|---|------|--------|------------------------|
| 1 | Local RDF layout | New uniform per-KA graphs: `…/_working_memory/{addr}/{n}`, `…/_shared_memory/…`, `…/_verifiable_memory/{addr}/{n}` | Old graphs (`…/assertion/{addr}/{name}`, SWM buckets, `…/_verifiable_memory/{vmId}`) are **not** rewritten |
| 2 | Migration | **None.** The planned boot-time layout migration is not implemented in rc.17 | In-place upgrade ⇒ mixed/old+new layout coexisting |
| 3 | Auto-wipe | `chainResetMarker` is **unchanged** (no chain redeploy) | The daemon will **not** wipe for you — you must wipe manually once |
| 4 | Failure mode | Node boots fine; no crash | Pre-rc.17 KAs may be **invisible / not served / not synced** under the new layout |
| 5 | HTTP API | `/api/assertion/*` → `/api/knowledge-assets/*` | Update any monitoring / scripts that hit the old route |
| 6 | Chain / wire | No contract redeploy; sync protocol unchanged (`/dkg/10.0.2/sync`) | No on-chain action; no fund/identity loss |

If you upgrade in place **without** the wipe, the node will run, but expect
stale-data visibility bugs. The clean path below avoids all of that.

---

## 2. Use this guide as an agent prompt

Point an AI agent at this doc and your node host:

```
You are upgrading a DKG node to @origintrail-official/dkg v10.0.0-rc.17.
Read docs/UPGRADE_TO_RC17.md end to end first. rc.17 is an OFF-CHAIN
breaking change (per-KA memory-model layout) with no automatic store wipe
and no layout migration, so the upgrade requires a one-time local store
wipe to land clean.

Do this, in order:
1. Confirm the node is affected and record state:
   `curl -s :9200/api/status | jq '{version, storeBackend}'` (`dkg status`
   shows the store but not the version). A node that auto-updated in place to
   rc.17 over pre-rc.17 data is affected (see §0); a fresh rc.17 install is not.
2. `dkg stop`.
3. Update to rc.17, pinned: `dkg update 10.0.0-rc.17` (or
   `npm install -g @origintrail-official/dkg@10.0.0-rc.17`). A bare `dkg update`
   is not deterministic — `autoUpdate.allowPrerelease: false` nodes may skip it.
4. Wipe the LOCAL store for the detected backend (see §4.2). Do NOT touch
   the keystore (wallets.json/agent-key*), auth.token, or config.json.
5. `dkg start`.
6. Verify: `dkg doctor`, `/api/status` shows version 10.0.0-rc.17, and a
   spot-check query returns post-upgrade data. Confirm logs show no
   leftover pre-rc.17 graph URIs being gossiped/dropped.

Report the backend you wiped and the verification output.
```

---

## 3. Why a wipe is needed (and why it's safe)

The pre-rc.17 quads reference the **old** graph URIs. rc.17 reads/writes the
**new** per-KA URIs. There is no migration that re-homes the old graphs, and
the fallback read-both paths only cover some query/sync routes — so leaving
the old data in place produces inconsistent visibility rather than a clean
cutover.

Wiping is safe because **everything dropped is re-derivable**:

- **Verifiable Memory** re-syncs from chain + peers after restart.
- Your **on-chain identity, stake, and KAs are on Base Sepolia** — untouched.
- The wipe preserves your **wallet keystore, `auth.token`, and `config.json`**.

The only thing genuinely lost is **local Working/Shared Memory you authored
but never published to Verifiable Memory.** If you have un-published local WM
you care about, export it first (see §5).

---

## 4. The clean upgrade

### 4.1 Fresh install (new operators, or "I don't care about local data")

```bash
npm install -g @origintrail-official/dkg@10.0.0-rc.17
dkg init        # if not yet configured
dkg start
```

That's it — a fresh node is already on the new layout.

### 4.2 Existing node — upgrade + one-time wipe

**Step 0 — detect your store backend** (the wipe differs per backend):

```bash
curl -s :9200/api/status | jq '{version, storeBackend}'   # `dkg status` shows the store but not the version
```

**Step 1 — stop + update:**

```bash
dkg stop
dkg update 10.0.0-rc.17     # or: npm install -g @origintrail-official/dkg@10.0.0-rc.17
```

**Step 2 — wipe the local store for your backend.** In all cases also remove
the file-side state so journals/WAL/marker can't reference stale data:

```bash
NODE_DATA_DIR="${DKG_HOME:-$HOME/.dkg}"
# fixed-name file-side state
rm -f \
  "$NODE_DATA_DIR/store.nq" \
  "$NODE_DATA_DIR/store.nq.tmp" \
  "$NODE_DATA_DIR/random-sampling.wal" \
  "$NODE_DATA_DIR/.network-state.json"
# publish journals via `find` so it's glob-safe — a bare `publish-journal.*`
# aborts the whole command under zsh's nomatch when no journals exist:
find "$NODE_DATA_DIR" -maxdepth 1 -name 'publish-journal.*' -delete 2>/dev/null
```

Then clear the RDF store itself:

- **`oxigraph-worker` (the default — what `/api/status` reports when there is
  no `store` block in `config.json`), plus `oxigraph` / `oxigraph-persistent`:**
  nothing more to do — these persist to `store.nq`, already removed above.

- **`oxigraph-server` (DKG-managed local server):** the data is a local
  RocksDB at `$NODE_DATA_DIR/oxigraph-data`, **not** `store.nq`. With the
  daemon stopped, drop the RocksDB directory:

  ```bash
  rm -rf "$NODE_DATA_DIR/oxigraph-data"
  ```

  (Equivalent if you prefer to keep the server running: issue a SPARQL
  `DROP ALL` against its update endpoint —
  `curl -s -X POST http://127.0.0.1:7878/update --data-urlencode 'update=DROP ALL'`.)

- **`sparql-http` / `blazegraph` (operator-provided endpoint):** the daemon
  shares this instance, so clear only the V10 graphs (don't nuke unrelated
  data):

  ```sparql
  # against your update endpoint
  DELETE { GRAPH ?g { ?s ?p ?o } }
  WHERE  { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:")) }
  ```

  If the namespace is dedicated to this node, `DROP ALL` is simpler.

**Step 3 — start + verify:**

```bash
dkg start
dkg doctor
curl -s :9200/api/status | jq '{version, storeBackend, storeQuads}'
```

Expect `version: "10.0.0-rc.17"` and a `storeQuads` count that starts low and
grows as VM re-syncs.

---

## 5. (Optional) preserve un-published local data first

If you have local Working/Shared Memory you authored and have **not**
published to Verifiable Memory, export it before wiping:

```bash
# IMPORTANT: a SPARQL `CONSTRUCT { ?s ?p ?o }` FLATTENS every named graph into
# the default graph — it loses the WM/SWM/VM graph URIs and is NOT a usable
# backup. Use a dataset-level N-Quads export per backend:

# oxigraph-worker / oxigraph (default, embedded): the store IS already an
# N-Quads file — just copy it:
cp "${DKG_HOME:-$HOME/.dkg}/store.nq" ~/dkg-prewipe-backup.nq

# oxigraph-server (managed): dump the whole dataset via the /store endpoint —
# this preserves graph names (note `/store`, NOT `/query`):
curl -s 'http://127.0.0.1:7878/store' -H 'Accept: application/n-quads' \
  > ~/dkg-prewipe-backup.nq

# sparql-http / blazegraph: use the backend's native dataset export — the SPARQL
# Graph Store Protocol (GET each graph) or the server's dump endpoint. A
# CONSTRUCT will drop the graph names.
```

Anything already in Verifiable Memory does **not** need backing up — it
re-syncs from chain/peers.

---

## 6. What's preserved vs reset

| Preserved | Reset |
|---|---|
| Wallet keystore (`wallets.json` / `agent-key*` / `agent-keystore.json`) — same key, same identity | Local RDF store (all pre-rc.17 quads) |
| `auth.token` (local API token) | `publish-journal.*`, `random-sampling.wal` |
| `config.json` (your preferences, incl. `store.backend`) | `.network-state.json` (re-derived on boot) |
| On-chain identity, stake, published KAs (Base Sepolia) | Un-published local WM/SWM (back up first if needed) |

---

## 7. Verification checklist

- [ ] `/api/status` reports `version: 10.0.0-rc.17`.
- [ ] `dkg doctor` is green.
- [ ] `storeQuads` started near zero post-wipe and is climbing (VM re-sync).
- [ ] A spot-check SPARQL query returns assertions created **after** the
      upgrade in the new per-KA layout.
- [ ] No old `…/assertion/{addr}/{name}` or bare-bucket SWM graphs linger
      (`SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g),"/assertion/")) }` returns 0).
- [ ] Daemon logs show no repeated "validation failed / dropping" churn from
      stale gossiped entries.

---

## 8. Maintainer note (the durable fix)

This manual wipe is the **interim** operator path. The clean, fleet-wide
options are either of:

1. **Bump `chainResetMarker`** in `network/testnet.json` on the rc.17
   release. Phase C of [`TESTNET_RESET.md`](TESTNET_RESET.md) then fires the
   existing auto-wipe on every node at upgrade (including `DROP ALL` on
   managed `oxigraph-server`), and operators do nothing. Caveat: the marker
   semantically tracks *chain* resets; reusing it for an off-chain layout
   break is a slight abuse but mechanically correct.
2. **Ship the planned per-KA layout migration** (the "D3d / chorusLayout"
   step described in `docs/rc17-chorus-implementation.md`) so existing
   stores are re-homed in place with no wipe.

Until one of those lands and is documented in `CHANGELOG.md` under an
`[10.0.0-rc.17]` section, operators should follow §4 above.

---

## 9. Where to get help

- **Per-KA memory-model design:** [`docs/rc17-chorus-implementation.md`](rc17-chorus-implementation.md).
- **Reset mechanics (auto-wipe / chainResetMarker):** [`docs/TESTNET_RESET.md`](TESTNET_RESET.md).
- **API route rename:** [`docs/migrations/assertion-to-knowledge-assets.md`](migrations/assertion-to-knowledge-assets.md).
- **Prior breaking upgrade (for format reference):** [`docs/UPGRADE_RC11_TO_RC12.md`](UPGRADE_RC11_TO_RC12.md).
- **Discord** #builders / open an issue on [`OriginTrail/dkg`](https://github.com/OriginTrail/dkg/issues) tagged `rc.17-upgrade`.
