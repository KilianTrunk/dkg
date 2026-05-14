// @ts-nocheck
//
// V8/V9 EVMChainAdapter method snapshots (issue 0004,
// `archive-non-v10-contracts`). NOT imported anywhere; preserved on disk
// so the V8/V9 surface that PR #500 removed stays diff-able without
// spelunking git history.
//
// See `src/archive/README.md` for policy.
//
/* eslint-disable */

// ────────────────────────────────────────────────────────────────────────
// V9 single-tx publish (KnowledgeAssets.publishKnowledgeAssets)
// ────────────────────────────────────────────────────────────────────────
async function publishKnowledgeAssets(this: any, params: any): Promise<any> {
  await this.init();
  this.requireV9();

  const txSigner = this.nextSigner();
  const ka = this.contracts.knowledgeAssets!.connect(txSigner);
  const kaAddress = await this.contracts.knowledgeAssets!.getAddress();

  if (this.contracts.token && params.tokenAmount > 0n) {
    const token = this.contracts.token.connect(txSigner);
    const currentAllowance: bigint = await token.allowance(txSigner.address, kaAddress);
    if (currentAllowance < params.tokenAmount) {
      const approveTx = await token.approve(kaAddress, /* ethers.MaxUint256 */ 0);
      await approveTx.wait();
    }
  }

  const identityIds = params.receiverSignatures.map((s: any) => s.identityId);
  const rValues = params.receiverSignatures.map((s: any) => s.r);
  const vsValues = params.receiverSignatures.map((s: any) => s.vs);

  const tx = await ka.publishKnowledgeAssets(
    params.kaCount,
    params.publisherNodeIdentityId,
    params.merkleRoot,
    params.publicByteSize,
    params.epochs,
    params.tokenAmount,
    /* ethers.ZeroAddress, paymaster */ 0,
    params.publisherSignature.r,
    params.publisherSignature.vs,
    identityIds,
    rValues,
    vsValues,
  );

  const receipt = await tx.wait();
  // …event parsing for UALRangeReserved / KnowledgeBatchCreated…
  return { batchId: 0n, startKAId: 0n, endKAId: 0n, txHash: receipt.hash };
}

// ────────────────────────────────────────────────────────────────────────
// V9 update (KnowledgeAssets.updateKnowledgeAssets)
// ────────────────────────────────────────────────────────────────────────
async function updateKnowledgeAssets(this: any, params: any): Promise<any> {
  await this.init();
  this.requireV9();
  // signer = original V9 publisher (resolved via KnowledgeAssetsStorage.getBatchPublisher)
  const signer = this.nextSigner();
  const ka = this.contracts.knowledgeAssets!.connect(signer);
  const tx = await ka.updateKnowledgeAssets(
    params.batchId,
    params.newMerkleRoot,
    params.newPublicByteSize,
  );
  const receipt = await tx.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    success: receipt.status === 1,
    publisherAddress: signer.address,
  };
}

// ────────────────────────────────────────────────────────────────────────
// V9 storage extension (KnowledgeAssets.extendStorage)
// ────────────────────────────────────────────────────────────────────────
async function extendStorage(this: any, params: any): Promise<any> {
  await this.init();
  this.requireV9();
  const ka = this.contracts.knowledgeAssets!;
  const tx = await ka.extendStorage(
    params.batchId,
    params.additionalEpochs,
    params.tokenAmount,
    /* ethers.ZeroAddress */ 0,
  );
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

// ────────────────────────────────────────────────────────────────────────
// V9 namespace transfer (KnowledgeAssets.transferNamespace)
// ────────────────────────────────────────────────────────────────────────
async function transferNamespace(this: any, newOwner: string): Promise<any> {
  await this.init();
  this.requireV9();
  const tx = await this.contracts.knowledgeAssets!.transferNamespace(newOwner);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

// ────────────────────────────────────────────────────────────────────────
// V9 permanent publish (KnowledgeAssets.batchMintKnowledgeAssetsPermanent)
// ────────────────────────────────────────────────────────────────────────
async function publishKnowledgeAssetsPermanent(this: any, params: any): Promise<any> {
  await this.init();
  if (!this.contracts.knowledgeAssets) throw new Error('KnowledgeAssets contract not deployed.');
  const publishSigner = this.nextSigner();
  const ka = this.contracts.knowledgeAssets.connect(publishSigner);
  const tx = await ka.batchMintKnowledgeAssetsPermanent(
    params.kaCount,
    params.publisherNodeIdentityId,
    params.merkleRoot,
    params.publicByteSize,
    params.tokenAmount,
    params.publisherSignature.r,
    params.publisherSignature.vs,
    params.receiverSignatures.map((s: any) => s.identityId),
    params.receiverSignatures.map((s: any) => s.r),
    params.receiverSignatures.map((s: any) => s.vs),
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

// ────────────────────────────────────────────────────────────────────────
// V8 staking helpers + entry points
// ────────────────────────────────────────────────────────────────────────
const V10_BASELINE_LOCK_TIERS = [0, 1, 3, 6, 12] as const;

function snapToBaselineLockTier(lockEpochs: number): number {
  let snapped = 0;
  for (const tier of V10_BASELINE_LOCK_TIERS) {
    if (tier <= lockEpochs) snapped = tier;
    else break;
  }
  return snapped;
}

function normalizeLegacyLockEpochs(lockEpochs: number): number {
  if (!Number.isInteger(lockEpochs)) throw new Error(`stakeWithLock: lockEpochs must be an integer, got ${lockEpochs}`);
  if (lockEpochs < 0) throw new Error(`stakeWithLock: lockEpochs must be non-negative, got ${lockEpochs}`);
  return snapToBaselineLockTier(lockEpochs);
}

async function stakeWithLock(this: any, identityId: bigint, amount: bigint, lockEpochs: number): Promise<any> {
  return this.stakeWithLockTier(identityId, amount, normalizeLegacyLockEpochs(lockEpochs));
}

async function stakeWithLockTier(this: any, identityId: bigint, amount: bigint, lockTier: number): Promise<any> {
  if (!Number.isInteger(lockTier) || !(V10_BASELINE_LOCK_TIERS as readonly number[]).includes(lockTier)) {
    throw new Error(`stakeWithLockTier: lockTier must be one of {${V10_BASELINE_LOCK_TIERS.join(', ')}}`);
  }
  await this.init();
  const nft = await this.resolveContract('DKGStakingConvictionNFT');
  // approve StakingV10 for `amount` TRAC …
  const tx = await nft.createConviction(identityId, amount, lockTier);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

async function getDelegatorConvictionMultiplier(
  _identityId: bigint,
  _delegator: string,
): Promise<{ multiplier: number }> {
  // V8 address-keyed stakers had no conviction multiplier (always 1x).
  return { multiplier: 1 };
}

// ────────────────────────────────────────────────────────────────────────
// V9 PCA family (PublishingConvictionAccount)
// ────────────────────────────────────────────────────────────────────────
async function createConvictionAccount(this: any, amount: bigint, lockEpochs: number): Promise<any> {
  await this.init();
  if (!this.contracts.publishingConvictionAccount) throw new Error('PCA contract not deployed.');
  const tx = await this.contracts.publishingConvictionAccount.createAccount(amount, lockEpochs);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1, accountId: 0n };
}

async function addConvictionFunds(this: any, accountId: bigint, amount: bigint): Promise<any> {
  await this.init();
  const tx = await this.contracts.publishingConvictionAccount.addFunds(accountId, amount);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

async function extendConvictionLock(this: any, accountId: bigint, additionalEpochs: number): Promise<any> {
  await this.init();
  const tx = await this.contracts.publishingConvictionAccount.extendLock(accountId, additionalEpochs);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

async function addPCAAuthorizedKey(this: any, accountId: bigint, key: string): Promise<any> {
  await this.init();
  const tx = await this.contracts.publishingConvictionAccount.addAuthorizedKey(accountId, key);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: receipt.status === 1 };
}

async function isPCAAuthorizedKey(this: any, accountId: bigint, key: string): Promise<boolean> {
  await this.init();
  return await this.contracts.publishingConvictionAccount.authorizedKeys(accountId, key);
}

async function getConvictionAccountInfo(this: any, accountId: bigint): Promise<any | null> {
  await this.init();
  const [admin, balance, initialDeposit, lockEpochs, conviction, discountBps] =
    await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);
  return { accountId, admin, balance, initialDeposit, lockEpochs, conviction, discountBps };
}

async function getConvictionDiscount(this: any, accountId: bigint): Promise<any> {
  await this.init();
  const [, , , , conviction, discountBps] =
    await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);
  return { discountBps, conviction };
}

// All exports below exist only to satisfy "module has exports" linters; the
// file itself is excluded from the active TS compile via tsconfig.
export const __V8_V9_ARCHIVE_MARKER__ = true;
export {
  publishKnowledgeAssets,
  updateKnowledgeAssets,
  extendStorage,
  transferNamespace,
  publishKnowledgeAssetsPermanent,
  stakeWithLock,
  stakeWithLockTier,
  getDelegatorConvictionMultiplier,
  createConvictionAccount,
  addConvictionFunds,
  extendConvictionLock,
  addPCAAuthorizedKey,
  isPCAAuthorizedKey,
  getConvictionAccountInfo,
  getConvictionDiscount,
};
