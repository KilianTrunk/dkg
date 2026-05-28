import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SyncVerifyLogEntry {
  level: 'debug' | 'warn';
  message: string;
}

export interface SyncVerifyResult {
  data: Quad[];
  meta: Quad[];
  rejected: number;
  logs: SyncVerifyLogEntry[];
}

export interface SyncParseResult {
  quads: Quad[];
  totalQuads: number;
}

export interface SharedMemoryProcessResult {
  validQuads: Quad[];
  dropped: number;
  entityCreators: Array<[string, string]>;
}

export interface SharedMemoryBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  droppedDataTriples: number;
  emptyResponses: number;
  entityCreators: Array<[string, string]>;
}

export interface DurableBatchProcessResult {
  verifiedData: Quad[];
  verifiedMeta: Quad[];
  totalFetchedDataQuads: number;
  totalFetchedMetaQuads: number;
  rejectedKcs: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  logs: SyncVerifyLogEntry[];
}

export class SyncVerifyWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    // Workers boot from compiled `.js`. In production, `import.meta.url`
    // resolves to `dist/sync-verify-worker.js` and the sibling `.js`
    // exists. In dev / vitest source-mode, `import.meta.url` resolves
    // into `src/`, where only `.ts` exists — Node's `Worker` cannot load
    // bare `.ts` (Codex round-2). Fall back through the parallel `dist/`
    // path so vitest source-runs still pick up the compiled worker if
    // the package has been built. As a final fallback we try the `.ts`
    // path — that only succeeds on a Node loader that understands TS
    // (e.g. tsx). The worker fails fast otherwise instead of silently
    // poisoning sync results with a thrown promise.
    const candidates: URL[] = [
      new URL('./sync-verify-worker-impl.js', import.meta.url),
      // src/foo.js → dist/foo.js (vitest source-mode)
      new URL('./sync-verify-worker-impl.js', import.meta.url.replace('/src/', '/dist/')),
      new URL('./sync-verify-worker-impl.ts', import.meta.url),
    ];
    const workerUrl = candidates.find((u) => existsSync(fileURLToPath(u))) ?? candidates[0];
    this.worker = new Worker(fileURLToPath(workerUrl));
    this.worker.on('message', (message: { id: number; result?: SyncVerifyResult; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
    });
  }

  verify(dataQuads: Quad[], metaQuads: Quad[], acceptUnverified: boolean): Promise<SyncVerifyResult> {
    const id = this.nextId++;
    return new Promise<SyncVerifyResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'verify', args: [dataQuads, metaQuads, acceptUnverified] });
    });
  }

  parseAndFilter(nquadsText: string, graphUri: string, contextGraphId: string): Promise<SyncParseResult> {
    const id = this.nextId++;
    return new Promise<SyncParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'parseAndFilter', args: [nquadsText, graphUri, contextGraphId] });
    });
  }

  processSharedMemory(wsDataQuads: Quad[], wsMetaQuads: Quad[]): Promise<SharedMemoryProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processSharedMemory', args: [wsDataQuads, wsMetaQuads] });
    });
  }

  processDurableBatch(
    dataQuads: Quad[],
    metaQuads: Quad[],
    acceptUnverified: boolean,
  ): Promise<DurableBatchProcessResult> {
    const id = this.nextId++;
    return new Promise<DurableBatchProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processDurableBatch', args: [dataQuads, metaQuads, acceptUnverified] });
    });
  }

  processSharedMemoryBatch(
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
  ): Promise<SharedMemoryBatchProcessResult> {
    const id = this.nextId++;
    return new Promise<SharedMemoryBatchProcessResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method: 'processSharedMemoryBatch', args: [wsDataQuads, wsMetaQuads] });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
