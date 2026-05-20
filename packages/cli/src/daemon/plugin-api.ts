// Public surface for fork-authored "route plugins". The only module a
// plugin package imports from. Re-exports the `RequestContext` type
// (the bag every daemon route handler receives) and a small set of
// HTTP helpers so plugin code looks like daemon code. The `RoutePlugin`
// interface is the contract every fork plugin implements.
//
// Once shipped, breaking changes to the symbols here are semver-major.

export type { RequestContext } from './routes/context.js';

export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

import type { RequestContext } from './routes/context.js';

export interface RoutePlugin {
  name: string;
  handle(ctx: RequestContext): Promise<void> | void;
}
