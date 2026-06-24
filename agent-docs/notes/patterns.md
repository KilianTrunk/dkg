# Patterns

## Current Patterns

- Security-sensitive ids should carry provenance in the type/API shape. Avoid overloading one `string` parameter for both policy authority and cryptographic binding.
- For publish encryption tests, poison the lookup that must not be called. This catches accidental policy probes that would otherwise pass under mocked happy paths.
- LU-5 and LU-11 resolver changes need parity tests because they share policy selection but diverge at payload/chunk emission.
- Generated Hardhat deployment artifacts under `packages/evm-module/deployments/localhost*` can appear during tests and should be cleaned before staging.
