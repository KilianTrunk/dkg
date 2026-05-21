import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../../../src/daemon/routes/context.js';
import type { RoutePlugin } from '../../../src/daemon/plugin-api.js';
import { handlePluginRoutes } from '../../../src/daemon/routes/plugins.js';

interface FakeRes {
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
  writeHead: (status: number, headers?: Record<string, string | number | string[]>) => FakeRes;
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      if (res.headersSent) {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      }
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      res.headersSent = true;
      return res;
    },
    write(chunk: string) {
      if (!res.headersSent) res.headersSent = true;
      res.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') res.body += chunk;
      if (!res.headersSent) res.headersSent = true;
      res.writableEnded = true;
    },
    setHeader(k, v) { res.headers[k] = v; },
    getHeader(k) { return res.headers[k] as string | undefined; },
  };
  return res;
}

function makeCtx(routePlugins: RoutePlugin[], res = makeRes()): {
  ctx: RequestContext;
  res: FakeRes;
} {
  const ctx = {
    req: {} as never,
    res: res as unknown as ServerResponse,
    routePlugins,
    path: '/api/test',
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('handlePluginRoutes', () => {
  it('returns without writing when routePlugins is empty', async () => {
    const { ctx, res } = makeCtx([]);
    await handlePluginRoutes(ctx);
    expect(res.writableEnded).toBe(false);
    expect(res.body).toBe('');
  });

  it('stops at the first plugin that claims the request by writing', async () => {
    const calls: string[] = [];
    const first: RoutePlugin = {
      name: 'first',
      handle(c) {
        calls.push('first');
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.end('{"ok":true}');
      },
    };
    const second: RoutePlugin = {
      name: 'second',
      handle() {
        calls.push('second');
      },
    };
    const { ctx, res } = makeCtx([first, second]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['first']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it('returns a 500 PluginError when a plugin throws and stops the chain', async () => {
    const calls: string[] = [];
    const thrower: RoutePlugin = {
      name: 'boom',
      handle() {
        calls.push('boom');
        throw new Error('intentional');
      },
    };
    const next: RoutePlugin = {
      name: 'next',
      handle() {
        calls.push('next');
      },
    };
    const { ctx, res } = makeCtx([thrower, next]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['boom']);
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      error: 'PluginError',
      plugin: 'boom',
      message: 'intentional',
    });
  });

  it('does not emit a second response when a plugin throws after starting the response', async () => {
    const calls: string[] = [];
    const partialThenThrow: RoutePlugin = {
      name: 'half-written',
      handle(c) {
        calls.push('half-written');
        // Plugin has already started the response (headersSent=true) but
        // has not finished (writableEnded=false), then throws.
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.write('{"partial":');
        throw new Error('mid-stream failure');
      },
    };
    const next: RoutePlugin = {
      name: 'next',
      handle() {
        calls.push('next');
      },
    };
    const { ctx, res } = makeCtx([partialThenThrow, next]);
    await expect(handlePluginRoutes(ctx)).resolves.toBeUndefined();
    expect(calls).toEqual(['half-written']);
    // Status must remain the one the plugin already wrote, not be overwritten
    // by an attempted 500.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('logs the plugin name and underlying error when a plugin throws', async () => {
    // Regression for codex PR review #593: the dispatcher returns a 500 to
    // the client when a plugin throws, but operators also need a daemon-side
    // log line with the plugin name + error so they can diagnose failures.
    // Without it, a misbehaving plugin shows up as opaque 500s in the client
    // log with no daemon-side breadcrumb.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const thrower: RoutePlugin = {
        name: 'logging-test-plugin',
        handle() {
          throw new Error('boom-message');
        },
      };
      const { ctx } = makeCtx([thrower]);
      await handlePluginRoutes(ctx);

      expect(errorSpy).toHaveBeenCalled();
      const joined = errorSpy.mock.calls
        .map((args) =>
          args
            .map((a) =>
              typeof a === 'string'
                ? a
                : a instanceof Error
                ? a.stack ?? a.message
                : JSON.stringify(a),
            )
            .join(' '),
        )
        .join('\n');
      expect(joined).toContain('logging-test-plugin');
      expect(joined).toContain('boom-message');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('ends the half-written response when a plugin throws after writeHead', async () => {
    // Regression for codex PR review: when a plugin calls writeHead/write and
    // then throws, the catch must terminate the response (res.end()) so that
    // handleRequest's `if (res.writableEnded) return;` short-circuit fires.
    // If we leave writableEnded=false, the chain falls through to the trailing
    // jsonResponse(res, 404, ...) which throws ERR_HTTP_HEADERS_SENT and the
    // client is left with a half-written response.
    const partialThenThrow: RoutePlugin = {
      name: 'half-written-terminator',
      handle(c) {
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.write('{"partial":');
        throw new Error('mid-stream failure');
      },
    };
    const { ctx, res } = makeCtx([partialThenThrow]);
    await handlePluginRoutes(ctx);
    expect(res.headersSent).toBe(true);
    expect(res.writableEnded).toBe(true);
    // Status and body were claimed by the plugin and must not be overwritten.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('falls through to the next plugin when one returns without writing', async () => {
    const calls: string[] = [];
    const skip: RoutePlugin = {
      name: 'skip',
      handle() {
        calls.push('skip');
      },
    };
    const handler: RoutePlugin = {
      name: 'handler',
      handle(c) {
        calls.push('handler');
        c.res.writeHead(201);
        c.res.end('done');
      },
    };
    const { ctx, res } = makeCtx([skip, handler]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['skip', 'handler']);
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('done');
  });
});
