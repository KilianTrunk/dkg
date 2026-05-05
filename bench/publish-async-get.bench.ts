import { defineSuite } from 'esbench';
import { createPayload } from '../packages/cli/src/benchmark/publish-get/payload.ts';
import { formatResult, summarizeOperations } from '../packages/cli/src/benchmark/publish-get/stats.ts';
import {
  OPERATIONS,
  type BenchmarkOperation,
  type BenchmarkResult,
  type OperationTiming,
} from '../packages/cli/src/benchmark/publish-get/types.ts';

const config = {
  contextGraphId: 'bench-cg',
  repeat: 30,
  warmups: 3,
  timeoutMs: 120_000,
  payloadSizeBytes: 1024,
  fixture: 'generated' as const,
  outputFormat: 'json' as const,
  namespace: 'benchmark',
  scope: 'publish-async-get',
  authorityProofRef: 'proof:benchmark-local',
  pollIntervalMs: 1000,
  asyncSuccessStatuses: ['finalized'],
  getView: 'verified-memory' as const,
};

export default defineSuite({
  params: {
    iterations: [30, 300],
  },
  baseline: {
    type: 'Name',
    value: 'summarizeOperations',
  },
  timing: {
    evaluateOverhead: false,
    iterations: 64,
    samples: 5,
    warmup: 1,
  },
  setup(scene) {
    const operations = createOperationTimings(scene.params.iterations);
    const result = createBenchmarkResult(operations);

    scene.bench('summarizeOperations', () => {
      summarizeOperations(operations);
    });

    scene.bench('formatResultJson', () => {
      formatResult(result, 'json');
    });

    scene.bench('formatResultNdjson', () => {
      formatResult(result, 'ndjson');
    });

    scene.bench('createPayload', () => {
      for (let i = 0; i < scene.params.iterations; i += 1) {
        createPayload(config, 'esbench', i + 1, i % 2 === 0 ? 'sync' : 'async', false);
      }
    });
  },
});

function createOperationTimings(iterations: number): OperationTiming[] {
  const timings: OperationTiming[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const operation of OPERATIONS) {
      timings.push(createTiming(operation, iteration));
    }
  }
  return timings;
}

function createTiming(operation: BenchmarkOperation, iteration: number): OperationTiming {
  const operationIndex = OPERATIONS.indexOf(operation) + 1;
  return {
    operation,
    iteration,
    warmup: false,
    success: true,
    durationMs: operationIndex * 10 + iteration * 0.01,
    context: {
      contextGraphId: config.contextGraphId,
      rootEntity: `urn:dkg:benchmark:esbench:${operation}:${iteration}`,
      reproduction: `pnpm benchmark:publish-async-get -- --context-graph-id ${config.contextGraphId}`,
    },
  };
}

function createBenchmarkResult(operations: OperationTiming[]): BenchmarkResult {
  return {
    benchmark: 'publish-async-get',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    config,
    operations,
    summaries: summarizeOperations(operations),
    failures: [],
  };
}
