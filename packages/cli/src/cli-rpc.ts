import { ethers } from 'ethers';
import { resolveRpcUrls } from '@origintrail-official/dkg-chain';
import { cliSleep, cliErrorMessage } from './cli-helpers.js';

const CLI_RPC_READ_STALL_TIMEOUT_MS = 4_000;
const CLI_RPC_BROADCAST_TIMEOUT_MS = 10_000;
const CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS = 5_000;
const CLI_RPC_RECEIPT_POLL_INTERVAL_MS = 2_000;
const CLI_RPC_RECEIPT_TIMEOUT_MS = 180_000;

function cliWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      (err as any).code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function isCliKnownTransactionError(err: unknown): boolean {
  const code = String((err as any)?.code ?? (err as any)?.error?.code ?? '').toUpperCase();
  const msg = cliErrorMessage(err).toLowerCase();
  return code === 'NONCE_EXPIRED'
    || msg.includes('already known')
    || msg.includes('known transaction')
    || msg.includes('already imported')
    || msg.includes('transaction already in mempool')
    || msg.includes('already exists')
    || msg.includes('nonce too low')
    || msg.includes('duplicate transaction');
}

function isCliRetryableRpcError(err: unknown): boolean {
  const code = String((err as any)?.code ?? (err as any)?.error?.code ?? '').toUpperCase();
  const status =
    (err as any)?.status ??
    (err as any)?.statusCode ??
    (err as any)?.response?.status ??
    (err as any)?.error?.status;
  const msg = cliErrorMessage(err).toLowerCase();
  if (code === 'CALL_EXCEPTION' || code === 'INSUFFICIENT_FUNDS' || code === 'NONCE_EXPIRED'
    || code === 'RPC_RECEIPT_LOOKUP_FAILED'
    || code === 'REPLACEMENT_UNDERPRICED' || code === 'ACTION_REJECTED' || code === 'INVALID_ARGUMENT') {
    return false;
  }
  if (msg.includes('execution reverted') || msg.includes('call exception')
    || msg.includes('insufficient funds') || msg.includes('invalid argument')
    || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced')) {
    return false;
  }
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  if (code === 'TIMEOUT' || code === 'SERVER_ERROR' || code === 'NETWORK_ERROR'
    || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT'
    || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UNKNOWN_ERROR') {
    return true;
  }
  return /timeout|timed out|network|socket|reset|econnreset|econnrefused|etimedout|enotfound|rate limit|too many requests|429|503|502|500|gateway|temporarily unavailable|fetch failed|connection/i
    .test(msg);
}

function createCliEvmProviders(rpcUrl: string, rpcUrls?: string[]): {
  urls: string[];
  providers: ethers.JsonRpcProvider[];
  readProvider: ethers.JsonRpcProvider | ethers.FallbackProvider;
} {
  const urls = resolveRpcUrls(rpcUrl, rpcUrls);
  const providers = urls.map((url) => new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
  const readProvider = providers.length === 1
    ? providers[0]
    : new ethers.FallbackProvider(
      providers.map((provider, index) => ({
        provider,
        priority: index + 1,
        stallTimeout: CLI_RPC_READ_STALL_TIMEOUT_MS,
        weight: 1,
      })),
      undefined,
      { quorum: 1 },
    );
  return { urls, providers, readProvider };
}

async function getCliReceiptWithFailover(
  providers: ethers.JsonRpcProvider[],
  txHash: string,
): Promise<ethers.TransactionReceipt | null> {
  let lastRetryable: unknown;
  let sawNonErrorResponse = false;
  for (let i = 0; i < providers.length; i += 1) {
    try {
      const receipt = await cliWithTimeout(
        providers[i].getTransactionReceipt(txHash),
        CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
        `receipt lookup via RPC #${i + 1}`,
      );
      sawNonErrorResponse = true;
      if (receipt) return receipt;
    } catch (err) {
      if (!isCliRetryableRpcError(err)) throw err;
      lastRetryable = err;
    }
  }
  if (lastRetryable && !sawNonErrorResponse) {
    const err = new Error(
      `Receipt lookup for transaction ${txHash} failed on all configured RPC endpoints: ${cliErrorMessage(lastRetryable)}`,
      { cause: lastRetryable },
    );
    (err as any).code = 'RPC_RECEIPT_LOOKUP_FAILED';
    throw err;
  }
  return null;
}

function assertCliSuccessfulReceipt(receipt: ethers.TransactionReceipt, txHash: string): void {
  if (receipt.status !== 0) return;
  const err = new Error(`Transaction ${txHash} was mined but reverted (status=0)`);
  (err as any).code = 'CALL_EXCEPTION';
  (err as any).receipt = receipt;
  throw err;
}

async function sendCliRawTransactionWithFailover(
  providers: ethers.JsonRpcProvider[],
  signedTx: string,
  txHash: string,
): Promise<ethers.TransactionReceipt> {
  let lastError: unknown;
  for (let i = 0; i < providers.length; i += 1) {
    try {
      await cliWithTimeout(
        providers[i].broadcastTransaction(signedTx),
        CLI_RPC_BROADCAST_TIMEOUT_MS,
        `broadcast via RPC #${i + 1}`,
      );
      lastError = undefined;
      break;
    } catch (err) {
      if (isCliKnownTransactionError(err)) {
        lastError = undefined;
        break;
      }
      if (!isCliRetryableRpcError(err)) throw err;
      lastError = err;
    }
  }
  if (lastError) {
    throw new Error(`Broadcast failed on all configured RPC endpoints: ${cliErrorMessage(lastError)}`, { cause: lastError });
  }

  const deadline = Date.now() + CLI_RPC_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await getCliReceiptWithFailover(providers, txHash);
    if (receipt) {
      assertCliSuccessfulReceipt(receipt, txHash);
      return receipt;
    }
    await cliSleep(CLI_RPC_RECEIPT_POLL_INTERVAL_MS);
  }
  throw new Error(`Transaction ${txHash} was broadcast but no receipt was found within ${CLI_RPC_RECEIPT_TIMEOUT_MS}ms`);
}

export {
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
  CLI_RPC_RECEIPT_TIMEOUT_MS,
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  getCliReceiptWithFailover,
  assertCliSuccessfulReceipt,
  sendCliRawTransactionWithFailover,
};

