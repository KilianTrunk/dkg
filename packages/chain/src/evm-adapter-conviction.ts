// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing-conviction account / agent methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers, Contract } from 'ethers';
import type { TxResult, V10PublishingConvictionAccountInfo } from './chain-adapter.js';
import { PcaUnavailableError } from './pca-errors.js';
import { enrichEvmError, getPcaLogicInterface } from './evm-adapter-errors.js';

export class ConvictionMethods extends EVMChainAdapterBase {
  // =====================================================================
  // Staking + Publishing Conviction Account legacy surface — ARCHIVED
  /**
   * Reverse-resolve a wallet to its V10 PCA account id, or `0n` if the
   * wallet is not registered as a publishing agent. Mirrors the
   * `DKGPublishingConvictionNFT.agentToAccountId(agent)` view.
   *
   * The publisher SDK uses this to decide, BEFORE building a publish
   * tx, whether `KnowledgeAssetsLifecycle.publish()` will route through the
   * PCA discount branch — and therefore whether `publishEpochs` must
   * be coerced to the PCA's `lockDurationEpochs`. Wrong epochs do NOT
   * revert the contract any more; they just demote the publish to
   * direct spend at full price.
   *
   * Returns `0n` (not registered) when the NFT contract is not
   * deployed on this chain, the address is malformed, or the chain
   * call fails — callers treat the unknown case as "no PCA path".
   */
  async getConvictionAgentAccountId(agent: string): Promise<bigint> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0n;
    if (!ethers.isAddress(agent)) return 0n;
    try {
      const id: bigint = await this.contracts.dkgPublishingConvictionNFT.agentToAccountId(agent);
      return BigInt(id);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0n;
      throw err;
    }
  }

  async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return 0;
    if (accountId <= 0n) return 0;
    try {
      // `accounts(uint256)` returns
      // (committedTRAC, createdAtEpoch, expiresAtEpoch, createdAtTimestamp,
      //  expiresAtTimestamp, lockDurationEpochs, discountBps,
      //  lastSettledWindow, fullySwept). Pull index 5.
      const tuple = await this.contracts.dkgPublishingConvictionNFT.accounts(accountId);
      const lock = tuple[5];
      return Number(lock);
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return 0;
      throw err;
    }
  }

  async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    await this.init();
    const nft = await this.resolveContract('DKGPublishingConvictionNFT');
    const owner = await nft.ownerOf(accountId);
    return ethers.getAddress(owner);
  }

  requireConvictionNFT(): Contract {
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) {
      throw new PcaUnavailableError();
    }
    return nft;
  }

  /**
   * Common wrapper for every PCA (Publisher Conviction Account) write
   * path. Two responsibilities:
   *
   *   1. Opaque "unknown custom error"+data reverts from the post-split
   *      `PublishingConviction` logic contract carry no decoded name
   *      out of ethers — `enrichEvmError` decodes them so the daemon's
   *      error classifier can match downstream (mirrors what
   *      `isContractMissingRevert` does for the resolution path).
   *
   *   2. Self-heal on a stale `DKGPublishingConvictionNFT` /
   *      `PublishingConvictionStorage` binding. Both contracts were
   *      redeployed for v10.0.0-rc.11 (PCA split); the wrapper NFT
   *      lazy-resolves `PublishingConviction` on every call so a
   *      logic rotation is handled on-chain, but a wrapper rotation
   *      surfaces here as `UnauthorizedAccess(Only Contracts in Hub)`
   *      on the FIRST PCA write after the Hub re-registration. The
   *      `withHubStaleRetryAny` outer layer drops every boot-bound
   *      handle, re-runs `init()` to repopulate from the live Hub,
   *      and retries the closure once — `op` re-reads
   *      `this.contracts.dkgPublishingConvictionNFT` via
   *      `requireConvictionNFT()` so the retry uses the new address.
   *
   * NOTE — rc.12 follow-up: other V10 write paths
   * (`createKnowledgeAssets`, `createContextGraph`,
   * `updateKnowledgeCollectionV10`, etc.) should be wrapped with the
   * same self-heal pattern. Tracked in the broader migration to
   * `HubResolutionCache` for every boot-bound contract.
   */
  async pcaWrite<T>(op: () => Promise<T>): Promise<T> {
    return this.withHubStaleRetryAny(async () => {
      try {
        return await op();
      } catch (err) {
        if (err instanceof Error) enrichEvmError(err);
        throw err;
      }
    });
  }

  async createPublishingConvictionAccount(
    committedTRAC: bigint,
  ): Promise<{ accountId: bigint } & TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();

      // createAccount() does transferFrom(msg.sender → stakingStorage,
      // committedTRAC) — the signer must allow the NFT to pull the TRAC.
      if (this.contracts.token) {
        const allowance: bigint = await this.contracts.token.allowance(this.signer.address, nftAddress);
        if (allowance < committedTRAC) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA TRAC',
          );
        }
      }

      const receipt = await this.sendContractTransaction(
        nft,
        'createAccount',
        [committedTRAC],
        this.signer,
        'create publishing conviction account',
      );

      // Post PR #650 split, `AccountCreated` is emitted by
      // `PublishingConviction` (logic), NOT by the wrapper. Parse via
      // the logic ABI so this keeps working once `chain/abi/DKGPublishingConvictionNFT.json`
      // is refreshed to its post-split slim surface (which no longer
      // declares any PCA events).
      const pcaLogic = getPcaLogicInterface();
      let accountId = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = pcaLogic.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'AccountCreated') {
            accountId = BigInt(parsed.args.accountId);
            break;
          }
        } catch { /* not a PublishingConviction event */ }
      }
      if (accountId === 0n) {
        throw new Error('createPublishingConvictionAccount succeeded but no AccountCreated event found');
      }

      return {
        accountId,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
        success: receipt.status === 1,
      };
    });
  }

  async getPublishingConvictionAccountInfo(accountId: bigint): Promise<V10PublishingConvictionAccountInfo | null> {
    await this.init();
    // Undeployed NFT → capability error (503). null is reserved below
    // for a genuine account-missing revert so the route can disambiguate.
    if (!this.contracts.dkgPublishingConvictionNFT) throw new PcaUnavailableError();
    try {
      const t = await this.contracts.dkgPublishingConvictionNFT.getAccountInfo(accountId);
      return {
        owner: ethers.getAddress(t[0]),
        committedTRAC: BigInt(t[1]),
        baseEpochAllowance: BigInt(t[2]),
        createdAtEpoch: Number(t[3]),
        expiresAtEpoch: Number(t[4]),
        createdAtTimestamp: Number(t[5]),
        expiresAtTimestamp: Number(t[6]),
        discountBps: Number(t[7]),
        topUpBuffer: BigInt(t[8]),
        agentCount: Number(t[9]),
        lastSettledWindow: Number(t[10]),
        fullySwept: Boolean(t[11]),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  async topUpPublishingConvictionAccount(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const nftAddress = await nft.getAddress();
      if (this.contracts.token) {
        const allowance: bigint = await this.contracts.token.allowance(this.signer.address, nftAddress);
        if (allowance < amount) {
          await this.sendContractTransaction(
            this.contracts.token,
            'approve',
            [nftAddress, ethers.MaxUint256],
            this.signer,
            'approve PCA top-up TRAC',
          );
        }
      }
      const receipt = await this.sendContractTransaction(
        nft,
        'topUp',
        [accountId, amount],
        this.signer,
        'top up publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async settlePublishingConvictionAccount(accountId: bigint): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'settle',
        [accountId],
        this.signer,
        'settle publishing conviction account',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async registerPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'registerAgent',
        [accountId, agent],
        this.signer,
        'register publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async deregisterPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    return this.pcaWrite(async () => {
      const nft = this.requireConvictionNFT();
      const receipt = await this.sendContractTransaction(
        nft,
        'deregisterAgent',
        [accountId, agent],
        this.signer,
        'deregister publishing conviction agent',
      );
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
    });
  }

  async isPublishingConvictionAgent(accountId: bigint, agent: string): Promise<boolean> {
    await this.init();
    if (!this.contracts.dkgPublishingConvictionNFT) return false;
    if (!ethers.isAddress(agent)) return false;
    try {
      return Boolean(await this.contracts.dkgPublishingConvictionNFT.isAgent(accountId, agent));
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return false;
      throw err;
    }
  }
}
