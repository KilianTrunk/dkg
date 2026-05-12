import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface SharedMemoryPublicSnapshotStorageConfig {
  enabled?: boolean;
  directory?: string;
}

export interface WorkspacePublicSnapshotStore {
  putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }>;
  getSnapshot(ref: string): Promise<Quad[] | null>;
}

export class FileWorkspacePublicSnapshotStore implements WorkspacePublicSnapshotStore {
  constructor(private readonly directory: string) {}

  async putSnapshot(input: {
    readonly digest: string;
    readonly quads: readonly Quad[];
  }): Promise<{ readonly ref: string; readonly byteLength: number }> {
    const hash = snapshotHash(input.digest);
    const filePath = snapshotPath(this.directory, hash);
    const payload = `${JSON.stringify(input.quads.map((quad) => [
      quad.subject,
      quad.predicate,
      quad.object,
      quad.graph ?? '',
    ]))}\n`;

    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, filePath).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return;
      throw err;
    });

    return {
      ref: input.digest,
      byteLength: Buffer.byteLength(payload, 'utf8'),
    };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    const hash = snapshotHash(ref);
    const filePath = snapshotPath(this.directory, hash);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 3) {
        throw new Error(`Invalid shared-memory public snapshot blob ${ref}`);
      }
      return {
        subject: String(entry[0]),
        predicate: String(entry[1]),
        object: String(entry[2]),
        graph: '',
      };
    });
  }
}

function snapshotHash(ref: string): string {
  const trimmed = ref.trim();
  const hash = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid shared-memory public snapshot ref ${ref}`);
  }
  return hash.toLowerCase();
}

function snapshotPath(directory: string, hash: string): string {
  return join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);
}
