---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Funding

Working Memory, Shared Working Memory, querying, local imports, discovery, and direct messages do not require on-chain funds.

Verifiable Memory publishing, updates, endorsement, verification, and other chain operations require gas and TRAC.

Your node's network is chosen at setup (default: **mainnet-gnosis**) and persisted as `config.networkConfig`; pass `--network <name>` to pick another (`mainnet-base`, `testnet`).

**On mainnet (gnosis / base) there is no faucet** — fund the node's operational wallets yourself with the chain's native gas token (xDAI on Gnosis, ETH on Base) and TRAC before publishing.

**On testnet**, setup flows auto-fund the generated wallets when a faucet is configured (the bundled testnet config provides one); this is skipped automatically on mainnet:

* `dkg init` — auto-funds on testnet when the faucet is reachable; has no `--no-fund` flag
* `dkg mcp setup`
* `dkg hermes setup`
* `dkg openclaw setup`

Skip funding on the `setup` commands with:

```bash
--no-fund
```

Check balances:

```bash
dkg wallet
dkg status
```

Faucet failures should not block local memory or P2P validation. They block only operations that need on-chain finality.
