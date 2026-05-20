import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../../../src/daemon/routes/context.js';
import type { RoutePlugin } from '../../../src/daemon/plugin-api.js';
import { handlePluginRoutes } from '../../../src/daemon/routes/plugins.js';

interface FakeRes {
  writableEnded: boolean;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
  writeHead: (status: number, headers?: Record<string, string | number | string[]>) => FakeRes;
  end: (chunk?: string) => void;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') res.body = chunk;
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
});
