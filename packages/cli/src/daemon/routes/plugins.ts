// daemon/routes/plugins.ts
//
// Per-request dispatcher for fork-authored route plugins. Iterates
// `ctx.routePlugins` in config order. A request is considered claimed
// once `res.headersSent` is true — that covers both fully-ended responses
// (`writableEnded`) AND mid-stream plugins (SSE, source.pipe(res), ...).
// `handleRequest`'s short-circuit before the trailing 404 mirrors this
// (`writableEnded || headersSent`) so streaming responses are preserved
// and a second `writeHead` is never attempted. Plugin throws become a
// 500 PluginError when no response has been started; if headers were
// already sent the dispatcher just ends the (now-broken) stream so the
// chain's short-circuit fires cleanly.

import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

function responseStarted(res: RequestContext['res']): boolean {
  return res.writableEnded || res.headersSent;
}

export async function handlePluginRoutes(ctx: RequestContext): Promise<void> {
  for (const plugin of ctx.routePlugins) {
    // Top-of-iteration short-circuit: if any previous plugin already
    // claimed the request (either fully ended OR started streaming), stop.
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
        // threw. The stream is broken — terminate it so the client doesn't
        // hang. We can't emit a clean 500 over headers that are already out.
        ctx.res.end();
      }
      return;
    }
    // Plugin returned normally. Do NOT mutate the response here — if the
    // plugin called writeHead/write but not end(), it is intentionally
    // streaming (SSE, source.pipe(res), chunked transfer, ...). The chain's
    // short-circuit in handleRequest treats `headersSent` as "claimed"; the
    // dispatcher's only job is to stop iterating and return.
  }
}
