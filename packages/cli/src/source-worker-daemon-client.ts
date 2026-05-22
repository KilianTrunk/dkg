import type { LiftRequest } from '@origintrail-official/dkg-publisher';
import type { AssetPartitionQuad } from '@origintrail-official/dkg-core';
import type { SourceWorkerJobFailureDetails, SourceWorkerJobStatusResult } from '@origintrail-official/dkg-agent';

export interface SharedMemoryWriteResult {
  shareOperationId: string;
}

export interface SharedMemoryWriteClient {
  share(contextGraphId: string, quads: AssetPartitionQuad[], options?: { subGraphName?: string }): Promise<SharedMemoryWriteResult>;
}

export interface AsyncLiftJobClient {
  lift(request: LiftRequest): Promise<string>;
  getJobStatus(jobId: string): Promise<SourceWorkerJobStatusResult>;
}

export function createDaemonSharedMemoryWriteClient(daemonUrl: string, token: string): SharedMemoryWriteClient {
  return {
    async share(contextGraphId: string, quads: AssetPartitionQuad[], options: { subGraphName?: string } = {}): Promise<SharedMemoryWriteResult> {
      const response = await fetch(`${daemonUrl}/api/shared-memory/write`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contextGraphId,
          quads,
          subGraphName: options.subGraphName,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      return { shareOperationId: (payload as { shareOperationId?: string }).shareOperationId ?? '' };
    },
  };
}

export function createDaemonAsyncLiftJobClient(daemonUrl: string, token: string): AsyncLiftJobClient {
  return {
    async lift(request: LiftRequest): Promise<string> {
      const response = await fetch(`${daemonUrl}/api/publisher/enqueue`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const jobId = (payload as { jobId?: string }).jobId;
      if (!jobId) throw new Error('Async publisher enqueue did not return a job id');
      return jobId;
    },
    async getJobStatus(jobId: string): Promise<SourceWorkerJobStatusResult> {
      const response = await fetch(`${daemonUrl}/api/publisher/job?id=${encodeURIComponent(jobId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const job = ((payload as { job?: unknown }).job ?? payload) as Record<string, unknown>;
      return {
        status: stringField(job.status) ?? 'unknown',
        txHash: stringField(job.txHash) ?? stringField(recordField(job.result)?.txHash),
        ual: stringField(job.ual) ?? stringField(recordField(job.result)?.ual),
        failureDetails: normalizeFailureDetails(job.failureDetails ?? job.failure ?? job.error),
      };
    },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeFailureDetails(value: unknown): SourceWorkerJobFailureDetails | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return { message: value };
  }
  const record = recordField(value);
  if (!record) {
    return { details: value };
  }
  return {
    status: stringField(record.status),
    code: stringField(record.code),
    message: stringField(record.message) ?? stringField(record.error),
    details: record,
  };
}
