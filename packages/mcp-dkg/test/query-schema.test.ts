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

// ── Wave-2 #18 drop-sweep ────────────────────────────────────────────
// Per qa-engineer's verification-plan §0.8 fixture 4: assert that none
// of the 10 dropped tool names is registered by any tool-bundle. Today
// nothing admits a regression (the registrations were cleanly removed
// in #18); this guards against future accidental re-registration during
// refactors. Exercised against the full surface (read + assertion + memory
// + setup + health + publish) so a tool re-introduced via *any* bundle
// trips the assertion.
describe('Wave-2 #18 drop-sweep — none of the 10 dropped tools is registered', () => {
  it('asserts every dropped tool is absent across the full registered surface', async () => {
    // Lazy-import the other tool registrars so this file's top-level
    // dependency graph stays tight.
    const { registerAssertionTools } = await import('../src/tools/assertions.js');
    const { registerMemorySearchTool } = await import('../src/tools/memory-search.js');
    const { registerSetupTools } = await import('../src/tools/setup.js');
    const { registerHealthTools } = await import('../src/tools/health.js');
    const { registerPublishTools } = await import('../src/tools/publish.js');

    const server = new FakeServer();
    const client = new FakeClient();
    const config = makeConfig();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), config);
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), config);
    registerMemorySearchTool(server.asMcpServer(), client.asDkgClient(), config);
    registerSetupTools(server.asMcpServer(), client.asDkgClient(), config);
    registerHealthTools(server.asMcpServer(), client.asDkgClient(), config);
    registerPublishTools(server.asMcpServer(), client.asDkgClient(), config);

    const DROPPED_TOOLS = [
      'dkg_review_manifest',
      'dkg_annotate_turn',
      'dkg_get_ontology',
      'dkg_get_chat',
      'dkg_set_session_privacy',
      'dkg_request_vm_publish',
      'dkg_search',
      'dkg_propose_decision',
      'dkg_add_task',
      'dkg_comment',
    ];
    for (const name of DROPPED_TOOLS) {
      expect(server.tools.has(name)).toBe(false);
    }
  });
});
