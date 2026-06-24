# Active Work

## Issue 1309: Derived On-Chain Context Graph ID Treated As Explicit Remap

Risk: High. The change touches publish encryption-policy selection and must preserve fail-closed behavior for explicit raw remaps.

Status: Complete.

### Plan

- [x] Initialize project memory files.
- [x] Gather issue context and inspect relevant publish/policy code paths.
- [x] Coordinate GPT 5.5 xhigh teammate analysis for issue scope, code architecture, and QA/repro strategy.
- [x] Write detailed implementation plan in `agent-docs/issue-1309-plan.md`.
- [x] Run adversarial plan review and update the plan.
- [x] Implement the selected fix with focused tests.
- [x] Run verification and adversarial implementation review.
- [x] Apply review fixes if needed.
- [x] Update project memory with outcomes and lessons.
- [x] Create a branch, commit, push, and open a PR into `main`.

### Review

Implemented the selected split between explicit policy target and AEAD binding id. Same-CG derived numeric ids now bind AEAD without driving policy lookup, while explicit/unverified numeric remaps keep fail-closed raw target checks. Implementation review found and fixed explicit remap mismatch parity, async daemon provenance, update routing coverage, sender-key binding coverage, and a TypeScript `this`-context issue in the extracted daemon helper.

Verification passed:

- agent encrypt-inline policy: 20 tests
- agent policy/plaintext/on-chain suite: 73 tests
- agent SWM sender-key pending suite: 26 tests
- CLI daemon encryption factory: 1 test
- publisher v10 remap wire: 3 tests
- agent build
- CLI/root build

PR: https://github.com/OriginTrail/dkg/pull/1313

## Final Offline Adversarial Review

Status: Complete.

### Plan

- [x] Run independent GPT 5.5 xhigh review lenses: security/provenance, integration/data-flow, QA/regression.
- [x] Run main-agent diff audit against `main` and compare implementation to `agent-docs/issue-1309-plan.md`.
- [x] Re-run targeted verification if the final review touches code or reveals uncertainty.
- [x] Apply any required fixes, update docs, and push the PR branch.
- [x] Record final review outcome.

### Outcome

No actionable findings from the final offline adversarial review.

Review lenses:

- Security/provenance: confirmed derived same-CG numeric ids are binding-only while explicit/remap ids still drive policy checks, unknown-target fail-closed behavior, and public/private mismatch rejection.
- Integration/data-flow: traced `_publish`, `update`, `publishFromSharedMemory`, `publishFromFinalizedAssertion`, daemon async encryption, and publisher boundary semantics against the plan.
- QA/regression: confirmed regression coverage is sufficient for this fix; targeted tests were rerun by the QA reviewer.
- Main-agent audit: rechecked async-lift provenance and confirmed current async `publishContextGraphId` is sourced by workspace resolution, while synchronous API remaps still enter as explicit remap targets.

Residual non-blocking risks:

- Future explicit async remaps need a separate provenance field before being enabled.
- The fix removes the redundant derived-target policy probe, but the necessary source policy probe can still fail closed under real RPC degradation.
- Chunked AEAD binding is argument-verified; LU-5 has the stronger decrypt round-trip assertion.

Additional verification during final review:

- `packages/agent`: `pnpm exec vitest run --config vitest.config.ts test/encrypt-inline-policy.test.ts` - 20 passed.
- `packages/cli`: `pnpm exec vitest run test/daemon-publish-encryption-factory.test.ts` - 1 passed.
