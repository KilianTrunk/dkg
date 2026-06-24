# PR History

## Entries

### Issue 1309: Derived Same-CG Policy Provenance

PR: https://github.com/OriginTrail/dkg/pull/1313

Implemented a resolver API split so derived same-CG on-chain ids are binding-only for AEAD while explicit/unverified numeric remaps remain policy targets. Added regression tests for LU-5, LU-11, update routing, SWM routing, sender-key AEAD binding, explicit mismatch directions, and daemon async encryption factory behavior.

Key review fixes:

- source/public vs target/private mismatch now rejects
- async daemon encryption treats current lift target as binding-only
- update path now has direct binding-only coverage
- daemon helper TypeScript receiver type fixed

Verification: focused agent tests, broader agent policy tests, sender-key suite, daemon helper test, publisher remap wire test, agent build, and root CLI build all passed.

Final offline adversarial review: completed after PR creation while the remote reviewer was unavailable. GPT 5.5 xhigh security/provenance, integration/data-flow, and QA/regression lenses found no actionable blockers. Residual non-blocking risks are future explicit async-remap provenance, unavoidable source policy fail-closed behavior under degraded RPC, and chunked AEAD lacking a decrypt round-trip test equivalent to LU-5.
