# ADR 0001 — recreateProfile is admin-only

- Status: Accepted
- Scope: `packages/evm-module` · `Profile.recreateProfile`
- Related: PRD "Recreate Profile for an existing Identity (testnet recovery)"

## Context

After a testnet `ProfileStorage` redeploy, some nodes have an on-chain
`Identity` but no `Profile`. `recreateProfile` re-attaches a `Profile`
to such an `Identity`, reusing the existing `identityId` so that the
surviving `identityId`-keyed staking, conviction and sharding state
stays addressable.

Genesis `createProfile` is whitelist-gated and called by an
**Operational** key on a brand-new identity with zero stake. `Recreate`
is different: it acts on an `identityId` that may already carry
third-party delegated stake, and it sets the initial operator fee.

## Decision

`recreateProfile` is gated `onlyWhitelisted onlyAdmin(identityId)`.

- The caller must hold the supplied identity's **Admin** key. This both
  authorizes the caller and proves the `Identity` exists.
- The signature takes `identityId` explicitly because Admin keys have no
  reverse lookup, mirroring other admin-gated, id-parameterised profile
  mutations (`updateOperatorFee`, `addOperationalWallets`).
- The existing whitelist gate is preserved.

## Rationale

An Operational ("hot") key must not be able to set the operator fee on a
stake-bearing node. A compromised hot key could otherwise re-price the
node's operator fee against its delegators. Restricting recovery to the
Admin key removes that vector while still letting honest operators
recover their nodes with a single transaction.

## Consequences

- Operators must control each bricked Identity's original Admin key to
  recover (operationally verified, off-chain).
- If testnet whitelisting is enabled, the bricked identities' **Admin**
  wallets must be whitelisted before recovery — the genesis flow
  whitelisted the Operational caller instead.
