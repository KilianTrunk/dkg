import { defineSuite } from 'esbench';
import { createPayload, getSparql, validateQueryContainsMarker } from '../packages/cli/src/benchmark/publish-get/payload.ts';
import { runPublishAsyncGetBenchmark } from '../packages/cli/src/benchmark/publish-get/runner.ts';
import type { BenchmarkConfig } from '../packages/cli/src/benchmark/publish-get/types.ts';
import { LayeredDkgBenchmarkClient } from './support/layered-dkg-client.ts';

export default defineSuite({
  params: {
    payloadSizeBytes: [128, 1024],
  },
  baseline: {
    type: 'Name',
    value: 'syncPublish SWM to VM',
  },
  timing: {
    evaluateOverhead: false,
    iterations: 16,
    samples: 5,
    unrollFactor: 1,
    warmup: 1,
  },
  async setup(scene) {
    const config = createConfig(scene.params.payloadSizeBytes);
    const getClient = new LayeredDkgBenchmarkClient();
    const getPayload = createPayload(config, 'esbench-get', 1, 'sync', false);
    await getClient.sharedMemoryWrite(config.contextGraphId, getPayload.quads);
    await getClient.publishFromSharedMemory(config.contextGraphId, { rootEntities: [getPayload.rootEntity] }, false);

    let sequence = 0;

    scene.benchAsync('syncPublish SWM to VM', async () => {
      const client = new LayeredDkgBenchmarkClient();
      const payload = createPayload(config, `esbench-sync-${sequence++}`, 1, 'sync', false);
      await client.sharedMemoryWrite(config.contextGraphId, payload.quads);
      const result = await client.publishFromSharedMemory(
        config.contextGraphId,
        { rootEntities: [payload.rootEntity] },
        false,
      );
      if (!result.kcId) throw new Error('sync publish did not finalize a knowledge collection');
    });

    scene.benchAsync('asyncPublish enqueue runtime SWM to VM', async () => {
      const client = new LayeredDkgBenchmarkClient();
      const payload = createPayload(config, `esbench-async-${sequence++}`, 1, 'async', false);
      const prepared = await client.sharedMemoryWrite(config.contextGraphId, payload.quads);
      const shareOperationId = prepared.shareOperationId ?? prepared.workspaceOperationId;
      if (!shareOperationId) throw new Error('shared-memory write did not return a share operation id');

      const queued = await client.publisherEnqueue({
        contextGraphId: config.contextGraphId,
        shareOperationId,
        roots: [payload.rootEntity],
        namespace: config.namespace,
        scope: config.scope,
        authorityProofRef: config.authorityProofRef,
        swmId: 'swm-main',
        transitionType: 'CREATE',
        authorityType: 'owner',
      });
      if (!queued.jobId) throw new Error('async publisher did not return a job id');

      const completed = await client.publisherJob(queued.jobId);
      if (completed.job?.status !== 'finalized') {
        throw new Error(`async publisher did not finalize: ${completed.job?.status ?? 'missing job'}`);
      }
    });

    scene.benchAsync('get VM marker validation', async () => {
      const response = await getClient.query(
        getSparql(getPayload.rootEntity),
        config.contextGraphId,
        { view: 'verified-memory' },
      );
      validateQueryContainsMarker(response.result, getPayload.marker);
    });

    scene.benchAsync('runner publish async get', async () => {
      await runPublishAsyncGetBenchmark(
        { ...config, repeat: 1, warmups: 0, timeoutMs: 1000, pollIntervalMs: 1 },
        new LayeredDkgBenchmarkClient(),
        monotonicClock(),
      );
    });
  },
});

function createConfig(payloadSizeBytes: number): BenchmarkConfig {
  return {
    contextGraphId: 'bench-cg',
    repeat: 30,
    warmups: 3,
    timeoutMs: 120_000,
    payloadSizeBytes,
    fixture: 'generated',
    outputFormat: 'json',
    namespace: 'benchmark',
    scope: 'publish-async-get',
    authorityProofRef: 'proof:benchmark-local',
    pollIntervalMs: 1000,
    asyncSuccessStatuses: ['finalized'],
    getView: 'verified-memory',
  };
}

function monotonicClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}
