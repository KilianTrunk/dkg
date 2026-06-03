import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, unlink, appendFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { resolveRpcUrls } from '@origintrail-official/dkg-chain';
import {
  dkgAuthTokenPath,
  FAUCET_WALLETS_PER_REQUEST,
  getFundableWalletAddresses,
  requestFaucetFunding,
  resolveDkgConfigHome,
  toErrorMessage,
  hasErrorCode,
} from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir, removeApiPort,
  apiPortPath,
  loadNetworkConfig, loadProjectConfig, resolveAutoUpdateConfig, resolveAutoUpdateSource, resolveChainConfig,
  releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall, repoDir, isDkgMonorepo,
  resolveContextGraphs, resolveNetworkDefaultContextGraphs,
  readNodeRoleFromConfigSync,
  type AutoUpdateConfig,
} from '../config.js';
import { ApiClient } from '../api-client.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../publisher-runner.js';
import { promptStoreBackend, applyStoreFlagsToConfig } from '../store-wizard.js';
import { runConfiguredSourceWorker } from '../source-worker-runner.js';
import { batchEntityQuads } from '../batching.js';
import {
  runDaemon,
  checkForNpmVersionUpdate,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  DAEMON_EXIT_CODE_RESTART,
  resolveStandaloneInstall,
  decodeForcedExitCode,
} from '../daemon.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
} from '../daemon/supervisor-liveness.js';
import { migrateToBlueGreen, noteEdgeLegacyReleases } from '../migration.js';
import { ensureRollbackNodeUiBundle } from '../rollback-node-ui.js';
import {
  isDaemonUnreachable,
  cliSleep,
  cliErrorMessage,
  STARTUP_BANNER,
  normalizeVersionTagRef,
  getCliVersion,
  parseOptionalVerifyTimeoutOption,
  loadStructuredFile,
  loadQuadsFromInput,
  resolveDaemonEntryPoint,
  probeHostForApiHost,
  selectedDkgHomeForEnv,
  withSelectedDkgHome,
  VERIFY_COLLECTION_TIMEOUT_MIN_MS,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
  printCatchupStatus,
  runCatchupStatusCommand,
  printMessage,
  shortId,
  formatUptime,
  publishEntityBatches,
  formatPublisherJobOutput,
  formatPublisherJobValue,
  stripQuotes,
  formatQuadObject,
  sleep,
  stopDaemonIfRunning,
} from '../cli-helpers.js';
import type { ActionOpts, CatchupStatusCommandOptions } from '../cli-helpers.js';
import {
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  getCliReceiptWithFailover,
  assertCliSuccessfulReceipt,
  sendCliRawTransactionWithFailover,
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
  CLI_RPC_RECEIPT_TIMEOUT_MS,
} from '../cli-rpc.js';
import {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
} from '../cli-supervisor.js';

export function registerInitCommand(program: Command): void {
// ─── dkg init ────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive setup — set node name, role, and relay')
  .option('--role <role>', "Node role: 'edge' (default; personal laptop / behind NAT) or 'core' (24/7 relay / SLA)")
  .option(
    '--store <backend>',
    'Pre-fill the triple-store backend prompt (oxigraph | blazegraph | sparql-http).',
  )
  .option(
    '--store-url <url>',
    'Pre-fill the SPARQL endpoint URL prompt for external backends.',
  )
  .action(async (opts: ActionOpts) => {
    // OT-RFC-41 Bundle B1c: monorepo guard. `dkg init` from a
    // contributor checkout is almost always a mistake — the
    // monorepo dev workflow is `pnpm dev` against the local CLI,
    // not a globally-installed config. Surface this loudly so
    // contributors don't accidentally write an Edge-style
    // ~/.dkg/config.json that then disagrees with the binary on
    // their $PATH.
    if (isDkgMonorepo()) {
      console.error(
        '\n[dkg init] Refusing to run from a DKG monorepo checkout.\n' +
          '\n' +
          '  Detected monorepo root: ' + (repoDir() ?? '(unknown)') + '\n' +
          '\n' +
          "  Monorepo dev workflow uses 'pnpm dev' against the local CLI build; ~/.dkg/config.json\n" +
          "  is for npm-installed nodes (`npm install -g @origintrail-official/dkg`). Writing one\n" +
          '  here would diverge from how the local CLI resolves its own working state.\n' +
          '\n' +
          '  If you really want to bootstrap a config for testing from this checkout, set\n' +
          '  DKG_HOME to a scratch directory:\n' +
          '\n' +
          '    DKG_HOME=/tmp/dkg-test dkg init\n' +
          '\n' +
          '  RFC: https://github.com/OriginTrail/dkgv10-spec/blob/main/rfcs/OT-RFC-41-edge-node-npm-only-install-and-update.md\n' +
          '\n',
      );
      process.exit(1);
    }


    await ensureDkgDir();
    const existing = await loadConfig();
    const network = await loadNetworkConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(resolve => {
        const suffix = def ? ` (${def})` : '';
        rl.question(`${q}${suffix}: `, answer => resolve(answer.trim() || def || ''));
      });

    if (network) {
      console.log(`DKG Node Setup — ${network.networkName}\n`);
    } else {
      console.log('DKG Node Setup\n');
    }

    const name = await ask('Node name', existing.name !== 'dkg-node' ? existing.name : undefined);
    // OT-RFC-41 Bundle B1d: `--role <edge|core>` flag short-circuits
    // the interactive role prompt. Default precedence:
    //   1. `--role` flag (explicit operator intent)
    //   2. existing config (re-running `dkg init` on an existing node)
    //   3. network default (per-network preferred role)
    //   4. 'edge' (safe default — RFC §1)
    const defaultRole = existing.nodeRole ?? network?.defaultNodeRole ?? 'edge';
    let nodeRole: 'edge' | 'core';
    if (opts.role === 'edge' || opts.role === 'core') {
      nodeRole = opts.role;
      console.log(`Node role: ${nodeRole} (from --role flag)`);
    } else if (opts.role !== undefined) {
      console.error(`Invalid --role value: ${JSON.stringify(opts.role)}. Expected 'edge' or 'core'.`);
      process.exit(1);
    } else {
      const roleAnswer = await ask('Node role (edge / core)', defaultRole);
      nodeRole = roleAnswer === 'core' ? 'core' : 'edge';
    }

    // Triple-store backend (RFC 120, plan PR 2 item 1 + PR 3 Docker
    // branch). Default: the daemon-managed local Oxigraph server
    // (`oxigraph-server`) — see promptStoreBackend. Operators selecting
    // "blazegraph" with a blank URL get the Docker convenience path
    // (if Docker is installed) — the namespace name defaults to the
    // node name so each operator gets their own DKG-owned namespace.
    const { storeBlock } = await promptStoreBackend({
      ask,
      existingStore: existing.store,
      flagBackend: opts.store,
      flagUrl: opts.storeUrl,
      nodeName: name || existing.name,
    });

    // Pre-fill relay from network config if user hasn't set one.
    // Show the first relay as the default, but only persist to config if the
    // user overrides it — otherwise the daemon will use the full relay list
    // from network/testnet.json, which stays current across updates.
    const networkDefaultRelay = network?.relays?.[0];
    const defaultRelay = existing.relay ?? networkDefaultRelay;
    const relay = nodeRole === 'edge'
      ? await ask('Relay multiaddr', defaultRelay)
      : await ask('Relay multiaddr (optional for core)', defaultRelay);

    const existingContextGraphs = resolveContextGraphs(existing);
    const defaultContextGraphs = existingContextGraphs.length
      ? existingContextGraphs.join(',')
      : resolveNetworkDefaultContextGraphs(network).length
        ? resolveNetworkDefaultContextGraphs(network).join(',')
        : undefined;
    const contextGraphsStr = await ask(
      'Context graphs to subscribe (comma-separated)',
      defaultContextGraphs,
    );
    const contextGraphs = contextGraphsStr ? contextGraphsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const apiPort = parseInt(await ask('API port', String(existing.apiPort)), 10);

    // OT-RFC-41 §4.3 Bundle B1d: post-rc.12, auto-update is npm-only.
    // The prompt wording is updated; the persisted config carries an
    // explicit `source: 'npm'` so the daemon's resolution is
    // unambiguous (no implicit `isStandaloneInstall()` probe).
    const autoUpdateDefault = existing.autoUpdate?.enabled ?? network?.autoUpdate?.enabled ?? false;
    const enableAutoUpdate = (await ask(
      'Enable auto-update (npm; y/n)',
      autoUpdateDefault ? 'y' : 'n',
    )).toLowerCase() === 'y';

    let autoUpdate = existing.autoUpdate;
    if (enableAutoUpdate) {
      // Effective upstream defaults — what the node would use if nothing were
      // persisted in ~/.dkg/config.json. Network config beats project.json.
      // We persist a field only when it differs from the upstream default, so
      // future changes to the shipped network or project config propagate on
      // the next daemon run without requiring a config rewrite. Without this
      // guard, every accepted-default ends up pinned in the custom config
      // forever.
      const proj = loadProjectConfig();
      const effectiveRepo = network?.autoUpdate?.repo ?? proj.repo;
      const effectiveBranch = network?.autoUpdate?.branch ?? proj.defaultBranch;
      const effectiveAllowPrerelease = network?.autoUpdate?.allowPrerelease ?? true;
      const effectiveSshKeyPath = network?.autoUpdate?.sshKeyPath ?? '';
      // Keep this in sync with `resolveAutoUpdateConfig` in config.ts.
      const effectiveInterval = network?.autoUpdate?.checkIntervalMinutes ?? 30;

      const defaultRepo = existing.autoUpdate?.repo ?? effectiveRepo;
      const defaultBranch = existing.autoUpdate?.branch ?? effectiveBranch;
      const defaultAllowPrerelease = existing.autoUpdate?.allowPrerelease ?? effectiveAllowPrerelease;
      const defaultSshKeyPath = existing.autoUpdate?.sshKeyPath ?? effectiveSshKeyPath;
      const defaultInterval = existing.autoUpdate?.checkIntervalMinutes ?? effectiveInterval;

      const repo = await ask('Git repo/path (owner/name, URL, or git@host:org/repo.git)', defaultRepo);
      const branch = await ask('Branch', defaultBranch);
      const allowPrerelease = (await ask(
        'Allow pre-release versions? (y/n)',
        defaultAllowPrerelease ? 'y' : 'n',
      )).toLowerCase() === 'y';
      const sshKeyPath = (await ask('SSH private key path (optional; blank uses agent/default SSH config)', defaultSshKeyPath)).trim();
      const interval = parseInt(await ask('Check interval (minutes)', String(defaultInterval)), 10);

      autoUpdate = {
        enabled: true,
        // OT-RFC-41 Bundle B1d: explicit source. Under rc.12+, fresh
        // installs always use the npm path (Edge: install -g; Core:
        // slot install). The legacy 'auto'/'git' values still parse
        // (rc.11 nodes carrying them upgrade-in-place) but the
        // daemon dispatches them as 'npm' under §5 PR 5.
        source: 'npm' as const,
        ...(repo && repo !== effectiveRepo ? { repo } : {}),
        ...(branch && branch !== effectiveBranch ? { branch } : {}),
        ...(allowPrerelease !== effectiveAllowPrerelease ? { allowPrerelease } : {}),
        ...(sshKeyPath && sshKeyPath !== effectiveSshKeyPath ? { sshKeyPath } : {}),
        ...(Number.isFinite(interval) && interval !== effectiveInterval ? { checkIntervalMinutes: interval } : {}),
        // Preserve advanced fields the wizard does not prompt for so a
        // rerun of `dkg init` doesn't silently revert operator tuning:
        //  - `buildTimeoutMs`: per-step overrides for slow ARM64 hosts
        //  - `sshCommand`: custom GIT_SSH_COMMAND (jump hosts, non-default
        //    port, custom IdentityFile, etc.)
        ...(existing.autoUpdate?.buildTimeoutMs ? { buildTimeoutMs: existing.autoUpdate.buildTimeoutMs } : {}),
        ...(existing.autoUpdate?.sshCommand ? { sshCommand: existing.autoUpdate.sshCommand } : {}),
      } as AutoUpdateConfig;
    }

    // Chain configuration. Field-merge: existing config wins per-field over
    // network defaults so an operator who's only customised RPC keeps that
    // override even after `dkg init` re-prompts.
    const chainDefaults = resolveChainConfig(existing, network);
    const defaultRpcUrl = chainDefaults?.rpcUrl;
    const defaultRpcUrls = chainDefaults?.rpcUrls?.join(', ') ?? '';
    const defaultHubAddress = chainDefaults?.hubAddress;
    const defaultChainId = chainDefaults?.chainId;

    console.log('\nBlockchain Configuration:');
    const rpcUrl = await ask('RPC URL', defaultRpcUrl);
    const rpcUrlsInput = await ask('Backup RPC URLs (comma-separated, optional; type "none" to clear)', defaultRpcUrls);
    const clearRpcUrls = rpcUrlsInput.trim().toLowerCase() === 'none';
    const rpcUrls = clearRpcUrls ? [] : rpcUrlsInput.split(',').map((s) => s.trim()).filter(Boolean);
    const hubAddress = await ask('Hub contract address', defaultHubAddress);
    const chainIdStr = await ask('Chain ID', defaultChainId);

    const chainSection = rpcUrl && hubAddress ? {
      type: 'evm' as const,
      rpcUrl,
      ...(clearRpcUrls || rpcUrls.length ? { rpcUrls } : {}),
      hubAddress,
      chainId: chainIdStr || undefined,
    } : undefined;

    // API authentication
    console.log('\nAPI Authentication:');
    const existingAuthEnabled = existing.auth?.enabled !== false;
    const enableAuth = (await ask(
      'Enable API authentication (y/n)',
      existingAuthEnabled ? 'y' : 'n',
    )).toLowerCase() === 'y';

    rl.close();

    const config = {
      ...existing,
      name: name || 'dkg-node',
      relay: (!existing.relay && relay === networkDefaultRelay) ? undefined : (relay || undefined),
      apiPort,
      nodeRole,
      contextGraphs,
      autoUpdate: enableAutoUpdate ? autoUpdate : existing.autoUpdate,
      chain: chainSection ?? existing.chain,
      auth: { enabled: enableAuth, tokens: existing.auth?.tokens },
      // Persist the chosen backend. `storeBlock === null` from the
      // wizard means "use the local default" — we explicitly clear any
      // existing block so re-running `dkg init` to switch from
      // blazegraph back to oxigraph actually applies.
      store: storeBlock ?? undefined,
    };
    await saveConfig(config);

    // Generate wallets eagerly so they're available for faucet funding
    let walletAddresses: string[] = [];
    try {
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());
      walletAddresses = getFundableWalletAddresses(opWallets);
    } catch (err: any) {
      console.warn(`\nWarning: could not generate wallets (${err?.message ?? String(err)}).`);
      console.warn('Wallets will be auto-generated on first "dkg start".');
    }

    console.log(`\nConfig saved to ${configPath()}`);
    console.log(`  name:       ${config.name}`);
    console.log(`  role:       ${config.nodeRole}`);
    const relayDisplay = config.relay
      ?? (network?.relays?.length ? `(network default — ${network.relays.length} relays)` : '(none)');
    console.log(`  relay:      ${relayDisplay}`);
    console.log(`  context graphs: ${contextGraphs.length ? contextGraphs.join(', ') : '(none)'}`);
    console.log(`  apiPort:    ${config.apiPort}`);
    console.log(`  auth:       ${enableAuth ? `enabled (token in ${dkgAuthTokenPath(dkgDir())})` : 'disabled'}`);
    console.log(
      `  store:      ${
        storeBlock
          // Endpoint shape varies by backend: blazegraph uses `options.url`,
          // sparql-http uses `options.queryEndpoint`, and oxigraph-server / a
          // preserved local block have no endpoint — render the backend name
          // alone in that case rather than dropping the configured endpoint.
          ? (() => {
              const o = storeBlock.options as { url?: string; queryEndpoint?: string } | undefined;
              const endpoint = o?.url ?? o?.queryEndpoint;
              return `${storeBlock.backend}${endpoint ? ` (${endpoint})` : ''}`;
            })()
          : 'oxigraph (local default)'
      }`,
    );
    {
      const resolved = resolveAutoUpdateConfig(config, network);
      console.log(
        `  autoUpdate: ${
          resolved
            ? `${resolved.repo}@${resolved.branch}` +
              `${resolved.allowPrerelease ? ' (pre-release allowed)' : ''}` +
              `${resolved.sshKeyPath ? ` (ssh key: ${resolved.sshKeyPath})` : ''}`
            : 'disabled'
        }`,
      );
    }
    {
      // Display the effective (config + network) merged view, so an operator
      // who only set rpcUrl still sees the inherited hub from the network.
      const effective = resolveChainConfig(config, network);
      console.log(`  chain:      ${effective?.rpcUrl && effective?.hubAddress
        ? `${effective.rpcUrl}${effective.rpcUrls?.length ? ` (+${effective.rpcUrls.length} backups)` : ''} (hub: ${effective.hubAddress.slice(0, 10)}...)`
        : '(not configured)'}`);
    }
    if (network) {
      console.log(`  network:    ${network.networkName}`);
    }
    if (walletAddresses.length) {
      console.log(`  wallets:    ${walletAddresses.join(', ')}`);
    }

    // Auto-fund from testnet faucet if available
    if (network?.faucet?.url && walletAddresses.length > 0) {
      if (walletAddresses.length > FAUCET_WALLETS_PER_REQUEST) {
        console.log(`\nNote: faucet supports up to ${FAUCET_WALLETS_PER_REQUEST} wallets per request; funding wallets in batches.`);
      }
      console.log(`\nRequesting testnet tokens from faucet...`);
      try {
        const result = await requestFaucetFunding(
          network.faucet.url, network.faucet.mode, walletAddresses, config.name,
        );
        if (result.success) {
          console.log(`  Funded: ${result.funded.join(', ')}`);
          if (result.error) {
            console.log(`  Faucet partially completed (${result.error}). Retry later for any remaining wallets.`);
            if (result.failedWallets?.length) {
              console.log(`  Remaining: ${result.failedWallets.join(', ')}`);
            }
          }
        } else if (result.error) {
          console.log(`  Faucet request failed (${result.error}). Fund manually or retry later.`);
        } else {
          console.log('  Faucet returned no successful transactions (you may already have tokens or hit a cooldown).');
        }
      } catch (err: any) {
        console.log(`  Faucet unavailable: ${err?.message ?? String(err)}. Fund your wallet manually.`);
      }
    }

    console.log(`\nRun "dkg start" to start the node.`);
  });
}
