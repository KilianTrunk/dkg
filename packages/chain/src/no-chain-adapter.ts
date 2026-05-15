import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  OnChainPublishResult,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  V10PublishParams,
  V10ConvictionAccountInfo,
} from './chain-adapter.js';

function noChain(): never {
  throw new Error(
    'No blockchain configured. To use on-chain operations, provide chainConfig ' +
    '(rpcUrl, hubAddress, privateKey) when creating the agent, or set DKG_PRIVATE_KEY.',
  );
}

/**
 * Stub chain adapter that throws on every operation.
 * Used when no blockchain is configured — the node can still do P2P and queries.
 * This is NOT a mock; it doesn't simulate any behavior.
 */
export class NoChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId = 'none';
  readonly deploymentId = 'none';

  async registerIdentity(_proof: IdentityProof): Promise<bigint> { noChain(); }
  async getIdentityId(): Promise<bigint> { return 0n; }
  async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> { noChain(); }
  async reserveUALRange(_count: number): Promise<ReservedRange> { noChain(); }
  async batchMintKnowledgeAssets(_params: BatchMintParams): Promise<BatchMintResult> { noChain(); }
  async *listenForEvents(_filter: EventFilter): AsyncIterable<ChainEvent> { noChain(); }
  async createContextGraph(_params: CreateContextGraphParams): Promise<TxResult> { noChain(); }
  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> { noChain(); }
  async revealContextGraphMetadata(_contextGraphId: string, _name: string, _description: string): Promise<TxResult> { noChain(); }
  async createKnowledgeAssetsV10(_params: V10PublishParams): Promise<OnChainPublishResult> { noChain(); }
  async isOperationalWalletRegistered(_identityId: bigint, _address: string): Promise<boolean> { return false; }
  async getKnowledgeAssetsV10Address(): Promise<string> { noChain(); }
  async getEvmChainId(): Promise<bigint> { noChain(); }
  async getPublishingConvictionAccountOwner(_accountId: bigint): Promise<string> { noChain(); }
  // V10 Publishing Conviction NFT write+read surface (issue #519). No
  // chain → every call throws via the shared noChain() helper.
  async createConvictionAccount(_committedTRAC: bigint): Promise<{ accountId: bigint } & TxResult> { noChain(); }
  async topUpConvictionAccount(_accountId: bigint, _amount: bigint): Promise<TxResult> { noChain(); }
  async registerConvictionAgent(_accountId: bigint, _agent: string): Promise<TxResult> { noChain(); }
  async deregisterConvictionAgent(_accountId: bigint, _agent: string): Promise<TxResult> { noChain(); }
  async isConvictionAgent(_accountId: bigint, _agent: string): Promise<boolean> { noChain(); }
  async settleConvictionAccount(_accountId: bigint): Promise<TxResult> { noChain(); }
  async getConvictionAccountInfo(_accountId: bigint): Promise<V10ConvictionAccountInfo | null> { noChain(); }
  isV10Ready(): boolean { return false; }
  isRandomSamplingReady(): boolean { return false; }
}
