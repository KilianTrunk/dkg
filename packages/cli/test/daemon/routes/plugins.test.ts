import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
  // Throw-path tests would otherwise dump real stack traces from the dispatcher's `console.error` breadcrumb.
  // Stub per test; the "logs the plugin name" test reads `errorSpy.mock.calls` directly.
  let errorSpy: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

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
        // headersSent=true, writableEnded=false, then throws.
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
    // Status stays as the plugin wrote it — no overwrite-attempt 500.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('logs the plugin name and underlying error when a plugin throws', async () => {
    // Operators need a daemon-side breadcrumb (plugin name + error) — the client's 500 only carries the message.
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
  });

  it('ends the half-written response when a plugin throws after writeHead', async () => {
    // catch must call res.end() so writableEnded short-circuits; else the trailing 404 attempts a second writeHead.
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
    // Status / body claimed by the plugin — must not be overwritten.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('leaves a streaming response open when a plugin writes headers and returns without calling end', async () => {
    // Dispatcher must NOT call end() after normal return — `headersSent && !writableEnded` is intentional streaming (SSE etc.).
    const calls: string[] = [];
    const streamingPlugin: RoutePlugin = {
      name: 'sse-stream',
      handle(c) {
        calls.push('sse-stream');
        c.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        c.res.write('event: connected\ndata: {}\n\n');
        // No end() — async writer would keep emitting via setInterval / event subscription.
      },
    };
    const followOn: RoutePlugin = {
      name: 'follow-on',
      handle() {
        calls.push('follow-on');
      },
    };
    const { ctx, res } = makeCtx([streamingPlugin, followOn]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['sse-stream']);
    expect(res.headersSent).toBe(true);
    // Stream stays alive — dispatcher never called end().
    expect(res.writableEnded).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('event: connected\ndata: {}\n\n');
    // Follow-on must not run — top-of-iteration `headersSent` check stops the chain.
    expect(calls).not.toContain('follow-on');
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
