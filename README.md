# OriginTrail DKG V10 Node — your multi-agent memory 🦞
<img width="1536" height="1024" alt="dkg_img" src="docs/assets/dkg-v10.png" />

[![CI](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

**Give your AI agents the ultimate memory that survives the session.**

The Decentralized Knowledge Graph V10 is the shared, verifiable memory layer for multi-agent AI systems. Every finding your agents produce can flow from a private draft to a team-visible share to a permanent, cryptographically anchored record — queryable by any agent, owned by the publisher.

> **Disclaimer:** DKG V10 is in **release-candidate** on the testnet. Expect rapid iteration and breaking changes; not yet recommended for production workloads.

## The three memory layers

| Layer | Scope | Cost | Persistence |
|-------|-------|------|-------------|
| **Working Memory (WM)** | Private to your agent | Free | Local, survives restarts |
| **Shared Working Memory (SWM)** | Visible to context-graph peers | Free, gossip-replicated | TTL-bounded |
| **Verified Memory (VM)** | Permanent, on-chain | TRAC | Cryptographically anchored |

Canonical lifecycle: **WM → SWM → VM** (`create assertion → write → promote → publish → optional M-of-N verify`). All on-chain publishing goes through SWM first; the chain transaction is a finality signal that seals data peers already hold via gossip.

## Install

```bash
npm install -g @origintrail-official/dkg
```

**Prerequisites:** Node.js 22+, npm 10+. macOS, Linux, and Windows (PowerShell 5.1+ or WSL2) all supported.

## Get started

Pick the on-ramp that matches how you're already working. Each links to the per-package README with the full setup recipe, troubleshooting, and reference.

| You want… | Recipe |
|---|---|
| **DKG V10 as memory for Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline** | [`packages/mcp-dkg/README.md`](packages/mcp-dkg/README.md) |
| **DKG V10 wired into an OpenClaw agent** | [`packages/adapter-openclaw/README.md`](packages/adapter-openclaw/README.md) |
| **DKG V10 inside a Hermes agent** | [`packages/adapter-hermes/README.md`](packages/adapter-hermes/README.md) |
| **DKG V10 inside an ElizaOS agent** | [`packages/adapter-elizaos/README.md`](packages/adapter-elizaos/README.md) |
| **A standalone node** to query and publish from the CLI | [`docs/setup/JOIN_TESTNET.md`](docs/setup/JOIN_TESTNET.md) |
| **A custom Node.js / TypeScript integration** | [`docs/setup/SETUP_CUSTOM.md`](docs/setup/SETUP_CUSTOM.md) |

Every on-ramp installs the same `@origintrail-official/dkg` umbrella package, runs the same daemon (`dkg start`), and exposes the same data via HTTP, SPARQL, and MCP. The recipes diverge only in what they wire up on top.

The full node API surface (assertions, memory layers, context graphs, file ingestion, querying) is in [`packages/cli/skills/dkg-node/SKILL.md`](packages/cli/skills/dkg-node/SKILL.md) — the canonical reference loaded by any DKG-aware agent.

## Community integrations

Beyond the first-party adapters, DKG V10 supports community-contributed integrations — CLIs, MCP servers, agent plugins, and services discovered through the [`OriginTrail/dkg-integrations`](https://github.com/OriginTrail/dkg-integrations) registry:

```bash
dkg integration list                              # verified + featured tiers (default)
dkg integration list --tier community             # include community-tier
dkg integration install <slug>                    # install cli/mcp kind
```

Build one by forking the [`dkg-hello-world`](https://github.com/OriginTrail/dkg-hello-world) reference template (~150 lines, zero deps).

## Testnet funding

A DKG testnet node needs Base Sepolia ETH (gas) and TRAC (publishing). The OriginTrail testnet faucet hands out both in a single API call; first-setup paths (`dkg init`, `dkg openclaw setup`, `dkg hermes setup`, `dkg mcp setup`) auto-fund the node's first three wallets when a faucet is configured. Pass `--no-fund` to skip. See [`docs/setup/TESTNET_FAUCET.md`](docs/setup/TESTNET_FAUCET.md) for request/response shape, rate limits, and error codes.

## Repository layout

This is a pnpm + Turborepo monorepo.

```text
@origintrail-official/dkg                    CLI and node lifecycle (daemon, HTTP API, file store)
@origintrail-official/dkg-core               P2P networking, protocol, crypto, memory model types
@origintrail-official/dkg-storage            Triple-store interfaces and adapters
@origintrail-official/dkg-chain              Blockchain abstraction
@origintrail-official/dkg-publisher          Publish and finalization pipeline (SWM → VM)
@origintrail-official/dkg-query              Query execution and retrieval
@origintrail-official/dkg-agent              Identity, discovery, messaging, wallet keys
@origintrail-official/dkg-node-ui            Web dashboard, chat memory, SPARQL explorer
@origintrail-official/dkg-graph-viz          RDF visualization
@origintrail-official/dkg-evm-module         Solidity contracts and deployment assets
@origintrail-official/dkg-attested-assets    Attested Knowledge Asset protocol components
@origintrail-official/dkg-mcp                MCP server for Cursor / Claude Code / coding agents
@origintrail-official/dkg-adapter-openclaw   OpenClaw gateway bridge
@origintrail-official/dkg-adapter-elizaos    ElizaOS plugin (embedded DKGAgent)
@origintrail-official/dkg-adapter-hermes     Hermes Agent (Python provider + TS setup helpers)
@origintrail-official/dkg-adapter-autoresearch  AutoResearch integration
```

## Specs

| Document | Scope |
|---|---|
| [Part 1: Agent Marketplace](docs/SPEC_PART1_MARKETPLACE.md) | Protocol and agent interaction flows |
| [Part 2: Agent Economy](docs/SPEC_PART2_ECONOMY.md) | Incentives, rewards, and trust economics |
| [Part 3: Extensions](docs/SPEC_PART3_EXTENSIONS.md) | Extended capabilities and roadmap |
| [Attested Knowledge Assets](docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md) | Multi-party attestation model |
| [Trust Layer](docs/SPEC_TRUST_LAYER.md) | Endorsement and verification trust levels |
| [Verified KAs](docs/SPEC_VERIFIED_KAS.md) | On-chain verification lifecycle |
| [Capacity & Gas](docs/SPEC_CAPACITY_AND_GAS.md) | Node capacity and gas accounting |

## Development

```bash
pnpm install                                     # install all workspace deps
pnpm build                                       # compile packages and the Node UI bundle
pnpm test                                        # run the full test suite
pnpm test:coverage                               # tier-based coverage gates
pnpm --filter @origintrail-official/dkg test     # tests for a single package
```

Tier-based thresholds (TORNADO / BURA / KOSAVA) and Solidity lcov checks are in [`docs/testing/COVERAGE.md`](docs/testing/COVERAGE.md). Release workflow details are in [`RELEASE_PROCESS.md`](RELEASE_PROCESS.md).

## Contributing

- [Open an issue](https://github.com/OriginTrail/dkg/issues) for bugs or feature requests
- [Build a DKG integration](https://github.com/OriginTrail/dkg-integrations) — see the [`dkg-hello-world`](https://github.com/OriginTrail/dkg-hello-world) reference template
- [Join Discord](https://discord.com/invite/xCaY7hvNwD) for questions and discussion
- [Releases](https://github.com/OriginTrail/dkg/releases)

Apache 2.0 — see [LICENSE](LICENSE).
