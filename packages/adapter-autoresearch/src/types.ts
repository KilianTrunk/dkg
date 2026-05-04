/**
 * Public type contract: what an adapter consumer (the MCP server) supplies
 * to `registerTools(server, client, config)`. Two structural interfaces
 * keep this package free of a hard dependency on `@origintrail-official/dkg-mcp`'s
 * concrete types — any client / config implementing these shapes works.
 */

/**
 * Subset of mcp-dkg's `DkgClient.query` the adapter actually exercises.
 * mcp-dkg's `DkgClient` (`packages/mcp-dkg/src/client.ts`) is a superset
 * of this shape — passing `new DkgClient(...)` satisfies the type via
 * structural compatibility, no dependency lift required.
 *
 * The legacy positional `query(sparql, contextGraphId?)` shape from the
 * retired `mcp-server` is gone. mcp-dkg uses the object-arg shape
 * everywhere; the adapter adopts it.
 */
export interface DkgClientLike {
  query(args: {
    sparql: string;
    contextGraphId?: string;
  }): Promise<{ bindings?: Array<Record<string, unknown>> }>;
}

/**
 * Subset of mcp-dkg's `DkgConfig` the adapter reads for daemon HTTP
 * routes that aren't on `DkgClient`'s method surface
 * (`/api/shared-memory/{write,publish}`, `/api/context-graph/create`,
 * `/api/subscribe`). The adapter ships a small private fetch helper that
 * uses these to talk to the already-running daemon.
 */
export interface DkgConfigLike {
  api: string;
  token: string;
}

/** A single autoresearch experiment record as written to the DKG. */
export interface Experiment {
  valBpb: number;
  peakVramMb: number;
  status: 'keep' | 'discard' | 'crash';
  description: string;
  commitHash?: string;
  codeDiff?: string;
  trainingSeconds?: number;
  totalTokensM?: number;
  numParamsM?: number;
  mfuPercent?: number;
  depth?: number;
  numSteps?: number;
  platform?: string;
  agentDid?: string;
  runTag?: string;
  parentExperiment?: string;
}

/** Experiment plus DKG-assigned identity. */
export interface ExperimentRecord extends Experiment {
  uri: string;
  timestamp: string;
}
