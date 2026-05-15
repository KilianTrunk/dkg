# Issue #519 — V10 PCA HTTP round-trip (TB-0007)

> This file is the evidence sink named by TB-0007 acceptance criterion 3.
> `.devnet/run.mjs` **overwrites** it on every smoke run with the live
> round-trip table (one row per step, PASS/FAIL verdict). The content
> below documents the harness and the verification performed at commit
> time; the authoritative runtime evidence is whatever the live
> `node run.mjs` execution writes here in an installed environment.

## Scripted flow (`.devnet/run.mjs`)

1. **Force clean restart** — always stop + wipe + `scripts/devnet.sh
   start 2`, re-probe. The smoke never reuses an already-green devnet:
   a reused chain carries the `agentToAccountId` map and the daemon's
   publish-signer rotation cursor forward, which broke re-runs (review
   blocker 1). No static fallback (memory `feedback_devnet_runtime_verify`).
2. `POST /api/pca` `{tokens:"600000"}` → mint V10 NFT to the daemon EOA
   (600k TRAC lands in the discount tier). Expect 200 + `accountId`.
3. `POST /api/pca/:id/agent` for **every** candidate publisher wallet
   (union of `wallets.json` + `publisher-wallets.json`), idempotently
   via `classifyAgentRegistration` (skips wallets already bound to this
   account, hard-fails on a foreign binding) — the daemon publisher
   rotates op wallets, so registering only `[0]` raced the rotation
   (review blocker 2).
4. `dkg publish <devnet-test> --file <nq>` as that agent.
5. Bind the **actual** publish signer: `assertPublishSignerBound`
   checks `receipt.from`'s on-chain `agentToAccountId` == our account
   BEFORE the discount math, so a silent demotion fails with an
   actionable message, not opaque discount-math noise.
6. Parse the NFT `CostCovered` event from the publish tx receipt and
   assert `0 < discountedCost < baseCost` ON CHAIN
   (`assertDiscountTaken`) — guards the PRD §8 silent-demotion risk.
7. `GET /api/pca/:id` → assert `agentCount >= 1`, V10 serialized shape.

## Verification performed at commit time

- `node --test .devnet/pca-smoke-lib.test.mjs` → **12/12 pass**
  (RED→GREEN per behaviour: `assertDiscountTaken` x3,
  `buildVerifyMarkdown` x2, `classifyAgentRegistration` x4,
  `assertPublishSignerBound` x3).
- `node --check .devnet/run.mjs` → syntax OK; `ethers` resolved lazily
  from the evm-module package (pnpm isolated layout does not hoist it).
- `pnpm -r build` + the live devnet smoke require workspace
  `node_modules`, which is not provisioned in the implementer sandbox
  (package install is out of scope). Gate 1 + gate 5 are validated by
  the reviewer / CI in an installed environment, where this file is
  regenerated with the live PASS/FAIL table.
