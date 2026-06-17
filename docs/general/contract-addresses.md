---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Contract addresses

{% hint style="info" %}
DKG V10 runs on **Base Sepolia (testnet)**, and the final release-candidate contracts are also deployed on **Base mainnet** as a pre-mainnet deployment. The full mainnet launch across Base, Gnosis, and NeuroWeb is still upcoming — see the [V10 Mainnet Release Timeline](../origintrail-v9-v10/v10-mainnet-release-timeline.md). The mainnet TRAC addresses below are the existing token contracts on those chains (for reference and bridging); the Gnosis and NeuroWeb mainnet protocol contracts will be published at mainnet launch.
{% endhint %}

## TRAC token

TRAC is the ERC-20 utility token used across the DKG. The token contract address is different on each chain — use the one for the network your node operates on.

On **mainnet**, TRAC is the original token contract (unchanged from V8). On **testnet**, V10 uses freshly redeployed test-TRAC contracts (different from the V8 ones). NeuroWeb uses the same native TRAC address on both mainnet and testnet.

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

The **Hub** is the entry point — it resolves the addresses of every other V10 contract on a given network, so in most cases the Hub address is all you need. Note that V10 Hub addresses are **new** (they differ from V8 on every network, including mainnet).

| Network | V10 Hub address |
| --- | --- |
| Base (mainnet) | `0x26146f51e31a95c075228a34cfc696f09e4c36c3` |
| Base Sepolia (testnet) | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |

{% hint style="info" %}
The Base mainnet Hub above is the pre-mainnet release-candidate deployment. Gnosis and NeuroWeb mainnet Hub addresses are published in the [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) as those networks' V10 contracts go live — use that folder as the source of truth.
{% endhint %}
