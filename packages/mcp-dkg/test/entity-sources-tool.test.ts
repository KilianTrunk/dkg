/**
 * `dkg_get_entity_sources` — addressed-read provenance tool.
 *
 * The engine contract (scoped `GRAPH ?g` binds the source) is pinned in
 * packages/query; here we pin the tool surface: it issues the controlled
 * single-tier `GRAPH ?g` query (never the SWM-union), defaults to the citable
 * verifiable-memory tier, renders each fact with its KA source, and refuses an
 * injection-shaped entity URI.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

const VM = (addr: string, n: string) => `did:dkg:context-graph:cg/_verifiable_memory/${addr}/${n}`;

describe('dkg_get_entity_sources', () => {
  it('issues a scoped, single-view GRAPH ?g query and defaults to verifiable-memory', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    expect(result.isError).toBeFalsy();
    const call = client.queryCalls.at(-1)!;
    expect(String(call.sparql)).toContain('GRAPH ?g');
    expect(call.view).toBe('verifiable-memory');
    // Never the WM∪SWM union path (that would duplicate every sourced row).
    expect(call.includeSharedMemory).toBeUndefined();
  });

  it('renders each fact with its KA source and a deduped Sources section', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({
        bindings: [
          { p: 'http://schema.org/name', o: '"X-name"', g: VM('0xaa', '7') },
          { p: 'http://schema.org/color', o: '"X-color"', g: VM('0xbb', '8') },
        ],
      }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Facts (with sources)');
    expect(text).toContain('X-name');
    expect(text).toContain('0xaa/7');
    expect(text).toContain('0xbb/8');
    expect(text).toContain('Sources (2 verifiable)');
  });

  it('forwards an explicit view', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', view: 'shared-working-memory' });
    expect(client.queryCalls.at(-1)!.view).toBe('shared-working-memory');
  });

  it('rejects an injection-shaped entity URI before querying', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const before = client.queryCalls.length;
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x> } UNION { ?s ?p ?o' });
    expect(result.isError).toBe(true);
    expect(client.queryCalls.length).toBe(before);
  });
});
