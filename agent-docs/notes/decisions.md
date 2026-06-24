# Decisions

## Decision Log

### ADR: Split Publish Policy Target From AEAD Binding ID

Issue: internally derived same-CG numeric ids were passed through the same resolver argument as explicit remap targets, causing redundant raw on-chain policy probes and fail-closed publish failures under RPC degradation.

Decision: treat the resolver's fourth argument as an explicit policy/remap target only, and add `aeadBindingContextGraphId` as a binding-only option.

Rationale:

- Same-CG source policy should be resolved through the normal local/source CG path.
- Private same-CG publishes still need AEAD associated data bound to the canonical numeric on-chain id.
- Explicit or unverified numeric remaps must continue to probe raw target policy and fail closed on unknown or mismatch.

Consequence: future call sites must decide whether a numeric id is an explicit policy target or binding-only before calling the resolver.

### ADR: Async Daemon Publish Target Provenance

Issue: the daemon async publisher exposes a generic `publishContextGraphId` after the async lift has already resolved the source workspace target.

Decision: `resolveDaemonPublishEncryption` treats this current async-lift value as binding-only and documents that future explicit async remaps need a separate provenance field.

Rationale: re-resolving or raw-probing this value in the encryption factory can reintroduce the degraded RPC dependency that issue 1309 fixes.
