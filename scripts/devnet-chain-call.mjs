#!/usr/bin/env node
/*
 * devnet-chain-call.mjs — generic read/write helper for the local devnet's
 * deployed contracts. Loads the deployment map (localhost_contracts.json)
 * and the committed ABI for the named contract, then calls the requested
 * method. No hand-written fragments — the full committed ABI is the source
 * of truth, so this survives selector/method renames as long as the ABI is
 * regenerated.
 *
 * Usage:
 *   node devnet-chain-call.mjs <Contract> <method> [--key 0x..] [--json '<args-array>']
 *
 * Examples:
 *   node devnet-chain-call.mjs ParametersStorage protocolTreasury
 *   node devnet-chain-call.mjs ParametersStorage setProtocolTreasury --key 0xac09.. --json '["0xabc..."]'
 *   node devnet-chain-call.mjs Token balanceOf --json '["0xabc..."]'
 *
 * Output: a single JSON line: { ok, result?, txHash?, error? }
 *   - view/pure calls populate `result` (stringified, BigInt-safe).
 *   - state-changing calls (when --key given) populate `txHash`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '..');

// ethers v6 is not hoisted to the repo root in this pnpm monorepo; resolve it
// from a package that depends on it (evm-module), falling back to chain.
let ethers;
{
  const candidates = [
    path.join(REPO_ROOT, 'packages/evm-module/package.json'),
    path.join(REPO_ROOT, 'packages/chain/package.json'),
  ];
  let loaded = null;
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      loaded = req('ethers');
      break;
    } catch {
      /* try next */
    }
  }
  if (!loaded) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'cannot resolve ethers from evm-module/chain' }) + '\n');
    process.exit(1);
  }
  ethers = loaded.ethers || loaded;
}
const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const CONTRACTS_JSON =
  process.env.CONTRACTS_JSON ||
  path.join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
const ABI_DIR = process.env.ABI_DIR || path.join(REPO_ROOT, 'packages/evm-module/abi');

function out(o) {
  process.stdout.write(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}

async function main() {
  const [contractName, method] = process.argv.slice(2);
  if (!contractName || !method) {
    out({ ok: false, error: 'usage: <Contract> <method> [--key 0x..] [--json <args>]' });
    process.exit(2);
  }
  let key = null;
  let args = [];
  const argv = process.argv.slice(4);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key') key = argv[++i];
    else if (argv[i] === '--json') args = JSON.parse(argv[++i]);
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const deployment = JSON.parse(fs.readFileSync(CONTRACTS_JSON, 'utf8'));
  const map = deployment.contracts || deployment;
  const addr = map[contractName]?.evmAddress || map[contractName]?.address;
  if (!addr) {
    out({ ok: false, error: `contract ${contractName} not in deployment map` });
    process.exit(1);
  }
  const abiPath = path.join(ABI_DIR, `${contractName}.json`);
  if (!fs.existsSync(abiPath)) {
    out({ ok: false, error: `ABI not found: ${abiPath}` });
    process.exit(1);
  }
  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

  // Verify the method exists in the ABI so callers can branch on "unsupported".
  const hasMethod = abi.some((f) => f.type === 'function' && f.name === method);
  if (!hasMethod) {
    out({ ok: false, error: `method ${method} not in ${contractName} ABI`, unsupported: true });
    process.exit(3);
  }

  const signerOrProvider = key ? new ethers.Wallet(key, provider) : provider;
  const c = new ethers.Contract(addr, abi, signerOrProvider);

  try {
    if (key) {
      const tx = await c[method](...args);
      const receipt = await tx.wait();
      out({ ok: true, txHash: tx.hash, status: receipt.status, address: addr });
    } else {
      const res = await c[method](...args);
      out({ ok: true, result: res, address: addr });
    }
  } catch (e) {
    out({ ok: false, error: e?.shortMessage || e?.message || String(e), address: addr });
    process.exit(1);
  }
}

main().catch((e) => {
  out({ ok: false, error: e?.message || String(e) });
  process.exit(1);
});
