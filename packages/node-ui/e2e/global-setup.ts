/**
 * Playwright global setup — seeds deterministic content into the devnet so the
 * data-driven UI views (memory layers, entity lists, triple counts, subgraphs)
 * have something real to render.
 *
 * Runs in PARALLEL with the webServer (see playwright.config.ts), so it must NOT
 * assume the bootstrap has finished — it polls `waitForDevnetStatus` until node1
 * is reachable (the chained bootstrap brings it up), then publishes one entity
 * through the full WM → SWM → VM pipeline into the primary seeded context graph.
 *
 * IDEMPOTENT seed. Several specs (subgraph-bar, dashboard, triple-counts, …) hard-
 * require the seeded VM entity + NAMED_SUBGRAPH sub-graph, so the supported "reuse
 * an operator-owned devnet" flow needs them present too — skipping the seed there
 * would fail those specs even on a healthy UI. But re-seeding on every run would
 * accrete assertions on a reused cluster. So we seed only when the devnet isn't
 * seeded yet (detected by the absence of the NAMED_SUBGRAPH sub-graph in
 * PRIMARY_CG): a fresh CI devnet — or a never-seeded operator devnet — gets seeded
 * once; subsequent runs against an already-seeded devnet are a no-op.
 *
 * Seeding is REQUIRED, not best-effort: several specs hard-require the seeded VM
 * entity + sub-graph, so any failure here (devnet never reachable, publish or
 * sub-graph seeding errors) must abort the run AT SETUP with the underlying
 * error. Swallowing it would only resurface later as confusing, unrelated
 * UI-assertion failures that are far harder to diagnose.
 */
import { waitForDevnetStatus, waitForConnectedPeers } from './helpers/devnet.js';
import { listSubGraphs } from './helpers/devnet-publish.js';
import { seedVmEntity, seedSubgraphEntity, PRIMARY_CG, NAMED_SUBGRAPH } from './helpers/real-node.js';

export default async function globalSetup(): Promise<void> {
  // Intentionally NOT wrapped in try/catch — see the file header. A seed failure
  // must propagate so Playwright aborts the run at setup with the real error.
  await waitForDevnetStatus(1, 180_000);
  // Idempotency check: require the seed's FINAL artifact — the e2e-namespaced
  // NAMED_SUBGRAPH sub-graph WITH at least one entity in it. A bare registered
  // sub-graph with entityCount 0 means a prior run died mid-seed (registered the
  // sub-graph but never wrote its entity / VM seed), so we must NOT treat that as
  // "already seeded" and skip — re-seed to complete it.
  const existing = await listSubGraphs(PRIMARY_CG);
  if (existing.some((sg) => sg.name === NAMED_SUBGRAPH && sg.entityCount >= 1)) {
    console.log(
      `[global-setup] ${PRIMARY_CG} already seeded (sub-graph "${NAMED_SUBGRAPH}" has entities) — skipping to avoid accreting duplicate content`,
    );
    return;
  }
  // VM publish needs ACK quorum from a connected CORE peer, and globalSetup runs
  // in parallel with the bootstrap (which only waits for node1's API port). Wait
  // for at least one connected peer so the seed can't race the cold boot and fail
  // with QuorumUnmetError.
  await waitForConnectedPeers(1, 1, 120_000);
  const seeded = await seedVmEntity(PRIMARY_CG);
  console.log(`[global-setup] seeded VM entity into ${PRIMARY_CG}: "${seeded.label}" (kaId=${seeded.kaId ?? 'n/a'})`);
  // Register + seed a named sub-graph so the SubGraphBar always has a concrete
  // scope chip to drive — the subgraph specs assert against this instead of
  // skipping when only the aggregate "All" chip exists.
  const sg = await seedSubgraphEntity(PRIMARY_CG, NAMED_SUBGRAPH);
  console.log(`[global-setup] seeded sub-graph "${NAMED_SUBGRAPH}" entity into ${PRIMARY_CG}: "${sg.label}"`);
}
