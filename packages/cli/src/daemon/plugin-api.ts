// Public surface for route plugins. The only module a plugin imports from; breaking changes are semver-major.

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
