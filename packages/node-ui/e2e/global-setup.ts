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
 * Seeding is best-effort: if the devnet never comes up the specs that depend on
 * content assert tolerantly / skip, so a seeding miss degrades gracefully rather
 * than failing the whole run at setup time.
 */
import { waitForDevnetStatus } from './helpers/devnet.js';
import { seedVmEntity, seedSubgraphEntity, PRIMARY_CG, NAMED_SUBGRAPH } from './helpers/real-node.js';

export default async function globalSetup(): Promise<void> {
  try {
    await waitForDevnetStatus(1, 180_000);
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
