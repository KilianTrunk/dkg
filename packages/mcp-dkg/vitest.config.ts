import { defineConfig } from 'vitest/config';

/**
 * Local test config for @origintrail-official/dkg-mcp.
 *
 * Wave-2 tool drop (2026-05-04) deleted the four test files that
 * pinned now-removed V9-era surfaces: `normalise-slug.test.ts` +
 * `uri-helpers.test.ts` (helpers in the dropped `tools/annotations.ts`),
 * `capture-hook.test.ts` + `starter-ontologies.test.ts` (assertions
 * on `dkg_annotate_turn` / `dkg_search` strings inside V9 ontology
 * agent-guides). qa-engineer's verification-plan v6.x is the
 * follow-up that wires fresh fixtures for the post-drop surface
 * (assertion CRUD, memory-search trust ranking, query schema).
 *
 * Integration (against a running daemon) is exercised by the smoke
 * scripts at scripts/smoke-writes.mjs and scripts/smoke-annotate.mjs.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
  },
});
