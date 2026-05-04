/**
 * Context-graph and sub-graph setup tools.
 *
 * Wave-2 P0 + P2 adds (audit §7 items 1, 8, 9). These three tools cover
 * the SKILL.md Quickstart Step 1 ("create a project") and Step 3 ("join
 * a peer-shared CG") plus the sub-graph staging primitive that the
 * other write tools previously consumed indirectly via
 * `client.ensureSubGraph`.
 *
 * Naming: `dkg_context_graph_create` matches both SKILL.md §3 Step 1
 * and the OpenClaw adapter (`DkgNodePlugin.ts:1924`). Description
 * includes the "(also called 'projects' in the DKG node UI)" UX note
 * per the team-lead direction on tool-surface UI/canonical
 * reconciliation, mirroring the same pattern locked on
 * `dkg_list_context_graphs` in the rename pass.
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

/**
 * Slugify a human-readable CG name into a URL-safe id (e.g. "My
 * Research Context Graph" → "my-research-context-graph"). Matches the
 * adapter's `slugify` at `DkgNodePlugin.ts:3460-3464`.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VALID_CG_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function registerSetupTools(
  server: McpServer,
  client: DkgClient,
  _config: DkgConfig,
): void {
  // ── dkg_context_graph_create ────────────────────────────────────
  server.registerTool(
    'dkg_context_graph_create',
    {
      title: 'Create Context Graph',
      description:
        'Create a new context graph on the DKG node (also called a ' +
        '"project" in the DKG node UI). A context graph is a scoped ' +
        'knowledge domain that organises published assertions. Call ' +
        '`dkg_list_context_graphs` first to see if one with this name ' +
        'already exists. The `id` slug is auto-derived from `name` if ' +
        'omitted (e.g. "My Research" → "my-research"); slugs must be ' +
        'lowercase letters, digits, and hyphens, and start and end with ' +
        'a letter or digit.',
      inputSchema: {
        name: z.string().min(1).describe('Human-readable name (e.g. "My Research Context Graph")'),
        description: z.string().optional().describe('Optional description of the CG\'s purpose'),
        id: z
          .string()
          .optional()
          .describe(
            'Optional explicit slug. Auto-derived from `name` when omitted. ' +
              'Must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.',
          ),
      },
    },
    async ({ name, description, id }): Promise<ToolResult> => {
      const trimmedName = name.trim();
      if (!trimmedName) return errResult('"name" is required.');
      const explicitId = id?.trim();
      const cgId = explicitId || slugify(trimmedName);
      if (!cgId) {
        return errResult(
          'Could not derive a valid context graph ID from the name. Provide an explicit `id`.',
        );
      }
      if (!VALID_CG_ID_RE.test(cgId)) {
        return errResult(
          `Invalid context graph ID "${cgId}". Use lowercase letters, numbers, and hyphens (e.g. "my-research"). Must start and end with a letter or digit.`,
        );
      }
      try {
        const result = await client.createContextGraph({
          id: cgId,
          name: trimmedName,
          description: description?.trim() || undefined,
        });
        return ok(
          `Created context graph '${cgId}'.\n` +
            `URI: ${result.uri}\n` +
            `Name: ${trimmedName}` +
            (description ? `\nDescription: ${description}` : ''),
        );
      } catch (e) {
        return errResult(`Failed to create context graph: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_subscribe ───────────────────────────────────────────────
  server.registerTool(
    'dkg_subscribe',
    {
      title: 'Subscribe to Context Graph',
      description:
        'Subscribe to a context graph so its data syncs locally from ' +
        'peers. Call once before querying or publishing a remotely-' +
        'authored CG. By default also syncs Shared Working Memory; pass ' +
        '`includeSharedMemory: false` to skip SWM sync (saves bandwidth ' +
        'when you only need on-chain data).',
      inputSchema: {
        contextGraphId: z.string().min(1).describe('Context graph id (e.g. "my-research")'),
        includeSharedMemory: z
          .boolean()
          .optional()
          .describe('Also sync SWM. Daemon default is true.'),
      },
    },
    async ({ contextGraphId, includeSharedMemory }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      try {
        const result = await client.subscribe({
          contextGraphId: cgId,
          includeSharedMemory,
        });
        const catchup = result.catchup
          ? `\nCatchup job: ${result.catchup.jobId} (status: ${result.catchup.status}, includeSharedMemory: ${result.catchup.includeSharedMemory})`
          : '';
        return ok(`Subscribed to '${result.subscribed}'.${catchup}`);
      } catch (e) {
        return errResult(`Failed to subscribe: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_sub_graph_create ────────────────────────────────────────
  // Strict create (mirrors the adapter's `dkg_sub_graph_create` at
  // `DkgNodePlugin.ts:2358-2371`). For idempotent "ensure exists"
  // semantics during sugared writes, mcp-dkg's `client.ensureSubGraph`
  // handles the duplicate-name 409 internally; this tool exposes the
  // strict path so agents can pre-stage structure with a clear failure
  // mode.
  server.registerTool(
    'dkg_sub_graph_create',
    {
      title: 'Create Sub-graph',
      description:
        'Create a named sub-graph inside a context graph (an optional ' +
        'partition for scoped assertions, e.g. "code", "tasks", "meta"). ' +
        'Strict create — the daemon errors if a sub-graph with this ' +
        'name already exists. Names must be lowercase letters, digits, ' +
        'and hyphens, and must not start with `_`.',
      inputSchema: {
        contextGraphId: z.string().min(1).describe('Parent context graph id'),
        subGraphName: z
          .string()
          .min(1)
          .describe('Sub-graph name (lowercase letters, digits, hyphens; not starting with "_")'),
      },
    },
    async ({ contextGraphId, subGraphName }): Promise<ToolResult> => {
      const cgId = contextGraphId.trim();
      const sgName = subGraphName.trim();
      if (!cgId) return errResult('"contextGraphId" is required.');
      if (!sgName) return errResult('"subGraphName" is required.');
      try {
        const result = await client.createSubGraph({
          contextGraphId: cgId,
          subGraphName: sgName,
        });
        return ok(`Created sub-graph '${result.created}' in '${result.contextGraphId}'.`);
      } catch (e) {
        return errResult(`Failed to create sub-graph: ${formatError(e)}`);
      }
    },
  );
}
