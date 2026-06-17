---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Contract addresses

The DKG V10 smart contracts are deployed per network. The canonical, always-up-to-date list of deployments lives in the repository:

[`packages/evm-module/deployments`](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) — one file per network (e.g. `base_sepolia_v10_contracts.json`), listing every contract's on-chain address, version, and deployment block.

## Key contract: the Hub

The **Hub** is the entry point — it resolves the addresses of every other V10 contract on a given network, so in most cases the Hub address is all you need.

| Network | Contract | Address |
| --- | --- | --- |
| Base Sepolia (testnet) | Hub | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |
| Base Sepolia (testnet) | Token (TRAC) | `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` |

{% hint style="info" %}
For the full set of contracts on each network (Staking, Conviction, Random Sampling, ParametersStorage, …) and for mainnet addresses, use the [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) as the source of truth — it is updated with every deployment.
{% endhint %}
