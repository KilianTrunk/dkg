// daemon/routes/plugins.ts
//
// Per-request dispatcher for fork-authored route plugins. Iterates
// `ctx.routePlugins` in config order, claims via `res.writableEnded`,
// and converts any plugin throw into a 500 PluginError response.

import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

function responseStarted(res: RequestContext['res']): boolean {
  return res.writableEnded || res.headersSent;
}

export async function handlePluginRoutes(ctx: RequestContext): Promise<void> {
  for (const plugin of ctx.routePlugins) {
    if (responseStarted(ctx.res)) return;
    try {
      await plugin.handle(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Operators need a daemon-side breadcrumb when a plugin throws — the
      // 500 sent to the client only carries the message, not the stack.
      // Use console.error so the daemon stdout/stderr capture (devnet
      // daemon.log, systemd journal, etc.) records the failure with the
      // plugin name for correlation.
      console.error(`[route-plugin:${plugin.name}] handler threw:`, err);
      if (!responseStarted(ctx.res)) {
        jsonResponse(ctx.res, 500, {
          error: 'PluginError',
          plugin: plugin.name,
          message,
        });
      } else if (!ctx.res.writableEnded) {
        // Plugin already started the response (headersSent=true) and then
        // threw. We can't emit a clean 500 over headers that are already
        // out, but we MUST terminate the response — otherwise handleRequest's
        // `if (res.writableEnded) return;` short-circuit doesn't fire and
        // the chain falls through to the trailing 404, which would attempt
        // a second writeHead and crash with ERR_HTTP_HEADERS_SENT.
        ctx.res.end();
      }
      return;
    }
  }
}
