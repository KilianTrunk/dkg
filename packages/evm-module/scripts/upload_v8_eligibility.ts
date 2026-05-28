/**
 * Upload an off-chain eligibility CSV into V8MigrationEligibility on a
 * deployed network, then optionally freeze the registry.
 *
 * Pipeline (operator playbook step):
 *   off-chain snapshot (snapshot_v8_eligibility.ts in dkg-evm-module)
 *     → simple CSV (identityId,delegator,eligibleAmount)
 *       → THIS SCRIPT
 *         → V8MigrationEligibility.setEligibleBatch(...)
 *         → V8MigrationEligibility.freeze()
 *           → V10 migration window opens
 *
 * Idempotency: re-runs are safe. The contract treats already-eligible
 * pairs as no-ops (no event, no counter bump), and this script also
 * pre-filters them client-side so we don't burn calldata on duplicates.
 *
 * Usage:
 *   npx ts-node --esm scripts/upload_v8_eligibility.ts \
 *     --network <name> \
 *     --csv <path> \
 *     [--chunk N] [--freeze] [--dry-run]
 *
 * `--network` matches the keys in `deployments/<network>_contracts.json`
 * (e.g. `localhost`, `base_sepolia_v10`, `gnosis_mainnet`).
 *
 * Signer:
 *   * `localhost`         → default Hardhat mnemonic, accounts[0].
 *   * any other network   → `EVM_PRIVATE_KEY_<NETWORK_UPPER>` from .env.
 *
 * RPC:
 *   * `localhost`         → http://localhost:8545
 *   * any other network   → `RPC_<NETWORK_UPPER>` from .env, with the
 *                           same fallbacks `utils/network.ts` uses for
 *                           the hardhat config.
 */

import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// ---- CLI parsing -----------------------------------------------------------

type Args = {
  network: string;
  csv: string;
  chunk: number;
  freeze: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { chunk: 500, freeze: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--network') out.network = argv[++i];
    else if (a === '--csv') out.csv = argv[++i];
    else if (a === '--chunk') {
      const raw = argv[++i];
      // `i += args.chunk` advances the upload loop, so a non-positive
      // (or NaN) chunk would either infinite-loop or skip work. Validate
      // up-front before any RPC / signer setup so the operator gets a
      // fast, deterministic error.
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(
          `--chunk must be a positive integer; got "${raw}" (parsed as ${parsed}).`,
        );
        process.exit(2);
      }
      out.chunk = parsed;
    }
    else if (a === '--freeze') out.freeze = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!out.network || !out.csv) {
    printHelp();
    process.exit(2);
  }
  return out as Args;
}

function printHelp() {
  console.error(
    'Usage: upload_v8_eligibility --network <name> --csv <path> [--chunk N] [--freeze] [--dry-run]',
  );
}

// ---- network resolution (mirrors utils/network.ts) -------------------------

function rpcUrlFor(network: string): string {
  const fromEnv = process.env[`RPC_${network.toUpperCase()}`];
  if (fromEnv && fromEnv !== '') return fromEnv;
  if (network === 'localhost') return 'http://localhost:8545';
  if (network === 'base_sepolia_v10') return 'https://sepolia.base.org';
  if (network === 'base_mainnet') return 'https://mainnet.base.org';
  if (network === 'gnosis_mainnet') return 'https://rpc.gnosischain.com';
  throw new Error(`No RPC URL for network=${network}; set RPC_${network.toUpperCase()}`);
}

function signerFor(network: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  if (network === 'localhost') {
    // Hardhat default mnemonic — accounts[0] is the deployer/HubOwner.
    const mnemonic = ethers.Mnemonic.fromPhrase(
      'test test test test test test test test test test test junk',
    );
    return ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0").connect(provider) as
      unknown as ethers.Wallet;
  }
  const pk = process.env[`EVM_PRIVATE_KEY_${network.toUpperCase()}`];
  if (!pk || pk === '') {
    throw new Error(`Missing EVM_PRIVATE_KEY_${network.toUpperCase()} in .env`);
  }
  return new ethers.Wallet(pk, provider);
}

// ---- deployment lookup -----------------------------------------------------

function registryAddressFor(network: string): string {
  const path = resolve(__dirname, '..', 'deployments', `${network}_contracts.json`);
  if (!existsSync(path)) {
    throw new Error(`Deployment file not found: ${path}`);
  }
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const entry = data?.contracts?.V8MigrationEligibility;
  if (!entry?.evmAddress) {
    throw new Error(
      `V8MigrationEligibility not registered in ${path}. ` +
        `Did you redeploy V10 with the v3.1.0 / 4.1.0 stack?`,
    );
  }
  return entry.evmAddress;
}

// ---- CSV loading -----------------------------------------------------------

type EligibleRow = { identityId: bigint; delegator: string };

function parseCsv(path: string): EligibleRow[] {
  const raw = readFileSync(path, 'utf-8').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return [];

  const header = lines[0].split(',').map((s) => s.trim());
  const idxId = header.indexOf('identityId');
  const idxDel = header.indexOf('delegator');
  const idxAmt = header.indexOf('eligibleAmount');
  if (idxId < 0 || idxDel < 0 || idxAmt < 0) {
    throw new Error(
      `Expected CSV header [identityId,delegator,eligibleAmount], got [${header.join(',')}]`,
    );
  }

  const rows: EligibleRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue;
    const amt = BigInt((cols[idxAmt] ?? '0').trim() || '0');
    if (amt <= 0n) continue;
    const id = BigInt((cols[idxId] ?? '0').trim());
    const del = ethers.getAddress((cols[idxDel] ?? '').trim());
    const key = `${id.toString()}-${del.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ identityId: id, delegator: del });
  }
  return rows;
}

// ---- main ------------------------------------------------------------------

const REGISTRY_ABI = [
  'function frozen() view returns (bool)',
  'function eligibleCount() view returns (uint256)',
  'function isEligible(uint72,address) view returns (bool)',
  'function setEligibleBatch(uint72[],address[]) external',
  'function freeze() external',
  'function name() view returns (string)',
  'function version() view returns (string)',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const provider = new ethers.JsonRpcProvider(rpcUrlFor(args.network));
  // Wrap in NonceManager so back-to-back transactions (chunked
  // setEligibleBatch + freeze) don't race against `getTransactionCount`
  // under hardhat-node's automine, which refuses to queue pending tx.
  const signer = new ethers.NonceManager(signerFor(args.network, provider));
  const registryAddr = registryAddressFor(args.network);
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, signer);

  const signerAddr = await signer.getAddress();
  console.log(`Network: ${args.network}`);
  console.log(`Registry: ${registryAddr}`);
  console.log(`Signer: ${signerAddr}`);
  console.log(`CSV: ${args.csv}`);
  console.log(`Chunk size: ${args.chunk}`);
  console.log(`Dry run: ${args.dryRun}`);
  console.log(`Freeze on success: ${args.freeze}`);

  const [name, version, frozen, before] = await Promise.all([
    registry.name(),
    registry.version(),
    registry.frozen(),
    registry.eligibleCount(),
  ]);
  console.log(`On-chain registry: ${name} v${version}`);
  console.log(`frozen=${frozen}, eligibleCount=${before}`);
  if (frozen) {
    console.error('Registry already frozen — aborting.');
    process.exit(1);
  }

  const allRows = parseCsv(args.csv);
  console.log(`CSV rows with eligibleAmount > 0: ${allRows.length}`);

  // Filter out pairs already on-chain to keep the upload idempotent
  // and minimise gas on retries. Reads are cheap; we do them in
  // bounded parallel batches.
  const READ_BATCH = 50;
  const rows: EligibleRow[] = [];
  for (let i = 0; i < allRows.length; i += READ_BATCH) {
    const slice = allRows.slice(i, i + READ_BATCH);
    const flags = await Promise.all(
      slice.map((r) => registry.isEligible(r.identityId, r.delegator)),
    );
    flags.forEach((isOn, j) => {
      if (!isOn) rows.push(slice[j]);
    });
  }
  console.log(`Pairs already on-chain: ${allRows.length - rows.length}`);
  console.log(`Pairs to upload: ${rows.length}`);

  if (args.dryRun) {
    if (rows.length > 0) {
      console.log(`First ${Math.min(5, rows.length)} preview:`);
      rows.slice(0, 5).forEach((r) =>
        console.log(`  identityId=${r.identityId} delegator=${r.delegator}`),
      );
    }
    console.log('Dry run — no transactions sent.');
    return;
  }

  // Send chunks sequentially. We deliberately wait for each tx to
  // confirm before sending the next so a failure halts cleanly and
  // the operator can resume from the last confirmed block.
  let added = 0;
  for (let i = 0; i < rows.length; i += args.chunk) {
    const batch = rows.slice(i, i + args.chunk);
    const ids = batch.map((r) => r.identityId);
    const addrs = batch.map((r) => r.delegator);
    const tx = await registry.setEligibleBatch(ids, addrs);
    const receipt = await tx.wait();
    added += batch.length;
    console.log(
      `[${added}/${rows.length}] block=${receipt!.blockNumber} gasUsed=${receipt!.gasUsed} tx=${tx.hash}`,
    );
  }

  const after = await registry.eligibleCount();
  const expected = BigInt(before) + BigInt(rows.length);
  console.log(`eligibleCount: ${before} → ${after} (expected ${expected})`);
  if (after !== expected) {
    console.error('Mismatch on eligibleCount — investigate before freezing.');
    process.exit(1);
  }

  if (args.freeze) {
    console.log('Freezing registry...');
    const tx = await registry.freeze();
    const receipt = await tx.wait();
    console.log(`Frozen in block ${receipt!.blockNumber} (tx=${tx.hash})`);
    const isFrozen = await registry.frozen();
    if (!isFrozen) {
      console.error('Freeze did not stick — investigate.');
      process.exit(1);
    }
    console.log('Done. Registry is now immutable.');
  } else {
    console.log('Done. Pass --freeze on a follow-up run when ready to lock the registry.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
