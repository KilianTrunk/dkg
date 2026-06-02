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
 * Seeding is best-effort: if the devnet never comes up the specs that depend on
 * content assert tolerantly, so a seeding miss degrades gracefully rather than
 * failing the whole run at setup time.
 */
import { waitForDevnetStatus } from './helpers/devnet.js';
import { listSubGraphs } from './helpers/devnet-publish.js';
import { seedVmEntity, seedSubgraphEntity, PRIMARY_CG, NAMED_SUBGRAPH } from './helpers/real-node.js';

export default async function globalSetup(): Promise<void> {
  try {
    await waitForDevnetStatus(1, 180_000);
    // Idempotency check: the NAMED_SUBGRAPH sub-graph is the seed's final step, so
    // its presence means a prior run already populated PRIMARY_CG end-to-end.
    const existing = await listSubGraphs(PRIMARY_CG).catch(() => [] as Array<{ name: string }>);
    if (existing.some((sg) => sg.name === NAMED_SUBGRAPH)) {
      console.log(
        `[global-setup] ${PRIMARY_CG} already seeded (sub-graph "${NAMED_SUBGRAPH}" present) — skipping to avoid accreting duplicate content`,
      );
      return;
    }
    const seeded = await seedVmEntity(PRIMARY_CG);
    console.log(`[global-setup] seeded VM entity into ${PRIMARY_CG}: "${seeded.label}" (kaId=${seeded.kaId ?? 'n/a'})`);
    // Register + seed a named sub-graph so the SubGraphBar always has a concrete
    // scope chip to drive — the subgraph specs assert against this instead of
    // skipping when only the aggregate "All" chip exists.
    const sg = await seedSubgraphEntity(PRIMARY_CG, NAMED_SUBGRAPH);
    console.log(`[global-setup] seeded sub-graph "${NAMED_SUBGRAPH}" entity into ${PRIMARY_CG}: "${sg.label}"`);
  } catch (err) {
    console.warn('[global-setup] seeding skipped:', (err as Error).message);
  }
}
