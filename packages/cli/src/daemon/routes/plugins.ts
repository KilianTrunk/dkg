// Per-request dispatcher for route plugins. `headersSent` claims the request (covers streaming);
// throws → 500 PluginError before response start, else end the now-broken stream.

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
      // Daemon-side breadcrumb — the client's 500 only carries the message, not the stack.
      console.error(`[route-plugin:${plugin.name}] handler threw:`, err);
      if (!responseStarted(ctx.res)) {
        jsonResponse(ctx.res, 500, {
          error: 'PluginError',
          plugin: plugin.name,
          message,
        });
      } else if (!ctx.res.writableEnded) {
        // Headers already out — can't emit a clean 500; just end the stream so the client doesn't hang.
        ctx.res.end();
      }
      return;
    }
    // Normal return: do NOT mutate res — `writeHead` without `end` is intentional streaming (SSE etc.).
  }
}
