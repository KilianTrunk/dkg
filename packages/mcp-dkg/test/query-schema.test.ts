import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('dkg_query — two-axis schema migration (post-#17 rename + split)', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers dkg_query and removes the legacy dkg_sparql binding', () => {
    expect(server.tools.has('dkg_query')).toBe(true);
    expect(server.tools.has('dkg_sparql')).toBe(false);
  });

  it('accepts the post-rename two-axis input shape: view + includeSharedMemory', async () => {
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      view: 'shared-working-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('shared-working-memory');
    expect(lastCall.includeSharedMemory).toBeUndefined();
  });

  it('accepts the WM∪SWM union shape via view: working-memory + includeSharedMemory: true', async () => {
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      view: 'working-memory',
      includeSharedMemory: true,
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('working-memory');
    expect(lastCall.includeSharedMemory).toBe(true);
  });

  it.each(['working-memory', 'shared-working-memory', 'verified-memory'])(
    'accepts the canonical view enum value %s',
    async (view) => {
      const result = await server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view,
      });
      expect(result.isError).toBeFalsy();
      expect(client.queryCalls.at(-1)!.view).toBe(view);
    },
  );

  it('rejects the legacy single-axis shape `layer: "wm" | "swm" | "union" | "vm"`', async () => {
    // The post-#17 schema replaces the old `layer` enum with the
    // two-axis (view, includeSharedMemory) shape. Passing the legacy
    // shape must be rejected by zod's strict object check, not silently
    // ignored.
    for (const layer of ['wm', 'swm', 'union', 'vm']) {
      await expect(
        server.call('dkg_query', {
          sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
          layer,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects view values that aren't on the canonical enum (regression: silent typo routes)", async () => {
    await expect(
      server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view: 'wm',
      }),
    ).rejects.toThrow();
    await expect(
      server.call('dkg_query', {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        view: 'private',
      }),
    ).rejects.toThrow();
  });

  it('inputSchema declares only post-migration knobs (no legacy `layer` key)', () => {
    const tool = server.get('dkg_query');
    const shape = tool.config.inputSchema!;
    const keys = Object.keys(shape);
    // Post-migration surface: sparql, projectId, subGraphName, view,
    // includeSharedMemory, limit. The legacy `layer` key MUST be gone.
    expect(keys).toEqual(
      expect.arrayContaining([
        'sparql',
        'view',
        'includeSharedMemory',
      ]),
    );
    expect(keys).not.toContain('layer');
  });

  it('view enum locks to exactly the canonical three values (alphabetical sort guard)', () => {
    const tool = server.get('dkg_query');
    const viewSchema = tool.config.inputSchema!.view as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    const inner = viewSchema.unwrap() as z.ZodEnum<[string, ...string[]]>;
    expect([...inner.options].sort()).toEqual([
      'shared-working-memory',
      'verified-memory',
      'working-memory',
    ]);
  });
});

// ── F1 sweep: schema-migration uniformity guard ──────────────────────
// Per qa-review-round-1.md F1: the W2 #17 schema migration replaced
// the `layer: 'wm'|'swm'|'union'|'vm'` enum with `view + includeSharedMemory`,
// but the migration was originally applied to `dkg_query` only. F1
// flipped `dkg_get_entity` and `dkg_list_activity` to the canonical
// shape. This sweep asserts that NO public-facing tool surface still
// exposes the legacy `layer` field — same bug-class guard as the
// drop-sweep block in `drop-sweep.test.ts`.
describe('F1 schema-migration sweep — no public tool exposes legacy `layer` field', () => {
  it('asserts every registered tool uses `view + includeSharedMemory` (or no scope field at all)', () => {
    const server = new FakeServer();
    const client = new FakeClient();
    const config = makeConfig();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), config);

    for (const [name, tool] of server.tools.entries()) {
      const shape = tool.config.inputSchema ?? {};
      // The legacy single-axis `layer` field MUST NOT appear on any
      // public-facing tool's inputSchema. Tools that don't take a
      // memory-tier scope at all (e.g. `dkg_get_agent`, listings) are
      // free to omit both — that's also valid.
      expect(
        Object.keys(shape),
        `Tool '${name}' must not expose the legacy 'layer' field; use 'view' + 'includeSharedMemory' per W2 #17 schema migration.`,
      ).not.toContain('layer');
    }
  });

  it('dkg_get_entity accepts `view: "verified-memory"` post-F1', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity', {
      uri: 'urn:test:entity',
      view: 'verified-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.view).toBe('verified-memory');
  });

  it('dkg_get_entity rejects the legacy `layer: "union"` shape', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await expect(
      server.call('dkg_get_entity', { uri: 'urn:test:entity', layer: 'union' }),
    ).rejects.toThrow();
  });

  it('dkg_list_activity accepts `view: "shared-working-memory"` post-F1', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_list_activity', {
      view: 'shared-working-memory',
    });
    expect(result.isError).toBeFalsy();
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.graphSuffix).toBe('_shared_memory');
  });

  it('dkg_list_activity rejects the legacy `layer: "wm"` shape', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await expect(
      server.call('dkg_list_activity', { layer: 'wm' }),
    ).rejects.toThrow();
  });

  it('dkg_get_entity default (no view) preserves V9-era WM∪SWM behaviour', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await server.call('dkg_get_entity', { uri: 'urn:test:entity' });
    // Default scope must produce WM∪SWM — the historical `layer: 'union'`
    // default. Encoded as `includeSharedMemory: true` on the wire.
    const lastCall = client.queryCalls.at(-1)!;
    expect(lastCall.includeSharedMemory).toBe(true);
    expect(lastCall.view).toBeUndefined();
  });
});

describe('dkg_list_context_graphs — rename + UX-note pair', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig({ defaultProject: null }));
  });

  it('registers under the canonical name dkg_list_context_graphs (not dkg_list_projects)', () => {
    expect(server.tools.has('dkg_list_context_graphs')).toBe(true);
    expect(server.tools.has('dkg_list_projects')).toBe(false);
  });

  it("description includes the canonical-naming reconciliation note: \"called 'projects' in the DKG node UI\"", () => {
    const tool = server.get('dkg_list_context_graphs');
    expect(tool.config.description).toContain("called 'projects' in the DKG node UI");
  });

  it('happy path: invokes client.listProjects and renders rows', async () => {
    client.contextGraphs.add('foo');
    client.contextGraphs.add('bar');
    const result = await server.call('dkg_list_context_graphs', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Found 2 context graph\(s\)/);
    expect(result.content[0].text).toMatch(/\*\*foo\*\*/);
    expect(result.content[0].text).toMatch(/\*\*bar\*\*/);
  });
});

describe('dkg_sub_graph_list — wave-2 rename guard', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers under the canonical name dkg_sub_graph_list (not dkg_list_subgraphs)', () => {
    expect(server.tools.has('dkg_sub_graph_list')).toBe(true);
    expect(server.tools.has('dkg_list_subgraphs')).toBe(false);
  });
});
