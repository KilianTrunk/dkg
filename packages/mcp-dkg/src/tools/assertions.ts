/**
 * Raw assertion CRUD + introspection tools for the DKG MCP server.
 *
 * These are the P0 "memory backend" tools per parity-matrix v0.5 §4.14 + §4.16:
 * five tools that expose the canonical four-step write lifecycle plus a
 * dump-everything introspection helper. They are intentionally lower-level
 * than the sugared `dkg_propose_decision` / `dkg_add_task` write tools —
 * agents can persist arbitrary RDF without inventing per-shape sugar, and
 * defer the WM→SWM promotion decision (write now, share later).
 *
 * Argument-key alignment per matrix v0.5 OQ-a: `name` flows through every
 * tool unchanged, matching the OpenClaw adapter (`DkgNodePlugin.ts:2399+`).
 * The `name` regex on `dkg_assertion_create` is creator-side input
 * validation only; read-side and import paths accept any pre-existing
 * assertion name.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function resolveProject(
  explicit: string | undefined,
  config: DkgConfig,
): string | null {
  return explicit ?? config.defaultProject ?? null;
}

const projectErr = (): ToolResult =>
  errResult(
    'No project specified. Either pass `projectId` to this tool, set `DKG_PROJECT` in the environment, or pin `contextGraph:` in `.dkg/config.yaml`.',
  );

export function registerAssertionTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  // ── dkg_assertion_create ────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_create',
    {
      title: 'Create Assertion',
      description:
        'Step 1 of the canonical write flow: create an empty Working Memory ' +
        'assertion graph. Idempotent — duplicate names land as ' +
        '`alreadyExists: true` rather than throwing. Slug must match ' +
        '/^[a-z0-9-]+$/ for new names; pre-existing assertions accept any name.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9-]+$/, 'Assertion name must be lowercase a-z, 0-9, or hyphen')
          .describe('Assertion name slug (e.g. "session-2026-04-30")'),
        projectId: z
          .string()
          .optional()
          .describe('contextGraphId; defaults to .dkg/config.yaml'),
        subGraphName: z
          .string()
          .optional()
          .describe('Optional sub-graph to scope the assertion to'),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.createAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        if (result.alreadyExists) {
          return ok(`Assertion '${name}' already exists in '${pid}'.`);
        }
        return ok(
          `Created assertion '${name}' in '${pid}'.\nURI: ${result.assertionUri ?? '(unset)'}`,
        );
      } catch (e) {
        return errResult(`Failed to create assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_write ─────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_write',
    {
      title: 'Write Quads to Assertion',
      description:
        'Step 2 of the canonical write flow: append RDF quads into an ' +
        'existing Working Memory assertion. Writes are additive (set-merge); ' +
        'callers that want replace semantics should call `dkg_assertion_discard` ' +
        'first or mint a unique assertion name per snapshot.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        quads: z
          .array(
            z.object({
              subject: z.string().describe('Subject URI'),
              predicate: z.string().describe('Predicate URI'),
              object: z
                .string()
                .describe('Object URI or literal value (raw, including any quoting)'),
              graph: z.string().optional().describe('Optional named graph URI'),
            }),
          )
          .min(1)
          .describe('Non-empty array of RDF quads to append'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, quads, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        // Keep the input shape (subject/predicate/object/graph) — the daemon
        // accepts the union shape used by both adapter-openclaw and mcp-dkg.
        // Strip angle brackets from URIs to match the existing
        // `client.writeAssertion` triples shape; the adapter does the same
        // at the handler level.
        const strip = (t: string): string =>
          t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
        const triples = quads.map((q) => ({
          subject: strip(q.subject),
          predicate: strip(q.predicate),
          object: q.object,
        }));
        await client.writeAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
          triples,
        });
        return ok(
          `Wrote ${triples.length} quad(s) to assertion '${name}' in '${pid}'.`,
        );
      } catch (e) {
        return errResult(`Failed to write assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_promote ───────────────────────────────────────
  server.registerTool(
    'dkg_assertion_promote',
    {
      title: 'Promote Assertion to SWM',
      description:
        'Step 3 of the canonical write flow: promote a Working Memory ' +
        'assertion (or specific root entities within it) from private WM to ' +
        'Shared Working Memory so teammates see it. Omit `entities` to ' +
        'promote every root entity.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        entities: z
          .array(z.string())
          .optional()
          .describe(
            'Root entity URIs to promote. Omit to promote all roots.',
          ),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, entities, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      // Provided entities must be a non-empty array of URIs; omitted means
      // "promote all roots" (daemon-side default).
      if (entities !== undefined && entities.length === 0) {
        return errResult(
          '"entities" must be omitted or a non-empty array of root entity URIs.',
        );
      }
      try {
        await client.promoteAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
          // mcp-dkg's existing `promoteAssertion` requires an `entities`
          // array; pass an empty array when omitting so the daemon receives
          // its default-promotion sentinel (matches adapter behaviour).
          entities: entities ?? [],
        });
        const scope = entities && entities.length > 0
          ? `${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`
          : 'all root entities';
        return ok(`Promoted ${scope} from assertion '${name}' (project '${pid}') to SWM.`);
      } catch (e) {
        return errResult(`Failed to promote assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_discard ───────────────────────────────────────
  server.registerTool(
    'dkg_assertion_discard',
    {
      title: 'Discard Assertion',
      description:
        'Discard a Working Memory assertion without promoting it. Idempotent — ' +
        'no-op on a missing assertion. Use before re-writing an assertion ' +
        'whose name you want to keep stable but whose contents you want to ' +
        '*replace* rather than *merge*.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        await client.discardAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        return ok(`Discarded assertion '${name}' from project '${pid}'.`);
      } catch (e) {
        return errResult(`Failed to discard assertion: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_assertion_query ─────────────────────────────────────────
  server.registerTool(
    'dkg_assertion_query',
    {
      title: 'Dump Assertion Quads',
      description:
        'Return every quad in a Working Memory assertion. Not a SPARQL ' +
        'endpoint — for ad-hoc filtering use `dkg_query` with ' +
        '`view: "working-memory"`. The canonical introspection step for the ' +
        '`assertion_create + assertion_write + assertion_promote` round-trip.',
      inputSchema: {
        name: z.string().describe('Existing assertion name'),
        projectId: z.string().optional(),
        subGraphName: z.string().optional(),
      },
    },
    async ({ name, projectId, subGraphName }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();
      try {
        const result = await client.queryAssertion({
          contextGraphId: pid,
          assertionName: name,
          subGraphName,
        });
        const header = `Assertion '${name}' (project '${pid}'): ${result.count} quad(s).`;
        if (result.count === 0) return ok(header);
        // Render quads as compact JSON; keeps the wire shape obvious for
        // agents that want to round-trip into a write.
        const body = JSON.stringify(result.quads, null, 2);
        return ok(`${header}\n\n\`\`\`json\n${body}\n\`\`\``);
      } catch (e) {
        return errResult(`Failed to query assertion: ${formatError(e)}`);
      }
    },
  );
}
