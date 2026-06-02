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
 * IMPORTANT — only seed devnets WE bootstrapped. When `webServer` reuses an
 * operator's pre-existing devnet, `globalTeardown` intentionally leaves it
 * running, so seeding into it would permanently pollute that operator's
 * `devnet-test` graph (a fresh assertion + sub-graph on every local run). We
 * therefore seed only when the bootstrap wrote its managed-devnet marker (i.e.
 * Playwright spawned the cluster and node1 is freshly started, to be torn down
 * at the end). On a reused devnet we skip seeding entirely.
 *
 * Seeding is best-effort: if the devnet never comes up — or was reused — the
 * specs that depend on content assert tolerantly / skip, so a seeding miss
 * degrades gracefully rather than failing the whole run at setup time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDevnetStatus } from './helpers/devnet.js';
import { seedVmEntity, seedSubgraphEntity, PRIMARY_CG, NAMED_SUBGRAPH } from './helpers/real-node.js';
import type { PlaywrightManagedMarker } from './bootstrap-devnet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER_FILE = resolve(__dirname, '../../..', '.devnet', '.playwright-managed');

function readMarker(): PlaywrightManagedMarker | null {
  if (!existsSync(MARKER_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MARKER_FILE, 'utf8')) as PlaywrightManagedMarker;
  } catch {
    return null;
  }
}

/**
 * True only when THIS Playwright run bootstrapped node1 (so seeding it is safe —
 * it gets torn down at the end). The marker is written by bootstrap-devnet.ts the
 * instant node1 becomes reachable, which is also when `waitForDevnetStatus`
 * resolves, so a single read can race the write — poll briefly. No marker after
 * the grace window ⇒ the devnet was reused and must not be polluted.
 */
async function playwrightBootstrappedNode1(graceMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  do {
    const marker = readMarker();
    if (marker) return !(marker.preExistingNodes ?? []).includes(1);
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return false;
}

export default async function globalSetup(): Promise<void> {
  try {
    await waitForDevnetStatus(1, 180_000);
    if (!(await playwrightBootstrappedNode1())) {
      console.log(
        '[global-setup] devnet was reused (no managed-devnet marker) — skipping seed to avoid polluting an operator-owned graph',
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
