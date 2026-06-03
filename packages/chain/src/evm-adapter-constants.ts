// SPDX-License-Identifier: Apache-2.0

/**
 * Module-scope timing / key-purpose constants extracted from evm-adapter.ts
 * during the structural split. Imported by evm-adapter-base.ts and the
 * per-domain holder modules. Pure values — no behaviour change.
 */

/**
 * Default TTL for re-resolving `RandomSampling` / `RandomSamplingStorage`
 * from the Hub. Matches the daemon auto-update poll cadence — small
 * enough that a missed `Hub.ContractChanged` event still self-heals
 * within ~5 min, large enough that the steady-state RPC overhead is
 * effectively zero (one extra `eth_call` every 5 min for the two
 * names, vs. the prover's per-tick reads). Override per-adapter via
 * `EVMAdapterConfig.randomSamplingHubRefreshMs`.
 */
export const DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS = 5 * 60 * 1000;

/**
 * Hard ceiling for the best-effort live `getActiveProofingPeriodDurationInBlocks()`
 * read inside `getActiveProofPeriodStatus()`. The status read itself is one
 * `eth_call`; the duration probe is a sibling `eth_call` on the same provider
 * and should typically resolve in <100ms. If it hasn't returned in 2s the
 * provider is slow or hanging — fall back to `undefined` and let the prover
 * use the cached `existing.proofingPeriodDurationInBlocks` rather than
 * stalling the whole tick. Codex round 5 on PR #369.
 */
export const DURATION_PROBE_TIMEOUT_MS = 2000;

/**
 * Upper bound on the in-flight duration probe slot age. The single-flight
 * guard reuses a pending probe to bound RPC cardinality at 1, but if the
 * underlying `eth_call` never settles (hung provider, dropped websocket)
 * the slot would otherwise stay populated forever and suppress every
 * fresh probe. After this many ms we abandon the slot regardless and
 * let the next call start a new probe — capping leaked-handle growth
 * to one per `MAX_PROBE_AGE_MS` window instead of one per tick. Set
 * generously above `DURATION_PROBE_TIMEOUT_MS` so honest slow paths
 * (high RPC latency, congested chain) still benefit from single-flight.
 * Codex round 8 on PR #369.
 */
export const MAX_PROBE_AGE_MS = 30_000;

export const RPC_READ_STALL_TIMEOUT_MS = 4_000;

export const RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS = 10_000;

export const RPC_BROADCAST_ATTEMPT_TIMEOUT_MS = 10_000;

export const RPC_RECEIPT_ATTEMPT_TIMEOUT_MS = 5_000;

export const RPC_RECEIPT_POLL_INTERVAL_MS = 2_000;

export const RPC_RECEIPT_TIMEOUT_MS = 180_000;

export const ADMIN_KEY_PURPOSE = 1;

export const OPERATIONAL_KEY_PURPOSE = 2;
