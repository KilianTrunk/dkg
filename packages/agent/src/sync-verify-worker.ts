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
    // resolves to `dist/sync-verify-worker.js` and the sibling `.js` is
    // present. In dev / vitest source-mode, `import.meta.url` points
    // into `src/`, where only `.ts` exists — Node's `Worker` cannot
    // load bare `.ts`, and `tsx`'s ESM hooks intentionally do not
    // auto-register inside worker threads (see
    // `node_modules/tsx/dist/esm/index.mjs` — `isMainThread && register()`).
    //
    // Resolution order (Codex round-3 hardening):
    //   1. sibling `.js`       — production / consumed via dist/
    //   2. parallel dist/*.js  — source-mode where `pnpm build` ran
    //
    // Anything else triggers an actionable error rather than letting
    // Node spit `Unknown file extension ".ts"` from inside the Worker,
    // which previously silently poisoned every `runSharedMemorySync`
    // consumer with a thrown promise.
    const sibJs = new URL('./sync-verify-worker-impl.js', import.meta.url);
    const distJs = new URL(
      './sync-verify-worker-impl.js',
      import.meta.url.replace('/src/', '/dist/'),
    );

    const sibJsPath = fileURLToPath(sibJs);
    const distJsPath = fileURLToPath(distJs);

    let workerPath: string;
    if (existsSync(sibJsPath)) {
      workerPath = sibJsPath;
    } else if (existsSync(distJsPath)) {
      workerPath = distJsPath;
    } else {
      throw new Error(
        `[SyncVerifyWorker] Compiled worker not found.\n` +
          `  Looked for: ${sibJsPath}\n` +
          `              ${distJsPath}\n` +
          `Node's Worker cannot load TypeScript directly, and tsx's loader\n` +
          `intentionally does not register inside worker threads. Build the\n` +
          `agent package first:\n\n` +
          `  pnpm --filter @origintrail-official/dkg-agent build\n\n` +
          `(CI's "Build packages" stage already does this; this error only\n` +
          `triggers in a fresh checkout where vitest is invoked before the\n` +
          `package has been compiled.)`,
      );
    }

    this.worker = new Worker(workerPath);
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
