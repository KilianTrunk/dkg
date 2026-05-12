#!/usr/bin/env node

const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createInterface } = require('node:readline');

const REPO_ROOT = resolve(__dirname, '../../..');
const DEFAULT_CONTEXT_GRAPH_ID = 'devnet-test';
const DEFAULT_NAMESPACE = 'swm-triple-volume';
const DEFAULT_PREDICATE_BASE = 'urn:dkg:benchmark:swm-triple-volume:p';
const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();
const FAILURE_PATTERNS = [
  { name: 'oxigraphWasmUnreachable', text: 'RuntimeError: unreachable' },
  { name: 'oxigraphTableIndexOutOfBounds', text: 'table index is out of bounds' },
  { name: 'gossipsubInvalidDataLength', text: 'InvalidDataLengthError' },
  { name: 'gossipsubMessageTooLong', text: 'Message length too long' },
  { name: 'heapOutOfMemory', text: 'JavaScript heap out of memory' },
];

function usage() {
  return `Usage: pnpm --filter @origintrail-official/dkg benchmark:swm-triple-volume -- [options]

Writes many small public SWM triples to a running multi-node devnet and verifies
that every node can count the replicated triple volume. This stresses Oxigraph
triple/index volume rather than large literal byte externalization.

Options:
  --ports <list>                    Comma-separated daemon API ports. Default derives from --api-port-base and --nodes.
  --api-port-base <port>            First daemon API port when --ports is omitted. Default: 9201.
  --nodes <count>                   Node count when --ports is omitted. Default: 5.
  --context-graph-id <id>           Context graph to write/query. Default: devnet-test.
  --target-mib-per-node <MiB>       Approximate serialized N-Quad bytes to write per node. Default: 1024.
  --target-gib-per-node <GiB>       Same target in GiB; overrides --target-mib-per-node.
  --triples-per-write <count>       Small triples per /api/shared-memory/write request. Default: 1000.
  --object-bytes <bytes>            Lexical bytes for generated literal objects. Default: 64.
  --predicate-count <count>         Number of predicates to rotate through. Default: 8.
  --write-concurrency <count>       Concurrent write requests. Default: 1.
  --replication-timeout-ms <ms>     Time to wait for every node to see every triple. Default: 1800000.
  --poll-interval-ms <ms>           Replication polling interval. Default: 10000.
  --request-timeout-ms <ms>         Per-request timeout. Default: 180000.
  --query-timeout-ms <ms>           Per-query timeout. Default: 180000.
  --auth-token <token>              Bearer token. Also reads DKG_BENCH_AUTH_TOKEN, DKG_AUTH_TOKEN, DKG_TOKEN, DEVNET_TOKEN, or DKG_AUTH.
  --auth-token-file <path>          File containing bearer token. Defaults to DEVNET_DIR/node1/auth.token, if present.
  --no-auth                         Send requests without Authorization.
  --run-id <id>                     Stable run id. Default: timestamp + random suffix.
  --namespace <name>                Subject namespace segment. Default: swm-triple-volume.
  --predicate-base <iri>            Predicate IRI prefix. Default: ${DEFAULT_PREDICATE_BASE}.
  --progress-every <count>          Emit a progress line every N writes. Default: 25.
  --output <path>                   Write the final JSON result to a file.
  --skip-write                      Only verify an existing run id.
  --devnet-dir <path>               Devnet directory for appended log scanning. Default: DEVNET_DIR or repo .devnet.
  --scan-logs / --no-scan-logs      Scan appended daemon logs for known failure signatures. Default: scan when devnet dir exists.
  --quiet                           Suppress progress events on stderr.
  -h, --help                        Show this help.

Example 1 GiB per node:
  pnpm bench:swm-triple-volume -- \\
    --ports 20101,20102,20103,20104,20105 \\
    --target-gib-per-node 1 \\
    --triples-per-write 1000 \\
    --write-concurrency 5 \\
    --output bench/results/swm-triple-volume-1gib-per-node.json`;
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function parsePositiveNumber(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value ${JSON.stringify(value)}`);
}

function parsePorts(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const ports = String(value)
    .split(',')
    .map((part) => parsePositiveInteger('port', part.trim()));
  return ports.length > 0 ? ports : undefined;
}

function nextArgValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

function readAuthTokenFile(path) {
  const text = readFileSync(path, 'utf8');
  const tokens = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => line.split(/\s+/))
    .filter(Boolean);
  return tokens.at(-1);
}

function resolveAuthToken(options, env, devnetDir) {
  if (options.noAuth) return undefined;
  const inline = options.authToken
    ?? env.DKG_BENCH_AUTH_TOKEN
    ?? env.DKG_AUTH_TOKEN
    ?? env.DKG_TOKEN
    ?? env.DEVNET_TOKEN
    ?? env.DKG_AUTH;
  if (inline) return inline;

  const tokenFile = options.authTokenFile
    ?? (env.DKG_BENCH_AUTH_TOKEN_FILE ? resolveInputPath(env.DKG_BENCH_AUTH_TOKEN_FILE) : undefined)
    ?? (devnetDir ? join(devnetDir, 'node1', 'auth.token') : undefined);
  if (tokenFile && existsSync(tokenFile)) return readAuthTokenFile(tokenFile);
  return undefined;
}

function parseBenchmarkArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--') continue;
    if (raw === '-h' || raw === '--help') {
      options.help = true;
      continue;
    }
    if (raw === '--no-auth') {
      options.noAuth = true;
      continue;
    }
    if (raw === '--skip-write') {
      options.skipWrite = true;
      continue;
    }
    if (raw === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (raw === '--scan-logs') {
      options.scanLogs = true;
      continue;
    }
    if (raw === '--no-scan-logs') {
      options.scanLogs = false;
      continue;
    }
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument ${JSON.stringify(raw)}`);

    const eqIndex = raw.indexOf('=');
    const name = eqIndex >= 0 ? raw.slice(2, eqIndex) : raw.slice(2);
    const inlineValue = eqIndex >= 0 ? raw.slice(eqIndex + 1) : undefined;
    const { value, nextIndex } = nextArgValue(argv, index, `--${name}`, inlineValue);
    index = nextIndex;

    switch (name) {
      case 'ports':
        options.ports = parsePorts(value);
        break;
      case 'api-port-base':
        options.apiPortBase = parsePositiveInteger('--api-port-base', value);
        break;
      case 'nodes':
        options.nodes = parsePositiveInteger('--nodes', value);
        break;
      case 'context-graph-id':
        options.contextGraphId = value;
        break;
      case 'target-mib-per-node':
        options.targetMiBPerNode = parsePositiveNumber('--target-mib-per-node', value);
        break;
      case 'target-gib-per-node':
        options.targetMiBPerNode = parsePositiveNumber('--target-gib-per-node', value) * 1024;
        break;
      case 'triples-per-write':
        options.triplesPerWrite = parsePositiveInteger('--triples-per-write', value);
        break;
      case 'object-bytes':
        options.objectBytes = parsePositiveInteger('--object-bytes', value);
        break;
      case 'predicate-count':
        options.predicateCount = parsePositiveInteger('--predicate-count', value);
        break;
      case 'write-concurrency':
        options.writeConcurrency = parsePositiveInteger('--write-concurrency', value);
        break;
      case 'replication-timeout-ms':
        options.replicationTimeoutMs = parsePositiveInteger('--replication-timeout-ms', value);
        break;
      case 'poll-interval-ms':
        options.pollIntervalMs = parsePositiveInteger('--poll-interval-ms', value);
        break;
      case 'request-timeout-ms':
        options.requestTimeoutMs = parsePositiveInteger('--request-timeout-ms', value);
        break;
      case 'query-timeout-ms':
        options.queryTimeoutMs = parsePositiveInteger('--query-timeout-ms', value);
        break;
      case 'auth-token':
        options.authToken = value;
        break;
      case 'auth-token-file':
        options.authTokenFile = resolveInputPath(value);
        break;
      case 'run-id':
        options.runId = value;
        break;
      case 'namespace':
        options.namespace = value;
        break;
      case 'predicate-base':
        options.predicateBase = value;
        break;
      case 'progress-every':
        options.progressEvery = parsePositiveInteger('--progress-every', value);
        break;
      case 'output':
        options.output = resolveInputPath(value);
        break;
      case 'devnet-dir':
        options.devnetDir = resolveInputPath(value);
        break;
      default:
        throw new Error(`Unknown option --${name}`);
    }
  }

  const envPorts = parsePorts(env.DKG_BENCH_SWM_TRIPLES_PORTS ?? env.DKG_BENCH_SWM_PORTS);
  const devnetDir = options.devnetDir
    ?? (env.DKG_BENCH_SWM_TRIPLES_DEVNET_DIR ? resolveInputPath(env.DKG_BENCH_SWM_TRIPLES_DEVNET_DIR) : undefined)
    ?? (env.DKG_BENCH_SWM_DEVNET_DIR ? resolveInputPath(env.DKG_BENCH_SWM_DEVNET_DIR) : undefined)
    ?? (env.DEVNET_DIR ? resolveInputPath(env.DEVNET_DIR) : undefined)
    ?? join(REPO_ROOT, '.devnet');
  const nodes = options.nodes
    ?? (env.DKG_BENCH_SWM_TRIPLES_NODES
      ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_NODES', env.DKG_BENCH_SWM_TRIPLES_NODES)
      : (env.DKG_BENCH_SWM_NODES ? parsePositiveInteger('DKG_BENCH_SWM_NODES', env.DKG_BENCH_SWM_NODES) : 5));
  const apiPortBase = options.apiPortBase
    ?? (env.DKG_BENCH_SWM_TRIPLES_API_PORT_BASE
      ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_API_PORT_BASE', env.DKG_BENCH_SWM_TRIPLES_API_PORT_BASE)
      : (env.DKG_BENCH_SWM_API_PORT_BASE
        ? parsePositiveInteger('DKG_BENCH_SWM_API_PORT_BASE', env.DKG_BENCH_SWM_API_PORT_BASE)
        : (env.API_PORT_BASE ? parsePositiveInteger('API_PORT_BASE', env.API_PORT_BASE) : 9201)));
  const ports = options.ports ?? envPorts ?? Array.from({ length: nodes }, (_, index) => apiPortBase + index);
  const noAuth = options.noAuth ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_NO_AUTH ?? env.DKG_BENCH_SWM_NO_AUTH ?? env.DEVNET_NO_AUTH, false);
  const targetMiBPerNode = options.targetMiBPerNode
    ?? (env.DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE
      ? parsePositiveNumber('DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE', env.DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE) * 1024
      : (env.DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE
        ? parsePositiveNumber('DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE', env.DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE)
        : 1024));

  const config = {
    help: Boolean(options.help),
    contextGraphId: options.contextGraphId ?? env.DKG_BENCH_SWM_TRIPLES_CONTEXT_GRAPH_ID ?? env.DKG_BENCH_SWM_CONTEXT_GRAPH_ID ?? DEFAULT_CONTEXT_GRAPH_ID,
    ports,
    nodes: ports.length,
    apiPortBase,
    targetMiBPerNode,
    triplesPerWrite: options.triplesPerWrite
      ?? (env.DKG_BENCH_SWM_TRIPLES_PER_WRITE ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PER_WRITE', env.DKG_BENCH_SWM_TRIPLES_PER_WRITE) : 1000),
    objectBytes: options.objectBytes
      ?? (env.DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES', env.DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES) : 64),
    predicateCount: options.predicateCount
      ?? (env.DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT', env.DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT) : 8),
    writeConcurrency: options.writeConcurrency
      ?? (env.DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY', env.DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY)
        : 1),
    replicationTimeoutMs: options.replicationTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS)
        : 1_800_000),
    pollIntervalMs: options.pollIntervalMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS', env.DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS)
        : 10_000),
    requestTimeoutMs: options.requestTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS)
        : 180_000),
    queryTimeoutMs: options.queryTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS)
        : 180_000),
    runId: options.runId ?? env.DKG_BENCH_SWM_TRIPLES_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    namespace: options.namespace ?? env.DKG_BENCH_SWM_TRIPLES_NAMESPACE ?? DEFAULT_NAMESPACE,
    predicateBase: options.predicateBase ?? env.DKG_BENCH_SWM_TRIPLES_PREDICATE_BASE ?? DEFAULT_PREDICATE_BASE,
    progressEvery: options.progressEvery
      ?? (env.DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY', env.DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY) : 25),
    output: options.output ?? (env.DKG_BENCH_SWM_TRIPLES_OUTPUT ? resolveInputPath(env.DKG_BENCH_SWM_TRIPLES_OUTPUT) : undefined),
    skipWrite: options.skipWrite ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_SKIP_WRITE, false),
    noAuth,
    devnetDir,
    scanLogs: options.scanLogs ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_SCAN_LOGS ?? env.DKG_BENCH_SWM_SCAN_LOGS, existsSync(devnetDir)),
    quiet: options.quiet ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_QUIET ?? env.DKG_BENCH_SWM_QUIET, false),
  };
  config.authToken = resolveAuthToken({ ...options, noAuth }, env, devnetDir);
  return Object.freeze(config);
}

function resolveInputPath(value) {
  return isAbsolute(value) ? value : resolve(INVOCATION_CWD, value);
}

function bytesFromMiB(value) {
  return Math.round(value * 1024 * 1024);
}

function makeObjectLexical(runId, nodeNumber, writeNumber, tripleIndex, objectBytes) {
  const prefix = `r=${runId};n=${nodeNumber};w=${writeNumber};t=${tripleIndex};`;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (prefixBytes > objectBytes) {
    throw new Error(`Object prefix is ${prefixBytes} bytes, larger than requested ${objectBytes} bytes`);
  }
  const fillChar = String.fromCharCode(97 + ((nodeNumber + writeNumber + tripleIndex) % 26));
  return prefix + fillChar.repeat(objectBytes - prefixBytes);
}

function makeQuads(config, plan, nodeNumber, writeNumber, tripleCount = config.triplesPerWrite) {
  const root = `${plan.rootPrefix}node:${nodeNumber}:write:${writeNumber}`;
  const quads = [{
    subject: root,
    predicate: `${config.predicateBase}:root`,
    object: JSON.stringify(`root run=${config.runId} node=${nodeNumber} write=${writeNumber} triples=${tripleCount}`),
    graph: '',
  }];

  for (let index = 1; index < tripleCount; index += 1) {
    quads.push({
      subject: `${root}/.well-known/genid/t${index}`,
      predicate: `${config.predicateBase}:${index % config.predicateCount}`,
      object: JSON.stringify(makeObjectLexical(config.runId, nodeNumber, writeNumber, index, config.objectBytes)),
      graph: '',
    });
  }

  return quads;
}

function estimateQuadNQuadBytes(quad) {
  const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
  return Buffer.byteLength(`<${quad.subject}> <${quad.predicate}> ${object} .\n`, 'utf8');
}

function estimateQuadsNQuadBytes(quads) {
  return quads.reduce((sum, quad) => sum + estimateQuadNQuadBytes(quad), 0);
}

function buildBenchmarkPlan(config) {
  const targetBytesPerNode = bytesFromMiB(config.targetMiBPerNode);
  const sampleQuads = makeQuads(config, { rootPrefix: `urn:dkg:benchmark:${config.namespace}:sample:` }, 1, 1);
  const estimatedBytesPerWrite = estimateQuadsNQuadBytes(sampleQuads);
  const writesPerNode = Math.ceil(targetBytesPerNode / estimatedBytesPerWrite);
  const totalWrites = writesPerNode * config.ports.length;
  const triplesPerNode = writesPerNode * config.triplesPerWrite;
  const totalTriples = triplesPerNode * config.ports.length;
  const estimatedBytesPerNode = estimatedBytesPerWrite * writesPerNode;
  const totalEstimatedBytes = estimatedBytesPerNode * config.ports.length;
  const rootPrefix = `urn:dkg:benchmark:${config.namespace}:${config.runId}:`;
  const metadataGraph = `did:dkg:context-graph:${config.contextGraphId}/_shared_memory_meta`;
  return Object.freeze({
    targetBytesPerNode,
    targetMiBPerNode: Number((targetBytesPerNode / 1024 / 1024).toFixed(3)),
    estimatedBytesPerWrite,
    writesPerNode,
    totalWrites,
    triplesPerNode,
    totalTriples,
    estimatedBytesPerNode,
    estimatedMiBPerNode: Number((estimatedBytesPerNode / 1024 / 1024).toFixed(3)),
    totalEstimatedBytes,
    totalEstimatedMiB: Number((totalEstimatedBytes / 1024 / 1024).toFixed(3)),
    rootPrefix,
    metadataGraph,
  });
}

function buildWriteTasks(config, plan) {
  const tasks = [];
  for (let writeNumber = 1; writeNumber <= plan.writesPerNode; writeNumber += 1) {
    for (let nodeIndex = 0; nodeIndex < config.ports.length; nodeIndex += 1) {
      tasks.push({ nodeIndex, writeNumber });
    }
  }
  return tasks;
}

function sparqlString(value) {
  return JSON.stringify(String(value));
}

function bindingValue(result, name) {
  return result?.bindings?.[0]?.[name]?.value ?? result?.bindings?.[0]?.[name];
}

function numericBinding(result, name) {
  const value = bindingValue(result, name);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const typedLiteral = value.match(/^"([^"]+)"\^\^<[^>]+>$/);
    const lexical = typedLiteral ? typedLiteral[1] : value;
    const parsed = Number(lexical);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

async function postJson(port, path, body, config, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (config.authToken && !config.noAuth) headers.authorization = `Bearer ${config.authToken}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${path} on ${port}: ${text.slice(0, 500)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function query(port, sparql, config, options = {}) {
  const response = await postJson(port, '/api/query', { sparql, ...options }, config, config.queryTimeoutMs);
  return response.result ?? response;
}

async function writeBatch(config, plan, nodeIndex, writeNumber) {
  const port = config.ports[nodeIndex];
  const nodeNumber = nodeIndex + 1;
  const quads = makeQuads(config, plan, nodeNumber, writeNumber);
  const estimatedNQuadBytes = estimateQuadsNQuadBytes(quads);
  const startedAt = performance.now();
  const response = await postJson(port, '/api/shared-memory/write', {
    contextGraphId: config.contextGraphId,
    quads,
  }, config, config.requestTimeoutMs);
  const durationMs = performance.now() - startedAt;
  return {
    port,
    nodeNumber,
    writeNumber,
    root: quads[0].subject,
    triples: quads.length,
    estimatedNQuadBytes,
    durationMs: Number(durationMs.toFixed(2)),
    operationId: response.operationId ?? response.shareOperationId,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function summarizeWrites(records, config) {
  const durations = records.map((record) => record.durationMs);
  const perNode = config.ports.map((port) => {
    const nodeRecords = records.filter((record) => record.port === port);
    const nodeDurations = nodeRecords.map((record) => record.durationMs);
    const estimatedBytes = nodeRecords.reduce((sum, record) => sum + record.estimatedNQuadBytes, 0);
    const triples = nodeRecords.reduce((sum, record) => sum + record.triples, 0);
    return {
      port,
      writes: nodeRecords.length,
      triples,
      estimatedMiB: Number((estimatedBytes / 1024 / 1024).toFixed(3)),
      minMs: Number(Math.min(...nodeDurations).toFixed(2)),
      maxMs: Number(Math.max(...nodeDurations).toFixed(2)),
      meanMs: Number((nodeDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, nodeDurations.length)).toFixed(2)),
      p50Ms: Number(percentile(nodeDurations, 50).toFixed(2)),
      p95Ms: Number(percentile(nodeDurations, 95).toFixed(2)),
    };
  });
  return {
    writes: records.length,
    triples: records.reduce((sum, record) => sum + record.triples, 0),
    estimatedMiB: Number((records.reduce((sum, record) => sum + record.estimatedNQuadBytes, 0) / 1024 / 1024).toFixed(3)),
    minMs: Number(Math.min(...durations).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
    meanMs: Number((durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)).toFixed(2)),
    p50Ms: Number(percentile(durations, 50).toFixed(2)),
    p95Ms: Number(percentile(durations, 95).toFixed(2)),
    perNode,
  };
}

function emitProgress(config, event) {
  if (!config.quiet) process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

async function runWrites(config, plan) {
  if (config.skipWrite) return { durationMs: 0, records: [], summary: undefined };

  const tasks = buildWriteTasks(config, plan);
  const records = [];
  let nextTask = 0;
  let completed = 0;
  const startedAt = performance.now();

  async function worker() {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask];
      nextTask += 1;
      const record = await writeBatch(config, plan, task.nodeIndex, task.writeNumber);
      records.push(record);
      completed += 1;
      if (completed === 1 || completed === tasks.length || completed % config.progressEvery === 0) {
        emitProgress(config, {
          event: 'write-progress',
          completed,
          total: tasks.length,
          port: record.port,
          triples: record.triples,
          estimatedMiB: Number((record.estimatedNQuadBytes / 1024 / 1024).toFixed(3)),
          durationMs: record.durationMs,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(config.writeConcurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  const durationMs = performance.now() - startedAt;
  return {
    durationMs: Number(durationMs.toFixed(2)),
    records,
    summary: summarizeWrites(records, config),
  };
}

async function countTriples(port, config, plan) {
  const result = await query(
    port,
    `SELECT (COUNT(?s) AS ?count) WHERE {
       ?s ?p ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     }`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  return numericBinding(result, 'count');
}

async function sampleTriple(port, config, plan) {
  const result = await query(
    port,
    `SELECT ?s ?p ?o WHERE {
       ?s ?p ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     } ORDER BY ?s ?p LIMIT 1`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  return result?.bindings?.[0] ?? undefined;
}

async function countRunMetaPredicate(port, config, plan, predicate, rootPredicates = [`${DKG_ONTOLOGY}rootEntity`]) {
  const rootClauses = rootPredicates
    .map((rootPredicate) => `{ ?op <${rootPredicate}> ?root . }`)
    .join('\n           UNION\n           ');
  const result = await query(
    port,
    `SELECT (COUNT(?value) AS ?count) WHERE {
       {
         SELECT DISTINCT ?op ?value WHERE {
           GRAPH <${plan.metadataGraph}> {
             ?op <${predicate}> ?value .
             ${rootClauses}
             FILTER(STRSTARTS(STR(?root), ${sparqlString(plan.rootPrefix)}))
           }
         }
       }
     }`,
    config,
  );
  return numericBinding(result, 'count');
}

async function collectMetadata(config, plan) {
  const entries = [];
  for (const port of config.ports) {
    const publicStagedQuads = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicStagedQuads`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    const publicSnapshotGraphs = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicSnapshotGraph`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    const publicSnapshotRefs = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicSnapshotRef`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    entries.push({
      port,
      publicStagedQuads,
      publicSnapshotGraphs,
      publicSnapshotRefs,
      ok: publicStagedQuads === 0
        && publicSnapshotGraphs === 0
        && publicSnapshotRefs === plan.totalWrites,
    });
  }
  return entries;
}

async function pollReplication(config, plan) {
  const startedAt = performance.now();
  const polls = [];
  while (performance.now() - startedAt <= config.replicationTimeoutMs) {
    const counts = [];
    for (const port of config.ports) {
      try {
        counts.push({ port, count: await countTriples(port, config, plan) });
      } catch (error) {
        counts.push({ port, error: error instanceof Error ? error.message : String(error) });
      }
    }
    polls.push({ atMs: Number((performance.now() - startedAt).toFixed(2)), counts });
    emitProgress(config, { event: 'replication-poll', counts });
    if (counts.every((entry) => entry.count === plan.totalTriples)) {
      return {
        converged: true,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        polls,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  return {
    converged: false,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    polls,
  };
}

async function collectSamples(config, plan) {
  const entries = [];
  for (const port of config.ports) {
    const count = await countTriples(port, config, plan);
    const sample = await sampleTriple(port, config, plan);
    entries.push({
      port,
      count,
      sample,
      ok: count === plan.totalTriples && Boolean(sample),
    });
  }
  return entries;
}

function captureLogOffsets(devnetDir) {
  if (!devnetDir || !existsSync(devnetDir)) return [];
  return readdirSync(devnetDir)
    .filter((name) => /^node\d+$/.test(name))
    .map((nodeName) => {
      const file = join(devnetDir, nodeName, 'daemon.log');
      return existsSync(file) ? { nodeName, file, offset: statSync(file).size } : undefined;
    })
    .filter(Boolean);
}

async function scanLogsFromOffsets(offsets) {
  const matches = [];
  for (const entry of offsets) {
    if (!existsSync(entry.file)) continue;
    const stream = createReadStream(entry.file, {
      encoding: 'utf8',
      start: entry.offset,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber += 1;
      for (const pattern of FAILURE_PATTERNS) {
        if (line.includes(pattern.text)) {
          matches.push({
            nodeName: entry.nodeName,
            file: entry.file,
            lineOffset: lineNumber,
            pattern: pattern.name,
            text: line.slice(0, 500),
          });
        }
      }
    }
  }
  return { scannedFiles: offsets.map((entry) => entry.file), matches, ok: matches.length === 0 };
}

function sanitizeConfig(config) {
  return {
    contextGraphId: config.contextGraphId,
    ports: config.ports,
    targetMiBPerNode: config.targetMiBPerNode,
    triplesPerWrite: config.triplesPerWrite,
    objectBytes: config.objectBytes,
    predicateCount: config.predicateCount,
    writeConcurrency: config.writeConcurrency,
    replicationTimeoutMs: config.replicationTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    runId: config.runId,
    namespace: config.namespace,
    predicateBase: config.predicateBase,
    skipWrite: config.skipWrite,
    noAuth: config.noAuth,
    hasAuthToken: Boolean(config.authToken),
    devnetDir: config.devnetDir,
    scanLogs: config.scanLogs,
  };
}

async function runSwmTripleVolumeBenchmark(config) {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const logOffsets = config.scanLogs ? captureLogOffsets(config.devnetDir) : [];
  const plan = buildBenchmarkPlan(config);

  emitProgress(config, {
    event: 'plan',
    nodes: config.ports.length,
    targetMiBPerNode: plan.targetMiBPerNode,
    estimatedMiBPerNode: plan.estimatedMiBPerNode,
    triplesPerWrite: config.triplesPerWrite,
    writesPerNode: plan.writesPerNode,
    triplesPerNode: plan.triplesPerNode,
    totalTriples: plan.totalTriples,
  });

  const write = await runWrites(config, plan);
  const replication = await pollReplication(config, plan);
  const samples = await collectSamples(config, plan);
  const metadata = await collectMetadata(config, plan);
  const logScan = config.scanLogs ? await scanLogsFromOffsets(logOffsets) : undefined;
  const finishedAt = performance.now();
  const ok = replication.converged
    && samples.every((entry) => entry.ok)
    && metadata.every((entry) => entry.ok)
    && (logScan ? logScan.ok : true);

  return {
    benchmark: 'swm-triple-volume',
    ok,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs: Number((finishedAt - startedAt).toFixed(2)),
    config: sanitizeConfig(config),
    plan,
    metadata,
    write: {
      durationMs: write.durationMs,
      summary: write.summary,
    },
    replication,
    samples,
    logScan,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseBenchmarkArgs(argv, env);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runSwmTripleVolumeBenchmark(config);
  if (config.output) {
    mkdirSync(dirname(config.output), { recursive: true });
    writeFileSync(config.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildBenchmarkPlan,
  buildWriteTasks,
  estimateQuadNQuadBytes,
  estimateQuadsNQuadBytes,
  makeObjectLexical,
  makeQuads,
  parseBenchmarkArgs,
  runSwmTripleVolumeBenchmark,
  usage,
};
