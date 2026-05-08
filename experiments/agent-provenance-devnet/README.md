# Agent-provenance devnet validation runbook

End-to-end validation for the agent-provenance work shipped in PR #436
(`feat/agent-provenance-onchain-attestation`). Walks an operator
through standing up a 5-node devnet (4 core + 1 edge), exercising the
four operating modes from the spec §4, and capturing the artefacts
the §9.7 cross-cutting checklist needs as evidence.

The intent is to give a human operator a concrete, copy-paste-able
sequence per mode, including:

- **Setup** — what fixtures (PCAs, `authorizedKeys`, identities) the
  mode requires before any `publish` call.
- **Action** — the actual `dkg publish` (or HTTP) call.
- **Assertions** — the on-chain reads + log checks that ratify the
  mode succeeded with the right authorship / attribution / payment
  shape.

The four modes are taken verbatim from the spec §4 and §9.5; the
acceptance criteria in §9.7 #1, #6-#9 are folded into the per-mode
"assertions" sections.

## Bring-up

The repo already ships a Hardhat-based devnet. Re-using it.

```bash
# from repo root
./scripts/devnet.sh clean        # wipe any prior state
./scripts/devnet.sh start 5      # 4 core + 1 edge (the "edge" is just
                                 # node5 with hostingNodes=[] later)
./scripts/devnet.sh status       # confirm 5 daemons + hardhat are up
```

Note on edge vs core: the daemons are identical binaries; what
makes a daemon "edge" in the spec sense is having an empty
`hostingNodes` set on its CG. The Phase 1 contract change
(`ContextGraphStorage.sol` — drop the `hostingNodes.length == 0`
revert) is what unblocks this. In the runbook we treat **node5** as
the edge.

After bring-up, sanity-check the agent-provenance contract changes
landed in the deployed bytecode:

```bash
node scripts/verify-agent-provenance-deployment.mjs
```

(see `scripts/verify-agent-provenance-deployment.mjs` below — it
replays the Phase 5 acceptance ABI checks against the `localhost`
deployment.)

## Per-mode recipes

Each mode produces a transcript at
`experiments/agent-provenance-devnet/<mode>.transcript.md`. The
transcript template is `transcript.template.md`; copy it, fill in
the holes from the daemon log + on-chain reads.

### (a) Self-publishing edge attributed to home core (PCA path)

> **Spec §4(a) / §9.5(a):** Edge wallet on core 1's PCA
> `authorizedKeys`. Edge publishes; core 1's PCA discount applies;
> on-chain `author = edge.agent`, `publisherNodeIdentityId = core1.id`,
> `publisherAddress = edge.publisher`.

```bash
# Fixture (one-time)
NODE_DIR=.devnet/node1 ./scripts/dkg pca create --epochs 12 --tokens 100000
NODE_DIR=.devnet/node1 ./scripts/dkg pca authorize <edge_publisher_address>

# Action
NODE_DIR=.devnet/node5 ./scripts/dkg publish <cgId> \
  --file experiments/agent-provenance-devnet/turns/turn-a.nq \
  --publisher-node-identity-id <core1_id>
```

**Assertions** (capture into the transcript):

- `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kcId) ==
  edge.agent.wallet.address` (matches §9.7 #1).
- `getLatestMerkleRootPublisher(kcId) == edge.publisher` (the EOA
  that called `publish`, i.e. `msg.sender`).
- `KnowledgeCollectionCreated(kcId, indexed author=edge.agent, ...)`
  log entry present in the receipt.
- Core 1's PCA epoch allowance decremented by ≥ the discounted fee
  (read via `PublishingConvictionAccount.epochAllowance`).
- `dkg:Publication` triple present in CG meta graph: `<urn:dkg:kc:N>
  dkg:authoredBy "<edge.agent.wallet.address>"`.
- `/api/kc/<kcId>/author` returns `{author: <edge.agent.address>,
  attested: true}`.

### (b) Publisher-as-a-service via core 2 PCA

> **Spec §4(b) / §9.5(b):** Core 2 runs a publisher service; its
> submitter EOA is on its OWN PCA `authorizedKeys`; agents on
> devnet route publishes through it. `author = end-user.agent`,
> `publisherNodeIdentityId = core2.id`, `publisherAddress =
> core2.publisher`.

```bash
# Fixture (one-time)
NODE_DIR=.devnet/node2 ./scripts/dkg pca create --epochs 12 --tokens 200000
NODE_DIR=.devnet/node2 ./scripts/dkg pca authorize <core2_publisher_address>

# Action — end-user agent submits a signed turn to core 2's HTTP API,
# core 2 forwards as the publisher.
curl -s http://127.0.0.1:9202/api/openclaw-channel/persist-turn \
  -H "Authorization: Bearer $(cat .devnet/node2/auth.token)" \
  -H "Content-Type: application/json" \
  -d @experiments/agent-provenance-devnet/turns/turn-b.signed.json
```

**Assertions:** same shape as (a), substituting core 2 for core 1
and `end-user.agent` for `edge.agent`. Verifies §9.7 #6
("publisher-service flow with zero-ETH zero-TRAC edge").

### (c) Same-operator edge + core, no PCA (direct-spend with attribution)

> **Spec §4(c) / §9.5(c):** Edge and core 3 share an operator;
> core 3 has no PCA; edge publishes naming `core3.id` for
> attribution; pays full TRAC from edge wallet.

```bash
# Fixture: nothing — no PCA needed for this mode.

# Action
NODE_DIR=.devnet/node5 ./scripts/dkg publish <cgId> \
  --file experiments/agent-provenance-devnet/turns/turn-c.nq \
  --publisher-node-identity-id <core3_id>
```

**Assertions:** §9.7 #7 ("direct-spend with self-claimed
attribution"):

- Edge wallet TRAC balance decremented by full fee (no discount).
- Core 3's publishing-factor counter incremented (read via the
  RandomSampling / scoring storage).
- On-chain `author = edge.agent`, `publisherNodeIdentityId =
  core3.id`.
- `PublishingConvictionAccount.epochAllowance` for core 3
  unchanged (no PCA was drawn down).

### (d) Unattributed self-publishing edge

> **Spec §4(d) / §9.5(d):** Edge has no PCA authorization;
> `publisherNodeIdentityId = 0`; pays full TRAC from its own
> wallet; no core gets attribution.

```bash
# Fixture: none.

# Action
NODE_DIR=.devnet/node5 ./scripts/dkg publish <cgId> \
  --file experiments/agent-provenance-devnet/turns/turn-d.nq \
  --publisher-node-identity-id 0
```

**Assertions:** §9.7 #8:

- Edge wallet TRAC balance decremented by full fee.
- No core's publishing-factor counter incremented.
- `KnowledgeCollectionCreated` event has `author = edge.agent`,
  `publisherNodeIdentityId = 0` in storage.

### Negative case: unauthorized PCA fall-through

> **Spec §9.7 #9:** Publisher names a core that has a PCA but
> `msg.sender` is *not* on `authorizedKeys`. Publish succeeds via
> the direct-spend branch; the named core gets attribution; the
> PCA is *not* drawn down.

```bash
# Fixture: core 1 still has the PCA from mode (a). DON'T add the
# new edge wallet to core 1's authorizedKeys.

# Action — publish from a fresh edge wallet not on the allowlist.
NODE_DIR=.devnet/node5 ./scripts/dkg publish <cgId> \
  --file experiments/agent-provenance-devnet/turns/turn-fallthrough.nq \
  --publisher-node-identity-id <core1_id> \
  --publisher-key <fresh_edge_key>
```

**Assertions:**

- `PublishingConvictionAccount.epochAllowance` for core 1 unchanged.
- Edge wallet TRAC balance decremented by full fee (no discount).
- Core 1's publishing-factor counter still incremented (attribution
  preserved).

## Final §9.7 sweep

Once all four modes (and the unauthorized-PCA fall-through) have
clean transcripts, run the static cross-cutting suite to confirm
nothing regressed during devnet bring-up:

```bash
pnpm --filter @origintrail-official/dkg-chain test \
  test/agent-provenance-cross-cutting.test.ts

pnpm --filter @origintrail-official/dkg test \
  test/kc-author-route.e2e.test.ts
```

Both should be 13/13 + 5/5 green, matching the CI pin.

## Out of scope for this runbook

- §9.7 #5 ("replay protection on chain"): covered by the existing
  Solidity unit tests in
  `packages/evm-module/test/unit/KnowledgeAssetsV10.test.ts` (the
  five negative cases — wrong chainId, wrong contract, wrong cgId,
  wrong merkleRoot, wrong scheme version, wrong author address —
  each have their own `it()` block). Run them once on devnet
  bring-up but don't repeat per-mode.
- Adapter-side signing (Phase 4 / OpenClaw `ChatTurnWriter` and
  Hermes daemon-side): not implemented in this PR. The on-chain
  `author` field for Hermes/OpenClaw-driven publishes is therefore
  the daemon's publisher EOA, NOT the originating user's agent
  EOA. See the Phase 4 design discussion in PR #436 for the
  options.
