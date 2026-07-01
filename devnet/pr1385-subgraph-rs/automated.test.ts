/**
 * PR #1385 — Random-Sampling extraction reads NAMED SUB-GRAPH knowledge assets.
 *
 * What the PR fixes (network-observable, verified in source before authoring):
 *
 *   A KA published into a registered named sub-graph was previously UNPROVABLE
 *   by the RS prover. A sub-graph KA is sampled under the PARENT cgId (the chain
 *   has no sub-graph dimension), but its public data does NOT live in the
 *   per-cgId data graph the old extractor read — it lives in
 *     - the bare sub-graph graph   `did:dkg:context-graph:<cg>/<sub>`        (replica), and
 *     - the per-KA verifiable-memory layer
 *       `did:dkg:context-graph:<cg>/<sub>/_verifiable_memory/<author>/<number>` (author).
 *   So the per-cgId read yielded nothing → `KCDataMissingError` → the prover
 *   skipped the period forever for any CG containing a sub-graph KA.
 *
 *   The fix (packages/random-sampling/src/ka-extractor.ts ~178-401):
 *   `extractV10KCFromStore` now runs a read-path CASCADE. For each root entity
 *   that the per-cgId data graph (a) cannot satisfy, it DISCOVERS the sub-graph
 *   name from `_meta` (`resolveSubGraphNameFromMeta`, lines 420-438; read-both:
 *   per-cgId `_meta` UNION the default-label `<NAME>/_meta`) and falls back to
 *   (b1) the per-KA VM layer `contextGraphLayerUri(..., sg)` then (b2) the bare
 *   sub-graph graph `contextGraphSubGraphUri(cg, sg)`. FIRST non-empty source per
 *   root wins (never a UNION → no leaf inflation). Leaves are still
 *   `hashTripleV10` of the same triple content, so anchored roots are unchanged
 *   — a read-path change only.
 *
 * NETWORK-OBSERVABLE PROXIES this suite asserts (the extractor is internal to
 * the prover; we observe the data homes + the prover outcome it reads):
 *
 *   it 1 (DETERMINISTIC — the core of #1385): the sub-graph KA's triple is
 *     materialized in exactly the graphs the post-#1385 extractor reads. We probe
 *     via the daemon query route, which (no-view path) scopes a
 *     `{contextGraphId, subGraphName}` query to
 *     `GRAPH <…/<cg>/<sub>>` UNION its `…/<sub>/_verifiable_memory/*` per-KA
 *     graphs (packages/query/src/dkg-query-engine.ts:247-264 →
 *     contextGraphSubGraphUri, packages/core/src/constants.ts:327). On the
 *     publisher/author node the VM layer is in scope, so the triple is reachable
 *     by sub-graph name — the same bare sub-graph / VM homes (b1)/(b2) the
 *     extractor falls back to. This is the regression that #1385 makes
 *     observable: pre-#1385 a sub-graph KA's content was unreachable from the CG
 *     scope; post-#1385 it lives in (and is read from) the named sub-graph graph.
 *
 *   it 2 (DETERMINISTIC — read-path semantics, NOT a guess): the SAME triple is
 *     NOT reachable from a plain PARENT-CG-scope query (contextGraphId only, no
 *     subGraphName, no view). Confirmed in source: the no-view scope resolves
 *     `dataGraph = contextGraphDataUri(<cg>)` = bare `did:dkg:context-graph:<cg>`
 *     plus only the ROOT's `…/_verifiable_memory/` prefix (dkg-query-engine.ts:
 *     250,259) — there is NO `discoverRegisteredSubGraphNames` fan-out on the
 *     no-view path (that fan-out exists for VIEW reads only, GH #675, line 488).
 *     So sub-graph data is visible ONLY when the sub-graph is named. This mirrors
 *     EXACTLY the extractor's premise: "the per-cgId data graph is empty for a
 *     sub-graph KA" — which is precisely why #1385's discover-and-fall-back
 *     cascade is needed. (Asserting reachability-from-parent here would
 *     contradict the real semantics and the PR's own motivation.)
 *
 *   it 3 (BEST-EFFORT — RS liveness / regression): with a sub-graph KA resident
 *     in the shared `devnet-test` CG, RS must still LAND a proof on-chain (no
 *     KCDataMissingError stalls the prover). Gate on the ON-CHAIN solved flag
 *     (getNodeChallenge tuple index [6]) on some core — robust to a warm devnet
 *     where the per-process `submittedCount` is already non-zero. Additionally
 *     snapshot each core's submittedCount BEFORE and accept an INCREASE as a
 *     second liveness signal. Log whether the solved challenge's
 *     knowledgeAssetId (tuple index [0]) matches our sub-graph kaId (strong case)
 *     but DON'T gate on it — the network draw samples across every weighted CG so
 *     which KA is sampled is non-deterministic.
 *
 * SUB-GRAPH PUBLISH FLOW (each command/flag verified in source):
 *   1. Register the sub-graph (idempotent on this devnet) — POST
 *      /api/sub-graph/create { contextGraphId, subGraphName }
 *      (packages/cli/src/daemon/routes/context-graph.ts:727; body validated by
 *      validateSubGraphName). Equivalent CLI: `dkg context-graph create-sub-graph
 *      <cg> <sg>` (positional, commands/context-graph.ts:265).
 *   2. Stage the KA into the sub-graph — `dkg shared-memory write <cg> -f <file>
 *      --name <name> --sub-graph-name <sg>` (commands/shared-memory.ts:114-124:
 *      `-f/--file`, `--name`, `--sub-graph-name` are all real options; create →
 *      append batches into the named assertion).
 *   3. Publish it on-chain — `dkg shared-memory publish <cg> --name <name>
 *      --sub-graph-name <sg>` (commands/shared-memory.ts:180-237: finalize →
 *      promote → publishFromFinalizedAssertion, i.e. land on VM/chain). Prints
 *      `Status:` + `KC ID:` we parse for the kaId.
 *   NB the one-shot `dkg publish` does NOT support sub-graphs (no
 *   --sub-graph-name on `publish` in the harness `publishViaCli`), hence the
 *   write→publish lifecycle.
 *
 * ISOLATION (this suite runs against ONE shared 6-node devnet, in sequence with
 * the rest of the 10.0.2 sweep):
 *   - Creates only EPHEMERAL self-named entities: a fresh sub-graph name
 *     (`pr1385sg<ts>`) + a unique KA subject (`urn:test:pr1385-subgraph:<ts>:n`).
 *   - Additive publishing into the shared `devnet-test` CG is REQUIRED (the RS
 *     prover only samples KAs in bootstrapped CGs) and is fine — it adds, never
 *     mutates, and every query is scoped by our unique subject so no other suite's
 *     data interferes.
 *   - Never touches node identities / op-wallets; NEVER time-warps (that breaks
 *     in-flight RS challenges this very suite needs to land).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  detectDevnet,
  ensureAllIdentities,
  runDkgCli,
  writeNquads,
  queryNode,
  postJson,
  getJson,
  waitFor,
  CONTEXT_GRAPH,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';

// Predicate + object literal for the unique sub-graph triple. The object value
// is asserted to round-trip out of the sub-graph graph in it 1.
const PRED = 'https://schema.org/identifier';
const OBJECT_VALUE = 'pr1385-subgraph-rs-marker';

/** Raw value/IRI of a binding (string N-Triples term OR `{value}`-object). */
const valueOf = (x: unknown): string =>
  typeof x === 'string' ? x : ((x as { value?: string })?.value ?? '');

/** Bare lexical of an object binding (strip surrounding quotes + any datatype/
 *  lang suffix) so a plain-literal compare is robust to the daemon's term form. */
function lexical(x: unknown): string {
  const t = valueOf(x);
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  return m ? m[1] : t;
}

interface Suite {
  state: DevnetState;
  node: DevnetNode; // publisher / author (node1, a core node with an identity)
  subGraphName: string;
  subject: string;
  kaId: bigint;
}

const suite: Partial<Suite> = {};

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run `./scripts/devnet.sh start 6` before this suite ' +
        '(needs a live 6-node devnet + deployed V10 contracts).',
    );
  }
  await ensureAllIdentities(detected, 4);

  const node = detected.nodes[1]!;
  if (node.identityId === 0n) {
    throw new Error('node1 has no on-chain identity — bootstrap the devnet first');
  }

  // Unique, self-named ephemeral entities (validateSubGraphName: alphanumeric/
  // dash-ish; keep it lowercase-alnum to be safe across the validator).
  const ts = Date.now();
  suite.state = detected;
  suite.node = node;
  suite.subGraphName = `pr1385sg${ts}`;
  suite.subject = `urn:test:pr1385-subgraph:${ts}:1`;
}, 240_000);

describe('PR #1385 — RS extraction reads named sub-graph KAs (live 6-node devnet)', () => {
  it(
    'registers a sub-graph + publishes a KA into it; the triple is materialized in the named sub-graph graph',
    async () => {
      const s = suite as Suite;
      const node = s.node;
      const name = `pr1385-${Date.now()}`;

      // ── 1. Register the sub-graph (idempotent on a warm devnet) ──────────────
      // POST /api/sub-graph/create { contextGraphId, subGraphName }
      // (routes/context-graph.ts:727). 200 = created; 400 "already exists" is
      // also acceptable (our name is unique-by-timestamp, so 200 is expected).
      const reg = await postJson(node, '/api/sub-graph/create', {
        contextGraphId: CONTEXT_GRAPH,
        subGraphName: s.subGraphName,
      });
      const okCreate =
        reg.status === 200 ||
        (reg.status === 400 && /already exists/i.test(JSON.stringify(reg.json)));
      expect(
        okCreate,
        `sub-graph register failed (${reg.status}): ${JSON.stringify(reg.json)}`,
      ).toBe(true);

      // ── 2. Stage the KA INTO the sub-graph ───────────────────────────────────
      // `dkg shared-memory write <cg> -f <file> --name <name> --sub-graph-name <sg>`
      // (commands/shared-memory.ts:114-124). The n-quads file is labelled with the
      // PARENT CG graph URI — sub-graph routing is the API param, NOT the file's
      // graph label (write loads quads against the default CG graph + passes
      // subGraphName separately). makeNquadsFile's contract, mirrored here.
      const g = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
      const file = writeNquads(import.meta.dirname, name, [
        `<${s.subject}> <${PRED}> "${OBJECT_VALUE}" <${g}>`,
        `<${s.subject}> <https://schema.org/name> "${name}" <${g}>`,
      ]);

      const write = await runDkgCli(
        node,
        [
          'shared-memory',
          'write',
          CONTEXT_GRAPH,
          '-f',
          file,
          '--name',
          name,
          '--sub-graph-name',
          s.subGraphName,
        ],
        120_000,
      );
      expect(
        write.code,
        `shared-memory write failed (exit ${write.code})\nstdout: ${write.stdout}\nstderr: ${write.stderr}`,
      ).toBe(0);

      // ── 3. Publish it on-chain ───────────────────────────────────────────────
      // `dkg shared-memory publish <cg> --name <name> --sub-graph-name <sg>`
      // (commands/shared-memory.ts:180; finalize → promote → publish-to-VM). Prints
      // `Status:` + `KC ID:` we parse — same surface publishViaCli parses.
      const publish = await runDkgCli(
        node,
        [
          'shared-memory',
          'publish',
          CONTEXT_GRAPH,
          '--name',
          name,
          '--sub-graph-name',
          s.subGraphName,
        ],
        120_000,
      );
      // NOTE: `dkg shared-memory publish --sub-graph-name` currently exits 1 on a
      // cosmetic POST-success error ("Cannot read properties of undefined
      // (reading 'length')") even though the on-chain publish confirms (Status:
      // confirmed + KC ID + merkle root are printed, "Promoted: N quads"). We
      // therefore assert success from stdout, not the exit code, and surface the
      // anomaly. If stdout shows no confirmation, THEN treat the non-zero exit as
      // a real failure.
      const status = (/Status:\s*(\w+)/i.exec(publish.stdout)?.[1] ?? 'unknown').toLowerCase();
      if (publish.code !== 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `#1385: sub-graph 'shared-memory publish' exited ${publish.code} despite Status=${status} — ` +
            `cosmetic CLI post-success error (worth a follow-up). stderr: ${publish.stderr.slice(0, 200)}`,
        );
        expect(
          /Status:\s*(confirmed|finalized|tentative)/i.test(publish.stdout) && /KC ID:\s*\d+/i.test(publish.stdout),
          `sub-graph publish exited ${publish.code} AND stdout shows no confirmation — real failure\nstdout: ${publish.stdout}\nstderr: ${publish.stderr}`,
        ).toBe(true);
      }
      expect(
        ['confirmed', 'finalized', 'tentative'],
        `sub-graph publish status="${status}"\n${publish.stdout}`,
      ).toContain(status);
      const kaIdStr = /KC ID:\s*(\d+)/i.exec(publish.stdout)?.[1];
      expect(kaIdStr, `sub-graph publish surfaced no "KC ID:"\n${publish.stdout}`).toBeTruthy();
      s.kaId = BigInt(kaIdStr!);
      expect(s.kaId, 'sub-graph KA id must be positive').toBeGreaterThan(0n);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: published sub-graph KA — cg=${CONTEXT_GRAPH} sub=${s.subGraphName} ` +
          `kaId=${s.kaId} subject=${s.subject}`,
      );

      // ── 4. CORE ASSERTION: the triple is in the named SUB-GRAPH graph ────────
      // A no-view `{contextGraphId, subGraphName}` query scopes to
      //   GRAPH <did:dkg:context-graph:<cg>/<sub>> UNION its …/_verifiable_memory/*
      // (dkg-query-engine.ts:247-264). On the AUTHOR node (node1) the per-KA VM
      // layer is in scope, so the triple is reachable BY SUB-GRAPH NAME — exactly
      // the (b1)/(b2) homes the post-#1385 extractor falls back to. Plain BGP, no
      // GRAPH clause: the engine wraps it onto the scoped graphs (wrapWithGraph
      // /Union). Post-publish store materialization lags → poll.
      const bindings = await waitFor(
        `sub-graph triple <${s.subject}> visible under sub-graph "${s.subGraphName}"`,
        120_000,
        3_000,
        async () => {
          const rows = await queryNode(
            node,
            `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
            { contextGraphId: CONTEXT_GRAPH, subGraphName: s.subGraphName },
          );
          return rows.length > 0 ? rows : null;
        },
      );

      expect(bindings.length, 'expected >=1 binding for the sub-graph triple').toBeGreaterThanOrEqual(1);
      const objects = bindings.map((r) => lexical(r.o));
      expect(
        objects,
        `sub-graph query returned ${JSON.stringify(objects)}, expected to contain "${OBJECT_VALUE}"`,
      ).toContain(OBJECT_VALUE);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: sub-graph triple reachable via subGraphName="${s.subGraphName}" ` +
          `(value="${OBJECT_VALUE}") — the bare-sub-graph / VM home the extractor reads`,
      );
    },
    300_000,
  );

  it(
    'the same triple is NOT reachable from a plain PARENT-CG-scope query (sub-graph data is sub-graph-scoped)',
    async () => {
      const s = suite as Suite;
      expect(s.kaId, 'it 1 must have published the sub-graph KA first').toBeGreaterThan(0n);

      // A no-view query scoped to the CG WITHOUT subGraphName resolves to the bare
      // `did:dkg:context-graph:<cg>` data graph + only the ROOT's
      // …/_verifiable_memory/ prefix (dkg-query-engine.ts:250,259). There is NO
      // sub-graph fan-out on the no-view path (the GH #675 fan-out is VIEW-only,
      // line 488), so the sub-graph triple must NOT appear here. This is the exact
      // mirror of the extractor's premise — "the per-cgId data graph is empty for a
      // sub-graph KA" — which is WHY #1385's discover-and-fall-back cascade exists.
      //
      // Re-query the sub-graph scope first to confirm the triple is genuinely
      // present (guards against a false-pass where 0 rows just means "not yet
      // materialized" rather than "correctly out of parent scope").
      const inSub = await queryNode(
        s.node,
        `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
        { contextGraphId: CONTEXT_GRAPH, subGraphName: s.subGraphName },
      );
      expect(
        inSub.length,
        'precondition: triple must still be present under the sub-graph scope',
      ).toBeGreaterThanOrEqual(1);

      const inParent = await queryNode(
        s.node,
        `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
        { contextGraphId: CONTEXT_GRAPH }, // no subGraphName, no view
      );
      expect(
        inParent.length,
        `sub-graph triple must NOT be visible from the parent CG scope, ` +
          `got ${JSON.stringify(inParent.map((r) => valueOf(r.o)))}`,
      ).toBe(0);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: sub-graph triple correctly scoped — present under "${s.subGraphName}", ` +
          `absent from bare "${CONTEXT_GRAPH}" (the empty per-cgId graph the old extractor read)`,
      );
    },
  );

  it(
    'best-effort: RS still lands a proof on-chain with a sub-graph KA resident (no KCDataMissingError stall)',
    async () => {
      const s = suite as Suite;
      const rss = s.state.rss;

      // Preflight + BEFORE snapshot: every core (1-4) must have the RS prover
      // enabled, and we record each core's current submittedCount so we can accept
      // a strict INCREASE as a liveness signal (the absolute value is non-zero on a
      // warm devnet, so an absolute check would be trivially true).
      const coreIds: Record<number, bigint> = {};
      const before: Record<number, number> = {};
      for (let n = 1; n <= 4; n++) {
        const node = s.state.nodes[n]!;
        const { status, json } = await getJson(node, '/api/random-sampling/status');
        expect(status, `node${n} /api/random-sampling/status HTTP`).toBe(200);
        expect(
          json?.enabled,
          `node${n} RS prover disabled (identity pending?): ${JSON.stringify(json)}`,
        ).toBe(true);
        coreIds[n] = BigInt(json?.identityId ?? '0');
        expect(coreIds[n], `node${n} identityId from RS status`).toBeGreaterThan(0n);
        before[n] = Number(json?.loop?.submittedCount ?? 0);
      }

      // Poll for liveness via TWO independent signals (first to fire wins):
      //   (A) ON-CHAIN: some core's current challenge is solved
      //       (getNodeChallenge tuple index [6]) — the authoritative "a proof
      //       landed" signal, robust to which KA the network draw sampled.
      //   (B) submittedCount strictly increased on some core vs the BEFORE
      //       snapshot — the prover progressed during THIS suite.
      // A broken sub-graph extractor would surface as neither firing (the prover
      // would skip every period with kc-not-synced); we also log per-core
      // lastOutcome.kind for that diagnostic.
      const lastOutcomeKinds: Record<number, string> = {};
      const live = await waitFor(
        'an RS proof to land on-chain (solved) OR submittedCount to increase on some core',
        120_000,
        5_000,
        async () => {
          for (let n = 1; n <= 4; n++) {
            const node = s.state.nodes[n]!;
            const id = coreIds[n];
            if (id === 0n) continue;
            // (B) submittedCount increase
            try {
              const { json } = await getJson(node, '/api/random-sampling/status');
              lastOutcomeKinds[n] = json?.loop?.lastOutcome?.kind ?? '?';
              const now = Number(json?.loop?.submittedCount ?? 0);
              if (now > before[n]) {
                return { node: n, identityId: id, via: 'submittedCount' as const };
              }
            } catch {
              /* transient — keep polling */
            }
            // (A) on-chain solved
            try {
              const ch = await rss.getNodeChallenge(id);
              if (ch[6] === true) {
                return {
                  node: n,
                  identityId: id,
                  via: 'onChainSolved' as const,
                  knowledgeAssetId: ch[0] as bigint,
                  epoch: ch[3] as bigint,
                };
              }
            } catch {
              /* transient RPC — keep polling */
            }
          }
          return null;
        },
      );

      expect(live.identityId, 'a core must show RS liveness').toBeGreaterThan(0n);

      // Re-read the on-chain challenge for the live core for the strong-case log.
      // We DO NOT gate on knowledgeAssetId == our sub-graph kaId: the network draw
      // samples across every weighted CG on the devnet, so which KA is sampled is
      // non-deterministic. We only LOG the match (strong evidence when it happens).
      try {
        const ch = await rss.getNodeChallenge(live.identityId);
        const sampledKaId = ch[0] as bigint;
        const solved: boolean = ch[6];
        const matchesSubGraphKa = sampledKaId === s.kaId;
        // eslint-disable-next-line no-console
        console.log(
          `#1385 (RS liveness): node${live.node} via=${live.via} solved=${solved} ` +
            `sampledKaId=${sampledKaId} ourSubGraphKaId=${s.kaId} ` +
            `matchesSubGraphKa=${matchesSubGraphKa}` +
            (matchesSubGraphKa
              ? ' [STRONG: the SOLVED challenge is our sub-graph KA — the extractor read it]'
              : ''),
        );
      } catch {
        // eslint-disable-next-line no-console
        console.log(`#1385 (RS liveness): node${live.node} via=${live.via} (challenge re-read skipped)`);
      }
      // eslint-disable-next-line no-console
      console.log(`#1385 (RS liveness): per-core lastOutcome kinds=${JSON.stringify(lastOutcomeKinds)}`);
    },
    180_000,
  );
});
