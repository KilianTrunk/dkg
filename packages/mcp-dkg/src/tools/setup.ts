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
  // Description string opens with the audit v1.1 verbatim-locked
  // reconciliation note (SKILL.md §6 line 297 user-vs-internal
  // terminology). The follow-up sentence about slug derivation is
  // mcp-dkg-specific UX ergonomics.
  server.registerTool(
    'dkg_context_graph_create',
    {
      title: 'Create Context Graph',
      description:
        "Create a context graph (called 'projects' in the DKG node UI). " +
        "Returns the new CG's id, name, and on-chain registration status. " +
        'Call `dkg_list_context_graphs` first to see if one with this name ' +
        'already exists. The `id` slug is auto-derived from `name` when ' +
        'omitted (e.g. "My Research" → "my-research"); slugs must match ' +
        '/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.',
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
        'authored CG. Defaults to also syncing Shared Working Memory; ' +
        'pass `includeSharedMemory: false` to skip SWM sync (saves ' +
        'bandwidth when you only need on-chain data).',
      inputSchema: {
        contextGraphId: z.string().min(1).describe('Context graph id (e.g. "my-research")'),
        includeSharedMemory: z
          .boolean()
          .optional()
          .default(true)
          .describe('Also sync SWM. Default true.'),
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
  // Strict create per parity-analyst's audit v1.1 self-correction
  // (2026-05-04). Three independent signals all point to strict:
  //   - SKILL.md is silent on idempotency
  //   - the daemon route 409s on duplicate sub-graph name
  //   - the OpenClaw adapter exposes the strict path
  // mcp-dkg's `client.ensureSubGraph` is a CLIENT-side wrapper that
  // catches the 409 for internal use only (the now-dropped sugared
  // writes were its sole consumer). It does NOT belong on the public
  // tool surface — agents should reach for either "create-strict"
  // (let me know if it's there) or "list-then-decide", not silent-
  // success-or-409. Strict is the honest contract.
  server.registerTool(
    'dkg_sub_graph_create',
    {
      title: 'Create Sub-graph',
      description:
        'Create a named sub-graph inside a context graph (an optional ' +
        'partition for scoped assertions, e.g. "code", "tasks", "meta"). ' +
        'Strict create — the daemon returns an error if a sub-graph with ' +
        'this name already exists. Names must be lowercase letters, ' +
        'digits, and hyphens, and must not start with `_`.',
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
