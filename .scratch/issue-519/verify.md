# Issue #519 — V10 PCA HTTP round-trip (TB-0007)

> This file is the evidence sink named by TB-0007 acceptance criterion 3.
> `.devnet/run.mjs` **overwrites** it on every smoke run with the live
> round-trip table (one row per step, PASS/FAIL verdict). The content
> below documents the harness and the verification performed at commit
> time; the authoritative runtime evidence is whatever the live
> `node run.mjs` execution writes here in an installed environment.

## Scripted flow (`.devnet/run.mjs`)

1. Boot devnet — active probe (Hardhat RPC + node1/node2 `/api/status`),
   free-port-base pick, `scripts/devnet.sh start 2`, re-probe. No static
   fallback (memory `feedback_devnet_runtime_verify`).
2. `POST /api/pca` `{tokens:"600000"}` → mint V10 NFT to the daemon EOA
   (600k TRAC lands in the discount tier). Expect 200 + `accountId`.
3. `POST /api/pca/:id/agent` `{agent:<publisher wallet>}` → expect 200
   `registered:true`.
4. `dkg publish <devnet-test> --file <nq>` as that agent.
5. Parse the NFT `CostCovered` event from the publish tx receipt and
   assert `0 < discountedCost < baseCost` ON CHAIN
   (`assertDiscountTaken`) — guards the PRD §8 silent-demotion risk.
6. `GET /api/pca/:id` → assert `agentCount >= 1`, V10 serialized shape.

## Verification performed at commit time

- `node --test .devnet/pca-smoke-lib.test.mjs` → **5/5 pass** (RED→GREEN
  per behaviour: `assertDiscountTaken` x3, `buildVerifyMarkdown` x2).
- `node --check .devnet/run.mjs` → syntax OK; `ethers` resolved lazily
  from the evm-module package (pnpm isolated layout does not hoist it).
- `pnpm -r build` + the live devnet smoke require workspace
  `node_modules`, which is not provisioned in the implementer sandbox
  (package install is out of scope). Gate 1 + gate 5 are validated by
  the reviewer / CI in an installed environment, where this file is
  regenerated with the live PASS/FAIL table.
