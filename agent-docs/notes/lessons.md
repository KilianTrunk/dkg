# Lessons

## Active Lessons

- Mistake pattern: treating a numeric id as authoritative without preserving whether it was derived internally or supplied as remap intent.
  Root cause: one positional `string` argument carried both policy target and AEAD binding semantics.
  Preventive rule: security-sensitive helpers need separate parameters or option fields for separate authorities; tests should poison the invalid authority path.

- Mistake pattern: parallel verification of suites sharing a fixed local Hardhat harness can produce nonce/connection failures unrelated to the code change.
  Root cause: two test processes raced the same local port/account state.
  Preventive rule: run Hardhat-backed agent suites sequentially unless the harness is explicitly isolated.

- Mistake pattern: helper extraction around methods with explicit `this: DKGAgent` can fail TypeScript when typed as `Pick<DKGAgent, ...>`.
  Root cause: method `this` context remains part of the call contract.
  Preventive rule: type such helpers with the concrete receiver type or wrap calls in a properly typed adapter.
