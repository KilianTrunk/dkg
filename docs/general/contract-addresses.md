---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Contract addresses

## TRAC token

TRAC is the ERC-20 utility token used across the DKG. The token contract address is different on each chain — use the one for the network your node operates on.

### Mainnet

| Network | TRAC token address |
| --- | --- |
| Base | `0xa81a52b4dda010896cdd386c7fbdc5cdc835ba23` |
| Gnosis | `0xEddd81E0792E764501AaE206EB432399a0268DB5` |
| NeuroWeb | `0xFfFFFFff00000000000000000000000000000001` |

### Testnet

| Network | TRAC token address |
| --- | --- |
| Base Sepolia | `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` |
| NeuroWeb Testnet | `0xFfFFFFff00000000000000000000000000000001` |

{% hint style="info" %}
NeuroWeb uses the same TRAC address on mainnet and testnet. For other testnets and the exact current test-token addresses, get test TRAC from the [faucet](../use-dkg/funding.md) and check the [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) — V10 redeploys its test contracts, so the deployments folder is the source of truth for testnet addresses.
{% endhint %}

## DKG smart contracts

The full set of DKG V10 contract deployments (Hub, Staking, Conviction, Random Sampling, ParametersStorage, …) lives in [`packages/evm-module/deployments`](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) — one file per network, listing every contract's on-chain address, version, and deployment block.

The **Hub** is the entry point — it resolves the addresses of every other V10 contract on a given network, so in most cases the Hub address is all you need:

| Network | Contract | Address |
| --- | --- | --- |
| Base Sepolia (testnet) | Hub | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |

{% hint style="info" %}
For mainnet contract addresses and the full per-network set, use the [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) as the source of truth — it is updated with every deployment.
{% endhint %}
