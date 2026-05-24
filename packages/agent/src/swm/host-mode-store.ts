/**
 * OT-RFC-38 LU-6 — opaque ciphertext storage for core hosting of curated SWM.
 *
 * Core nodes that subscribe to a curated CG's SWM topic in HOST MODE
 * store the raw gossip envelope bytes here. They cannot decrypt the
 * payload (they're not members of the CG and don't have the chain key),
 * so they hold the bytes opaquely. Late members fetch the bytes back
 * via `/dkg/10.0.1/swm-host-catchup` and decrypt locally using their
 * own member-side state.
 *
 * Wire format on disk is a simple length-prefixed append-only log:
 *   [8-byte BE timestampMs] [8-byte BE seqno] [4-byte BE len] [len bytes]
 *
 * One file per CG, named with the URL-safe base64 of sha256(cgId)
 * so an arbitrary user-supplied CG id maps to a safe filesystem name.
 *
 * Pre-registration staging (per RFC §1.2): unregistered CGs get a
 * short TTL (default 6h) and a small per-CG byte cap (default 1 MiB).
 * Registered CGs get the operator-configured limits — typically much
 * larger TTL and cap so the host can serve catchup for days/weeks of
 * gossip after registration.
 *
 * The store is intentionally simple: append-only writes, sequential
 * reads, periodic prune. No indexes, no compaction, no checkpoints.
 * The expected steady-state size is small (a few MB per active CG
 * in Phase A); when this becomes a hot path, swap for a sqlite-backed
 * implementation behind the same interface.
 */
import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

export interface SwmHostModeEntry {
  /** Monotonic per-store sequence number assigned at append time. */
  seqno: number;
  /** UNIX epoch milliseconds when the entry was written. */
  timestampMs: number;
  /** Raw gossip envelope bytes as received from libp2p. Opaque to the core. */
  envelopeBytes: Uint8Array;
}

export interface SwmHostModeStoreLimits {
  /** Max bytes retained per CG. Older entries are evicted FIFO. */
  perCgByteCap: number;
  /** Time-to-live in milliseconds. Entries older than this are pruned. */
  ttlMs: number;
}

export interface SwmHostModeStoreOptions {
  /** Filesystem directory under which per-CG logs are written. */
  dataDir: string;
  /** Limits applied to unregistered (pre-registration) CGs. */
  unregisteredLimits: SwmHostModeStoreLimits;
  /** Limits applied to on-chain registered CGs. */
  registeredLimits: SwmHostModeStoreLimits;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SwmHostModeStats {
  /** Number of distinct CGs that have at least one stored entry. */
  cgCount: number;
  /** Total stored bytes (sum across CGs) on disk. */
  totalBytes: number;
  /** Total stored entries (sum across CGs). */
  totalEntries: number;
}

const DEFAULT_UNREGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 1 * 1024 * 1024,
  ttlMs: 6 * 60 * 60 * 1000,
};

const DEFAULT_REGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 64 * 1024 * 1024,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

const ENTRY_HEADER_BYTES = 8 + 8 + 4;
const META_FILE = '_meta.json';

interface CgMetaState {
  seqno: number;
  registered: boolean;
  contextGraphId: string;
}

/**
 * File-backed opaque store for curated SWM ciphertext envelopes that
 * a core node holds on behalf of CG members. See module docs for the
 * on-disk format.
 *
 * The implementation is intentionally minimal: a single append per
 * write, a streaming read on iterate, and an in-memory metadata cache
 * (`seqno` counter and per-CG `registered` flag) refreshed lazily.
 */
export class SwmHostModeStore {
  private readonly dataDir: string;
  private readonly unregisteredLimits: SwmHostModeStoreLimits;
  private readonly registeredLimits: SwmHostModeStoreLimits;
  private readonly now: () => number;
  private readonly metaCache = new Map<string, CgMetaState>();
  private readonly inflightWrites = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(options: SwmHostModeStoreOptions) {
    this.dataDir = options.dataDir;
    this.unregisteredLimits = options.unregisteredLimits ?? DEFAULT_UNREGISTERED_LIMITS;
    this.registeredLimits = options.registeredLimits ?? DEFAULT_REGISTERED_LIMITS;
    this.now = options.now ?? (() => Date.now());
  }

  static defaultLimits(): { unregistered: SwmHostModeStoreLimits; registered: SwmHostModeStoreLimits } {
    return { unregistered: DEFAULT_UNREGISTERED_LIMITS, registered: DEFAULT_REGISTERED_LIMITS };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Append one opaque envelope for `contextGraphId`. Returns the
   * assigned sequence number (monotonic per CG, never reused even
   * across restarts because seqno persists in the meta file).
   *
   * Concurrent appends for the same CG are serialized via
   * `inflightWrites` so the file-level seqno stays monotonic.
   */
  async append(contextGraphId: string, envelopeBytes: Uint8Array): Promise<number> {
    await this.init();
    const cgKey = this.cgKey(contextGraphId);
    const previous = this.inflightWrites.get(cgKey);
    let resolveOuter: () => void = () => {};
    const next = new Promise<void>((resolve) => { resolveOuter = resolve; });
    this.inflightWrites.set(cgKey, previous ? previous.then(() => next) : next);
    try {
      if (previous) await previous;
      return await this.appendUnlocked(contextGraphId, envelopeBytes);
    } finally {
      resolveOuter();
      if (this.inflightWrites.get(cgKey) === next) this.inflightWrites.delete(cgKey);
    }
  }

  private async appendUnlocked(contextGraphId: string, envelopeBytes: Uint8Array): Promise<number> {
    if (envelopeBytes.length === 0) {
      throw new Error('SwmHostModeStore.append: refusing zero-length envelope');
    }
    const meta = await this.loadMeta(contextGraphId);
    const seqno = meta.seqno + 1;
    const timestampMs = this.now();
    const header = Buffer.alloc(ENTRY_HEADER_BYTES);
    header.writeBigUInt64BE(BigInt(timestampMs), 0);
    header.writeBigUInt64BE(BigInt(seqno), 8);
    header.writeUInt32BE(envelopeBytes.length, 16);
    const payload = Buffer.concat([header, Buffer.from(envelopeBytes)]);
    await fs.appendFile(this.logPath(contextGraphId), payload);
    meta.seqno = seqno;
    await this.persistMeta(contextGraphId, meta);
    await this.enforceLimitsAfterAppend(contextGraphId, meta);
    return seqno;
  }

  /**
   * Iterate stored entries for `contextGraphId` with seqno strictly
   * greater than `sinceSeqno`. Caller can pass `limit` to bound the
   * response size. Returns entries in seqno-ascending order.
   */
  async iterate(
    contextGraphId: string,
    sinceSeqno: number,
    limit?: number,
  ): Promise<SwmHostModeEntry[]> {
    await this.init();
    const filePath = this.logPath(contextGraphId);
    const exists = await fileExists(filePath);
    if (!exists) return [];
    const buf = await fs.readFile(filePath);
    const out: SwmHostModeEntry[] = [];
    let offset = 0;
    while (offset + ENTRY_HEADER_BYTES <= buf.length) {
      const timestampMs = Number(buf.readBigUInt64BE(offset));
      const seqno = Number(buf.readBigUInt64BE(offset + 8));
      const len = buf.readUInt32BE(offset + 16);
      const payloadStart = offset + ENTRY_HEADER_BYTES;
      const payloadEnd = payloadStart + len;
      if (payloadEnd > buf.length) {
        break;
      }
      if (seqno > sinceSeqno) {
        out.push({
          seqno,
          timestampMs,
          envelopeBytes: new Uint8Array(buf.subarray(payloadStart, payloadEnd)),
        });
        if (limit !== undefined && out.length >= limit) break;
      }
      offset = payloadEnd;
    }
    return out;
  }

  /** Mark a CG as on-chain registered. Switches it to the larger limits. */
  async markRegistered(contextGraphId: string): Promise<void> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId);
    if (meta.registered) return;
    meta.registered = true;
    await this.persistMeta(contextGraphId, meta);
  }

  /** Mark a CG as no-longer-registered. Useful for revoke flows. */
  async markUnregistered(contextGraphId: string): Promise<void> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId);
    if (!meta.registered) return;
    meta.registered = false;
    await this.persistMeta(contextGraphId, meta);
  }

  /** Returns `true` if at least one stored entry exists for the CG. */
  async hasEntries(contextGraphId: string): Promise<boolean> {
    await this.init();
    return fileExists(this.logPath(contextGraphId));
  }

  /**
   * Sweep all known CGs for TTL-expired entries. Returns the total
   * bytes pruned across all CGs. Safe to call concurrently with
   * `append` — each per-CG prune takes the same inflight-write lock.
   */
  async prune(): Promise<{ bytesPruned: number; cgsPruned: number }> {
    await this.init();
    const cgs = await this.listKnownCgs();
    let bytesPruned = 0;
    let cgsPruned = 0;
    for (const cgInfo of cgs) {
      const pruned = await this.pruneCg(cgInfo.contextGraphId);
      bytesPruned += pruned;
      if (pruned > 0) cgsPruned += 1;
    }
    return { bytesPruned, cgsPruned };
  }

  async stats(): Promise<SwmHostModeStats> {
    await this.init();
    const cgs = await this.listKnownCgs();
    let totalBytes = 0;
    let totalEntries = 0;
    for (const cgInfo of cgs) {
      const filePath = this.logPath(cgInfo.contextGraphId);
      if (!(await fileExists(filePath))) continue;
      const stat = await fs.stat(filePath);
      totalBytes += stat.size;
      const buf = await fs.readFile(filePath);
      let offset = 0;
      while (offset + ENTRY_HEADER_BYTES <= buf.length) {
        const len = buf.readUInt32BE(offset + 16);
        const end = offset + ENTRY_HEADER_BYTES + len;
        if (end > buf.length) break;
        totalEntries += 1;
        offset = end;
      }
    }
    return { cgCount: cgs.length, totalBytes, totalEntries };
  }

  /** Test-only: returns the persisted seqno cursor for a CG, or 0 if unknown. */
  async getLastSeqno(contextGraphId: string): Promise<number> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId).catch(() => null);
    return meta ? meta.seqno : 0;
  }

  /** Test-only: returns whether the CG is marked as registered. */
  async isRegistered(contextGraphId: string): Promise<boolean> {
    await this.init();
    const meta = await this.loadMeta(contextGraphId).catch(() => null);
    return meta ? meta.registered : false;
  }

  private async pruneCg(contextGraphId: string): Promise<number> {
    const cgKey = this.cgKey(contextGraphId);
    const previous = this.inflightWrites.get(cgKey);
    let resolveOuter: () => void = () => {};
    const next = new Promise<void>((resolve) => { resolveOuter = resolve; });
    this.inflightWrites.set(cgKey, previous ? previous.then(() => next) : next);
    try {
      if (previous) await previous;
      const limits = await this.activeLimits(contextGraphId);
      return await this.pruneCgUnlocked(contextGraphId, limits);
    } finally {
      resolveOuter();
      if (this.inflightWrites.get(cgKey) === next) this.inflightWrites.delete(cgKey);
    }
  }

  private async pruneCgUnlocked(
    contextGraphId: string,
    limits: SwmHostModeStoreLimits,
  ): Promise<number> {
    const filePath = this.logPath(contextGraphId);
    if (!(await fileExists(filePath))) return 0;
    const buf = await fs.readFile(filePath);
    const ttlCutoff = this.now() - limits.ttlMs;
    // First pass: locate TTL cut point + total post-TTL size.
    const survivors: { start: number; end: number }[] = [];
    let offset = 0;
    while (offset + ENTRY_HEADER_BYTES <= buf.length) {
      const timestampMs = Number(buf.readBigUInt64BE(offset));
      const len = buf.readUInt32BE(offset + 16);
      const end = offset + ENTRY_HEADER_BYTES + len;
      if (end > buf.length) break;
      if (timestampMs >= ttlCutoff) {
        survivors.push({ start: offset, end });
      }
      offset = end;
    }
    let survivorBytes = survivors.reduce((sum, s) => sum + (s.end - s.start), 0);
    let dropIndex = 0;
    while (survivorBytes > limits.perCgByteCap && dropIndex < survivors.length) {
      survivorBytes -= survivors[dropIndex].end - survivors[dropIndex].start;
      dropIndex += 1;
    }
    const kept = survivors.slice(dropIndex);
    const bytesPruned = buf.length - survivorBytes;
    if (bytesPruned === 0) return 0;
    if (kept.length === 0) {
      await fs.rm(filePath, { force: true });
      return bytesPruned;
    }
    const parts: Buffer[] = [];
    for (const s of kept) parts.push(Buffer.from(buf.subarray(s.start, s.end)));
    await fs.writeFile(filePath, Buffer.concat(parts));
    return bytesPruned;
  }

  private async enforceLimitsAfterAppend(contextGraphId: string, _meta: CgMetaState): Promise<void> {
    const limits = await this.activeLimits(contextGraphId);
    const filePath = this.logPath(contextGraphId);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return;
    if (stat.size > limits.perCgByteCap) {
      await this.pruneCgUnlocked(contextGraphId, limits);
    }
  }

  private async activeLimits(contextGraphId: string): Promise<SwmHostModeStoreLimits> {
    const meta = await this.loadMeta(contextGraphId);
    return meta.registered ? this.registeredLimits : this.unregisteredLimits;
  }

  private async loadMeta(contextGraphId: string): Promise<CgMetaState> {
    const cgKey = this.cgKey(contextGraphId);
    const cached = this.metaCache.get(cgKey);
    if (cached) return cached;
    const metaPath = this.metaPath(contextGraphId);
    try {
      const txt = await fs.readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(txt) as CgMetaState;
      this.metaCache.set(cgKey, parsed);
      return parsed;
    } catch {
      const fresh: CgMetaState = { seqno: 0, registered: false, contextGraphId };
      this.metaCache.set(cgKey, fresh);
      return fresh;
    }
  }

  private async persistMeta(contextGraphId: string, meta: CgMetaState): Promise<void> {
    const cgKey = this.cgKey(contextGraphId);
    this.metaCache.set(cgKey, meta);
    await fs.writeFile(this.metaPath(contextGraphId), JSON.stringify(meta));
  }

  private async listKnownCgs(): Promise<{ contextGraphId: string }[]> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const cgs: { contextGraphId: string }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.meta')) continue;
      try {
        const txt = await fs.readFile(path.join(this.dataDir, e.name), 'utf-8');
        const parsed = JSON.parse(txt) as CgMetaState;
        if (parsed.contextGraphId) cgs.push({ contextGraphId: parsed.contextGraphId });
      } catch { /* skip corrupt meta */ }
    }
    return cgs;
  }

  private cgKey(contextGraphId: string): string {
    return createHash('sha256').update(contextGraphId).digest('base64url');
  }

  private logPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.log`);
  }

  private metaPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.meta`);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export { META_FILE };
