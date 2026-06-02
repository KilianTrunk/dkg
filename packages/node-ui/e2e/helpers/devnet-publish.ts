/**
 * Devnet API helpers for Playwright e2e — WM → SWM → VM publish flows.
 * Mirrors patterns from `devnet/rich-scenario/automated.test.ts`.
 */
import { devnetApiFetch, readDevnetNode } from './devnet.js';
import { withSwmLock } from './swm-lock.js';

export interface PublishQuads {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export function buildTestQuads(cgId: string, stamp: number, label: string): PublishQuads[] {
  const subject = `urn:e2e:ui:entity:${stamp}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  return [
    {
      subject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://dkg.io/ontology/core/Entity',
      graph,
    },
    {
      subject,
      predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
      object: `"${label}"`,
      graph,
    },
  ];
}

export async function listContextGraphs(nodeNum = 1): Promise<Array<{ id: string; name: string }>> {
  const res = await devnetApiFetch('/api/context-graphs', { nodeNum });
  if (!res.ok) throw new Error(`context-graphs: ${res.status}`);
  const json = (await res.json()) as { contextGraphs: Array<{ id: string; name: string }> };
  return json.contextGraphs ?? [];
}

/**
 * List the named sub-graphs registered in `contextGraphId` (the same endpoint the
 * SubGraphBar reads). Used by global-setup to detect an already-seeded devnet and
 * keep seeding idempotent. Best-effort: a fresh/empty CG that 404s is treated as
 * "no sub-graphs" rather than throwing, so a missing list never aborts setup.
 */
export async function listSubGraphs(
  contextGraphId: string,
  nodeNum = 1,
): Promise<Array<{ name: string }>> {
  const res = await devnetApiFetch(
    `/api/sub-graph/list?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    { nodeNum },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { subGraphs?: Array<{ name: string }> };
  return json.subGraphs ?? [];
}

/**
 * Register a named sub-graph in `contextGraphId`. Idempotent for our purposes:
 * a duplicate registration just returns the existing one (or a benign error we
 * swallow), so callers can register-then-seed without a pre-check.
 */
export async function createSubGraph(opts: {
  contextGraphId: string;
  subGraphName: string;
  nodeNum?: number;
}): Promise<void> {
  const res = await devnetApiFetch('/api/sub-graph/create', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      subGraphName: opts.subGraphName,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Idempotency: the ONLY benign client error is a duplicate registration —
    // the sub-graph already exists, so a register-then-seed caller can proceed.
    // A 409 Conflict or an "already exists/registered" message both signal that.
    // Every OTHER 4xx (invalid `subGraphName`, unknown context graph, malformed
    // body, …) is a genuine setup regression that would leave seedSubgraphEntity()
    // running from a broken precondition — surface it rather than swallow it. 5xx
    // always throws.
    const alreadyExists =
      res.status === 409 || /already\s+(exist|exists|registered|present)/i.test(body);
    if (!alreadyExists) {
      throw new Error(`createSubGraph failed: ${res.status} ${body}`);
    }
  }
}

/** Quads targeting a NAMED sub-graph's data graph (`<cg>/<subGraph>`). */
export function buildSubGraphQuads(
  cgId: string,
  subGraphName: string,
  stamp: number,
  label: string,
): PublishQuads[] {
  const subject = `urn:e2e:ui:sg:${subGraphName}:${stamp}`;
  const graph = `did:dkg:context-graph:${cgId}/${subGraphName}`;
  return [
    {
      subject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://dkg.io/ontology/core/Entity',
      graph,
    },
    {
      subject,
      predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
      object: `"${label}"`,
      graph,
    },
  ];
}

export async function createWmAssertion(opts: {
  contextGraphId: string;
  name: string;
  quads: PublishQuads[];
  promote?: boolean;
  subGraphName?: string;
  nodeNum?: number;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await devnetApiFetch('/api/assertion/create', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      quads: opts.quads,
      finalize: true,
      promote: opts.promote ?? false,
      ...(opts.subGraphName ? { subGraphName: opts.subGraphName } : {}),
    }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export async function promoteAssertion(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
}): Promise<Response> {
  const encoded = encodeURIComponent(opts.assertionName);
  return devnetApiFetch(`/api/assertion/${encoded}/promote`, {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
    }),
  });
}

export async function publishToVm(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
  clearAfter?: boolean;
}): Promise<{ status?: string; kaId?: string; txHash?: string }> {
  const res = await devnetApiFetch('/api/shared-memory/publish', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      assertionName: opts.assertionName,
      clearAfter: opts.clearAfter ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { status?: string; kaId?: string; txHash?: string };
}

export async function runWmSwmVmPipeline(opts: {
  contextGraphId: string;
  stamp?: number;
  nodeNum?: number;
}): Promise<{ assertionName: string; label: string; kaId?: string }> {
  const stamp = opts.stamp ?? Date.now();
  const assertionName = `e2e-ui-pipeline-${stamp}`;
  const label = `E2E Pipeline ${stamp}`;
  const quads = buildTestQuads(opts.contextGraphId, stamp, label);

  // Hold the SWM mutation lock across promote→publish so a concurrent
  // `clearAfter: true` from another spec can't wipe this CG's shared memory
  // between our promote and publish (see swm-lock.ts). The WM create is inside
  // the lock too, keeping the assertion's whole WM→SWM→VM lifecycle atomic
  // relative to other mutators.
  return withSwmLock(async () => {
    const wm = await createWmAssertion({
      contextGraphId: opts.contextGraphId,
      name: assertionName,
      quads,
      promote: false,
      nodeNum: opts.nodeNum,
    });
    if (!wm.ok) throw new Error(`WM create failed: ${wm.status} ${wm.body}`);

    const promoteRes = await promoteAssertion({
      contextGraphId: opts.contextGraphId,
      assertionName,
      nodeNum: opts.nodeNum,
    });
    if (!promoteRes.ok) {
      throw new Error(`SWM promote failed: ${promoteRes.status} ${await promoteRes.text()}`);
    }

    const vm = await publishToVm({
      contextGraphId: opts.contextGraphId,
      assertionName,
      nodeNum: opts.nodeNum,
    });

    return { assertionName, label, kaId: vm.kaId };
  });
}

export async function registerAgent(nodeNum: number, label: string): Promise<{ agentAddress: string; authToken: string }> {
  const res = await devnetApiFetch('/api/agent/register', {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ name: `e2e-${label}-${Date.now()}`, framework: 'playwright-e2e' }),
  });
  if (!res.ok) throw new Error(`register agent: ${res.status} ${await res.text()}`);
  return (await res.json()) as { agentAddress: string; authToken: string };
}

export async function addParticipant(cgId: string, agentAddress: string, nodeNum = 1): Promise<Response> {
  return devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/add-participant`, {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ agentAddress }),
  });
}

export function devnetNodeHome(num: number): string | null {
  return readDevnetNode(num)?.home ?? null;
}
