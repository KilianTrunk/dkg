// daemon/routes/plugins.ts
//
// Per-request dispatcher for fork-authored route plugins. Iterates
// `ctx.routePlugins` in config order, claims via `res.writableEnded`,
// and converts any plugin throw into a 500 PluginError response.

import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

export async function handlePluginRoutes(ctx: RequestContext): Promise<void> {
  for (const plugin of ctx.routePlugins) {
    if (ctx.res.writableEnded) return;
    try {
      await plugin.handle(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!ctx.res.writableEnded) {
        jsonResponse(ctx.res, 500, {
          error: 'PluginError',
          plugin: plugin.name,
          message,
        });
      }
      return;
    }
  }
}
