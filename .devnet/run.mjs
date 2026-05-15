#!/usr/bin/env node
// .devnet/run.mjs — issue #519 TB-0007 runtime smoke entrypoint.
//
// The literal orchestrator test_command is:
//   pnpm -r build && cd .devnet && \
//   DKG_HOME=.devnet/node1 NODE2_DKG_HOME=.devnet/node2 \
//   node run.mjs --no-pause
//
// `.devnet/` is a gitignored runtime workspace; only this entrypoint and
// its pure helper/test are tracked (see .gitignore negations). The shim:
//
//   1. Chdir to repo root so `.devnet/nodeN` env paths resolve there,
//      not against the `cd .devnet` cwd.
//   2. Actively probe Hardhat RPC + node1/node2 `/api/status`. Filesystem
//      markers lie after daemons exit, so on any red probe we stop stale
//      processes, wipe per-node state, pick a free port base and run
//      `scripts/devnet.sh start 2`, then re-probe.
//   3. Drive the scripted V10 PCA HTTP round-trip against the live
//      node1 daemon (POST /api/pca → POST /api/pca/:id/agent → publish a
//      KC as that agent → assert the discounted cost ON CHAIN, not just
//      a 200 → GET /api/pca/:id) and write the evidence to
//      `.scratch/issue-519/verify.md`.
//
// Per project memory `feedback_devnet_runtime_verify.md` there is NO
// fallback from a failed runtime smoke to a static check — a failed
// smoke fails the test_command.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { assertDiscountTaken, buildVerifyMarkdown } from './pca-smoke-lib.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, '..');
process.chdir(REPO_ROOT);

// pnpm's default isolated node_modules layout does NOT hoist `ethers`
// to the repo root, so a top-level `import 'ethers'` from `.devnet/`
// is unresolvable. Resolve it lazily from the evm-module package (which
// declares it) — the same technique `scripts/devnet.sh` uses for its
// inline ethers snippets. Lazy so the boot path runs even before
// `pnpm -r build` has populated workspace node_modules.
let _ethers;
function requireEthers() {
  if (!_ethers) {
    const req = createRequire(join(REPO_ROOT, 'packages/evm-module/package.json'));
    _ethers = req('ethers').ethers ?? req('ethers');
  }
  return _ethers;
}

const NUM_NODES = 2;
const PROBE_TIMEOUT_MS = 3000;
const HARDHAT_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CONTEXT_GRAPH = 'devnet-test';
// 600k TRAC commit lands in the top discount tier (mirrors the
// conviction-lazy-settle suite's tier choice) so the publish takes the
// discount branch and `assertDiscountTaken` has a real delta to check.
const COMMIT_TRAC = '600000';

let HARDHAT_PORT = Number(process.env.HARDHAT_PORT ?? 8545);
let API_PORT_BASE = Number(process.env.NODE1_API_PORT ?? 9201);
let NODE1_PORT = API_PORT_BASE;
let NODE2_PORT = API_PORT_BASE + 1;
let LIBP2P_PORT_BASE = Number(process.env.LIBP2P_PORT_BASE ?? 10001);

const log = (...p) => console.log('[.devnet/run.mjs]', ...p);

function isPortFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePortBase() {
  for (const offset of [0, 10000, 20000, 30000]) {
    const apiBase = 9201 + offset;
    const libp2pBase = 10001 + offset;
    const hardhatPort = 8545 + offset;
    const tries = new Set([hardhatPort]);
    for (let n = 0; n < NUM_NODES; n++) {
      tries.add(apiBase + n);
      tries.add(libp2pBase + n);
    }
    let allFree = true;
    for (const port of tries) {
      if (!(await isPortFree(port))) { allFree = false; break; }
    }
    if (allFree) return { hardhatPort, apiBase, libp2pBase, offset };
  }
  return null;
}

function readAuthToken(nodeNum) {
  const p = join(REPO_ROOT, '.devnet', `node${nodeNum}`, 'auth.token');
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf-8')
      .split(/\n+/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? null;
  } catch { return null; }
}

async function probeHardhatRpc() {
  try {
    const r = await fetch(`http://127.0.0.1:${HARDHAT_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j?.result);
  } catch { return false; }
}

async function probeNodeApi(nodeNum, port) {
  const token = readAuthToken(nodeNum);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return r.ok;
  } catch { return false; }
}

async function probeDevnetLive() {
  const [hardhat, node1, node2] = await Promise.all([
    probeHardhatRpc(),
    probeNodeApi(1, NODE1_PORT),
    probeNodeApi(2, NODE2_PORT),
  ]);
  return { allUp: hardhat && node1 && node2, hardhat, node1, node2 };
}

function runDevnetScript(arg) {
  log(`exec scripts/devnet.sh ${arg} (HARDHAT_PORT=${HARDHAT_PORT} API_PORT_BASE=${API_PORT_BASE} LIBP2P_PORT_BASE=${LIBP2P_PORT_BASE})`);
  const proc = spawnSync(
    './scripts/devnet.sh',
    [arg, ...(arg === 'start' ? [String(NUM_NODES)] : [])],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HARDHAT_PORT: String(HARDHAT_PORT),
        API_PORT_BASE: String(API_PORT_BASE),
        LIBP2P_PORT_BASE: String(LIBP2P_PORT_BASE),
        // The publish step routes through the async publisher
        // (publisher-wallets.json wallet[0] is the agent we register);
        // that block is off by default in scripts/devnet.sh.
        DEVNET_ENABLE_PUBLISHER: process.env.DEVNET_ENABLE_PUBLISHER ?? '1',
      },
    },
  );
  return proc.status ?? 1;
}

async function ensureDevnetLive() {
  let live = await probeDevnetLive();
  if (live.allUp) {
    log('devnet probes green (hardhat RPC + node1 + node2 /api/status)');
    return 0;
  }
  log(`devnet probes red — hardhat=${live.hardhat} node1=${live.node1} node2=${live.node2}; (re)booting`);
  runDevnetScript('stop');
  const devnetDir = join(REPO_ROOT, '.devnet');
  for (const sub of ['hardhat', 'node1', 'node2', 'node3', 'node4', 'node5', 'node6']) {
    const p = join(devnetDir, sub);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  const picked = await pickFreePortBase();
  if (!picked) { log('no free port base found'); return 1; }
  HARDHAT_PORT = picked.hardhatPort;
  API_PORT_BASE = picked.apiBase;
  NODE1_PORT = picked.apiBase;
  NODE2_PORT = picked.apiBase + 1;
  LIBP2P_PORT_BASE = picked.libp2pBase;
  log(`port assignment offset=+${picked.offset} (hardhat=${HARDHAT_PORT}, api=${API_PORT_BASE}.., libp2p=${LIBP2P_PORT_BASE}..)`);
  const startStatus = runDevnetScript('start');
  if (startStatus !== 0) { log(`scripts/devnet.sh start failed exit ${startStatus}`); return startStatus; }
  for (let attempt = 1; attempt <= 20; attempt++) {
    live = await probeDevnetLive();
    if (live.allUp) { log(`devnet probes green after boot (attempt ${attempt})`); return 0; }
    await sleep(1500);
  }
  log(`devnet still not live — hardhat=${live.hardhat} node1=${live.node1} node2=${live.node2}`);
  return 1;
}

function loadContract(ethers, name, abi, runner) {
  const contractsPath = join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
  const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const addr = contracts.contracts[name]?.evmAddress;
  if (!addr) throw new Error(`contract ${name} missing from localhost_contracts.json`);
  return new ethers.Contract(addr, abi, runner);
}

function readNode1() {
  const home = join(REPO_ROOT, '.devnet', 'node1');
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const pubPath = join(home, 'publisher-wallets.json');
  if (!existsSync(pubPath)) {
    throw new Error('publisher-wallets.json missing — devnet booted without DEVNET_ENABLE_PUBLISHER=1');
  }
  const pub = JSON.parse(readFileSync(pubPath, 'utf8'));
  const agent = pub.wallets?.[0]?.address;
  if (!agent) throw new Error('no publisher agent wallet in publisher-wallets.json');
  const allAddrs = [
    wallets.adminWallet?.address,
    ...(wallets.wallets ?? []).map((w) => w.address),
  ].filter(Boolean);
  return {
    home,
    apiPort: config.apiPort ?? NODE1_PORT,
    authToken: readAuthToken(1) ?? '',
    agent,
    fundAddrs: allAddrs,
  };
}

async function api(node, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const r = await fetch(`http://127.0.0.1:${node.apiPort}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

function dkgPublish(node, file) {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'packages/cli/dist/cli.js'), 'publish', CONTEXT_GRAPH, '--file', file],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_NO_BLUE_GREEN: '1',
          DKG_HOME: node.home,
          DKG_API_PORT: String(node.apiPort),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`dkg publish timeout (120s)\n${stdout}\n${stderr}`));
    }, 120_000);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rej(new Error(`dkg publish exit=${code}\n${stdout}\n${stderr}`)); return; }
      const kc = /KC ID:\s*(\d+)/i.exec(stdout);
      const tx = /TX hash:\s*(0x[0-9a-fA-F]+)/i.exec(stdout);
      if (!kc || !tx) { rej(new Error(`could not parse publish output\n${stdout}`)); return; }
      res({ kcId: kc[1], txHash: tx[1] });
    });
  });
}

async function runPcaSmoke() {
  const steps = [];
  let accountId = 'n/a';
  let passed = false;
  try {
    const ethers = requireEthers();
    const provider = new ethers.JsonRpcProvider(
      `http://127.0.0.1:${HARDHAT_PORT}`, { chainId: 31337, name: 'localhost' });
    provider.pollingInterval = 250;
    const node = readNode1();
    log(`node1 apiPort=${node.apiPort} agent=${node.agent}`);

    // Pre-fund every node1 EOA with TRAC so the daemon's chain signer
    // (whichever wallet it is) can cover createAccount's transferFrom.
    const deployer = new ethers.Wallet(HARDHAT_DEPLOYER_KEY, provider);
    const token = loadContract(ethers, 'Token', [
      'function mint(address,uint256)',
      'function balanceOf(address) view returns (uint256)',
    ], deployer);
    for (const addr of node.fundAddrs) {
      await (await token.mint(addr, ethers.parseEther('2000000'))).wait();
    }
    log(`minted 2,000,000 TRAC to ${node.fundAddrs.length} node1 EOAs`);

    // 1) POST /api/pca — mint a V10 conviction NFT to the daemon EOA.
    const create = await api(node, 'POST', '/api/pca', { tokens: COMMIT_TRAC });
    steps.push({
      name: 'POST /api/pca',
      status: create.status,
      detail: create.status === 200
        ? `accountId=${create.json.accountId} txHash=${create.json.txHash}`
        : JSON.stringify(create.json),
    });
    if (create.status !== 200) throw new Error('POST /api/pca did not return 200');
    accountId = create.json.accountId;

    // 2) POST /api/pca/:id/agent — register the publisher wallet.
    const reg = await api(node, 'POST', `/api/pca/${accountId}/agent`, { agent: node.agent });
    steps.push({
      name: 'POST /api/pca/:id/agent',
      status: reg.status,
      detail: reg.status === 200
        ? `agent=${node.agent} registered=${reg.json.registered}`
        : JSON.stringify(reg.json),
    });
    if (reg.status !== 200 || reg.json.registered !== true) {
      throw new Error('agent registration did not return registered=true');
    }

    // 3) Publish a KC as that agent (operator's official discount path).
    const nq = join(tmpdir(), `pca-smoke-${Date.now()}.nq`);
    writeFileSync(nq, `<urn:issue519:smoke:${Date.now()}> <https://schema.org/name> "pca-smoke" .\n`);
    const pub = await dkgPublish(node, nq);
    steps.push({ name: 'publish KC as agent', status: 'ok', detail: `kcId=${pub.kcId} txHash=${pub.txHash}` });

    // 4) Assert the discount ON CHAIN via the NFT's CostCovered event.
    const nft = loadContract(ethers, 'DKGPublishingConvictionNFT', [
      'event CostCovered(uint256 indexed accountId, uint40 indexed epoch, uint96 baseCost, uint96 discountedCost, uint96 drawnFromEpoch, uint96 drawnFromTopUp)',
    ], provider);
    const receipt = await provider.getTransactionReceipt(pub.txHash);
    if (!receipt) throw new Error(`no receipt for publish tx ${pub.txHash}`);
    let baseCost = 0n;
    let discountedCost = 0n;
    const nftAddr = (await nft.getAddress()).toLowerCase();
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== nftAddr) continue;
      try {
        const parsed = nft.interface.parseLog({ topics: [...lg.topics], data: lg.data });
        if (parsed?.name === 'CostCovered' && String(parsed.args.accountId) === String(accountId)) {
          baseCost += BigInt(parsed.args.baseCost);
          discountedCost += BigInt(parsed.args.discountedCost);
        }
      } catch { /* not a CostCovered log */ }
    }
    const verdict = assertDiscountTaken({ baseCost, discountedCost });
    steps.push({
      name: 'on-chain discount',
      status: verdict.ok ? 'ok' : 'FAIL',
      detail: `base=${ethers.formatEther(baseCost)} discounted=${ethers.formatEther(discountedCost)} TRAC — ${verdict.reason}`,
    });
    if (!verdict.ok) throw new Error(`discount assertion failed: ${verdict.reason}`);

    // 5) GET /api/pca/:id — round-trip the V10 serialized shape.
    const info = await api(node, 'GET', `/api/pca/${accountId}`);
    const agentCount = info.json?.agentCount;
    steps.push({
      name: 'GET /api/pca/:id',
      status: info.status,
      detail: info.status === 200
        ? `agentCount=${agentCount} discountBps=${info.json.discountBps} topUpBuffer=${info.json.topUpBuffer}`
        : JSON.stringify(info.json),
    });
    if (info.status !== 200 || !(Number(agentCount) >= 1)) {
      throw new Error('GET /api/pca/:id did not reflect the registered agent');
    }
    passed = true;
  } catch (err) {
    log(`PCA smoke failed: ${err?.message ?? err}`);
    if (steps.length === 0 || steps[steps.length - 1].status === 200 || steps[steps.length - 1].status === 'ok') {
      steps.push({ name: 'smoke', status: 'FAIL', detail: String(err?.message ?? err) });
    }
  }

  const scratchDir = join(REPO_ROOT, '.scratch', 'issue-519');
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(
    join(scratchDir, 'verify.md'),
    buildVerifyMarkdown({ accountId, steps, passed }),
  );
  log(`evidence written to .scratch/issue-519/verify.md (verdict=${passed ? 'PASS' : 'FAIL'})`);
  for (const s of steps) log(`  ${s.status === 200 || s.status === 'ok' ? 'PASS' : s.status}  ${s.name} — ${s.detail}`);
  return passed ? 0 : 1;
}

const ensureStatus = await ensureDevnetLive();
if (ensureStatus !== 0) process.exit(ensureStatus);
const code = await runPcaSmoke();
process.exit(code);
