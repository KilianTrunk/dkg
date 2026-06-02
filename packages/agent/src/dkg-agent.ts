import { createHash, randomUUID } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri, contextGraphVerifiedMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  deriveCuratorDidFromCgId,
  MemoryLayer,
  computeACKDigest,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeGossipEnvelope,
  computeGossipSigningPayload,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  decodeGossipEnvelope, type GossipEnvelopeMsg,
  decodeEncryptedWorkspacePayload, ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  decodeSwmSenderKeyMessage, SWM_SENDER_KEY_MESSAGE_TYPE,
  getGenesisQuads, computeNetworkId, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY,
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral, isSafeIri, assertSafeIri,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  buildTrustLevelQuads,
  isTrustLevelQuad,
  buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, type AuthorAttestationTypedData,
  buildAssertionSealQuads, buildAssertionPublishReceiptQuads,
  parseAssertionSealQuads, type AssertionSeal,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_ACK_RETRYABLE_REASON_CODES,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  computeSwmSenderKeyMembershipHash,
  computeSwmSenderKeyPackageAAD,
  decodeWorkspacePublishRequest,
  decodeSwmSenderKeyPackage,
  decodeSwmSenderKeyPackageAck,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encodeSwmSenderKeyMessage,
  encodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  encodeSwmShareAck,
  decodeSwmShareAck,
  encryptSwmSenderKeyMessage,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  ratchetSwmSenderChainKey,
  uint64ForProto,
  SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT,
  type DKGNodeConfig, type OperationContext, type GetView, type AssertionDescriptor, type AssertionEvent, type AssertionState,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageAckReasonCode,
  type SwmSenderKeyPackageMsg,
  type WorkspaceRecipientEncryptionKey,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  type MessageIdempotencyStore,
  type ProtocolOutboxStore,
  type ProtocolOutboxEntry,
  encryptV10PublishPayload,
  encryptChunked,
  buildCiphertextChunksRoot,
  computeGossipSigningPayloadV2,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
  type SubscriptionSource,
  SUBSCRIPTION_SOURCES,
  pickNetworkTunables,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, autoPartition, isReservedSubject, computePrivateRootV10 as computePrivateRoot,
  canonicalPublishPayload,
  resolveLiftWorkspaceSlice,
  validateLiftPublishPayload,
  subtractFinalizedExactQuads,
  TripleStoreAsyncLiftPublisher,
  TripleStoreAsyncPromoteQueue,
  FileWorkspacePublicSnapshotStore,
  parseWorkspacePublicSnapshotNQuads,
  type AsyncPromoteQueue, type AsyncPromoteQueueConfig,
  type PromoteJob, type PromoteListFilter,
  wrapAsRpcPreconditionIfApplicable,
  type PublishOptions, type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  type CollectedACK, type LiftAuthorityProof, type LiftTransitionType,
  type LiftRequest, type LiftRequestAuthorSeal,
  type WorkspaceAgentRecipient,
  type WorkspaceAgentRecipientResolution,
  type WorkspaceAgentRecipientResolverInput,
  type WorkspaceSenderKeyEncryptInput,
  type SharedMemoryPublicSnapshotStorageConfig, type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { join } from 'node:path';
import {
  DKGQueryEngine, QueryHandler,
  emptyQueryResultForKind,
  validateReadOnlySparql,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';

import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler, type ChatAclCheck } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, canonicalAgentDidSubject, collectPublishableMultiaddrs, type AgentProfileConfig } from './profile.js';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  type SignedAgentDelegation,
} from './auth/agent-delegation.js';
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { bindRandomSampling, type RandomSamplingHandle, type RandomSamplingStatus } from './random-sampling-bind.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { Messenger, type SloProtocolStats } from './p2p/messenger.js';
import {
  createCGMemberEnumerator,
  type CGMemberEnumerator,
} from './swm/enumerate-cg-members.js';
import {
  chooseFanOutTier,
  executeSubstrateFanOut,
  classifySendResult,
  FANOUT_RESPONSE_REJECTED,
  FANOUT_RESPONSE_RETRYABLE,
  type FanOutBookkeeper,
  type FanOutPeerRecord,
  type FanOutPlan,
} from './swm/substrate-fanout.js';
import {
  createSwmAckQuorum,
  type SwmAckQuorum,
} from './swm/ack-quorum.js';
import { SwmHostModeStore, type SwmHostModeStoreLimits } from './swm/host-mode-store.js';
import {
  BEACON_ACCESS_POLICY_CURATED,
  BEACON_REANNOUNCE_INTERVAL_MS,
  DKG_CG_DISCOVERY_TOPIC,
  decodeCgDiscoveryBeacon,
  encodeCgDiscoveryBeacon,
  mintCgDiscoveryBeacon,
  verifyCgDiscoveryBeacon,
} from './swm/cg-discovery-beacon.js';
import { DiscoveryRateLimit } from './swm/discovery-rate-limit.js';
import {
  decodeSwmHostCatchupRequest,
  encodeSwmHostCatchupRequest,
  encodeSwmHostCatchupResponse,
  decodeSwmHostCatchupResponse,
  DEFAULT_MAX_BYTES as SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES as SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES,
  SWM_HOST_CATCHUP_WIRE_VERSION,
  type SwmHostCatchupResponseEntry,
} from './swm/host-catchup-wire.js';
import {
  CatchupReplayGuard,
  mintSignedCatchupRequest,
  verifySignedCatchupRequest,
} from './swm/host-catchup-sign.js';
import {
  createCiphertextChunkCatchupReplayGuard,
  decodeCiphertextChunkCatchupRequest,
  encodeCiphertextChunkCatchupRequest,
  encodeCiphertextChunkCatchupResponse,
  decodeCiphertextChunkCatchupResponse,
  mintSignedCiphertextChunkCatchupRequest,
  verifySignedCiphertextChunkCatchupRequest,
  CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
  type CiphertextChunkCatchupRequest,
  type CiphertextChunkCatchupResponse,
} from './swm/ciphertext-chunk-catchup.js';
import { waitForPeerProtocol } from './p2p/protocol-readiness.js';
import { orderCatchupPeers } from './p2p/peer-selection.js';
import { reconcileWarmCoreConnections, type WarmCoreAgent } from './p2p/warm-core-connections.js';
import { fetchSyncPages, type SyncPageResult } from './sync/requester/page-fetch.js';
import { getSyncCheckpointKey } from './sync/checkpoint/state.js';
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { registerSyncHandler } from './sync/responder/sync-handler.js';
import { runSyncOnConnect } from './sync/on-connect/sync-on-connect.js';
import {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  ensureWorkspaceEncryptionKey,
  hashAgentToken,
  activeWorkspaceEncryptionKeys,
  appendCustodialWorkspaceEncryptionKey,
  revokeCustodialWorkspaceEncryptionKey,
  attachRevocationToWorkspaceEncryptionKey,
  migrateLegacyWorkspaceEncryptionFields,
  refreshDefaultEncryptionKeyView,
  type AgentKeyRecord,
  type KeystoreEntry,
  type WorkspaceEncryptionKeyEntry,
} from './agent-keystore.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler, KEEP_ROOT_COPY_PREDICATE } from './finalization-handler.js';
import { reconcileContextGraph, ReconcileCoalescer, RecentUalSet, type ChainReconcilerDeps, type OrdinalOutcome } from './chain-reconciler.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
// type alias so listPendingJoinApprovalRetries() retains its old
// public shape while it stubs out to []. PR-12 rebuilds the operator
// diagnostic surface on top of the substrate outbox and will return
// real entries with substrate-shaped metadata.
type JoinApprovalRetryEntry = {
  contextGraphId: string;
  agentAddress: string;
  attempts: number;
  firstFailureAt: number;
  nextAttemptAt: number;
  lastError: string;
};
import { multiaddr } from '@multiformats/multiaddr';
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import {
  strip, stripLiteral, jsonLdToQuads,
  type JsonLdContent,
} from './dkg-agent-utils.js';
import {
  PRIVATE_DATA_ANCHOR,
  SYNC_PAGE_SIZE,
  SYNC_PAGE_RETRY_ATTEMPTS,
  SYNC_TOTAL_TIMEOUT_MS,
  SYNC_PAGE_TIMEOUT_MS,
  SYNC_ROUTER_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_DELAY_MS,
  SYNC_AUTH_MAX_AGE_MS,
  JOIN_DELEGATION_VALIDITY_MS,
  JOIN_REQUEST_SEND_TIMEOUT_MS,
  SYNC_ACCESS_DENIED_MARKER,
  LOCAL_ACCESS_OPEN,
  LOCAL_ACCESS_CURATED,
  EVM_PUBLISH_CURATED,
  EVM_PUBLISH_OPEN,
  MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS,
  META_REFRESH_COOLDOWN_MS,
  SYNC_MIN_GRAPH_BUDGET_MS,
  DEBUG_SYNC_PROGRESS,
  DEFAULT_SWM_TTL_MS,
  SWM_CLEANUP_INTERVAL_MS,
  SYNC_DENIED_RESPONSE,
  GOSSIP_DIAL_COOLDOWN_MS,
  GOSSIP_DIAL_TIMEOUT_MS,
  CATCHUP_ON_CONNECT_COOLDOWN_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
  RANDOM_SAMPLING_BIND_RETRY_MS,
  STORAGE_ACK_REGISTRATION_RETRY_MS,
  JOIN_APPROVAL_RETRY_TICK_MS,
  MESSAGE_OUTBOX_TICK_MS,
  AGENT_PROFILE_HEARTBEAT_MS,
  AGENT_PROFILE_STALE_THRESHOLD_MS,
  WARM_CORE_CONNECTIONS_ENABLED,
  WARM_CORE_RECONCILE_INTERVAL_MS,
  WARM_CORE_MAX,
  WARM_CORE_KEEPALIVE_TAG,
  WARM_CORE_DIAL_TIMEOUT_MS,
  CIPHERTEXT_CHUNK_SIZE_BYTES,
  BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
  MIN_STORAGE_ACK_REGISTRATION_RETRY_MS,
  TIMEOUT_SENTINEL,
  ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS,
  CHAIN_POLICY_READ_TIMEOUT_MS,
  SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
} from './dkg-agent-constants.js';
import { raceWithBootTimeout, isTransientBootChainError } from './dkg-agent-boot.js';
import * as diagnostics from './dkg-agent-diagnostics.js';
import {
  ContextGraphNotFoundError,
  InvalidContentError,
  StaleSenderKeyTargetError,
  SwmSenderKeySetupRejectionError,
  SyncAccessDeniedError,
  type PreSignedAuthorAttestation,
  type LocalSwmSenderKeySendState,
  type LocalSwmSenderKeyReceiveState,
  type PendingSenderKeyEntry,
  type RandomSamplingStartResult,
  type ACKSignerResolution,
  type SyncRequestEnvelope,
  type CclPublishedResultEntry,
  type CclPublishedEvaluationRecord,
  type PublishOpts,
  type PublishAsyncOpts,
  type PublishAsyncQuadEnvelope,
  type PublishAsyncContent,
  type PeerHealth,
  type PeerConnectionSnapshot,
  type PeerDiagnostics,
  type ChatSendResult,
  type ContextGraphSub,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type DKGAgentConfig,
  type ReplicationEvent,
} from './dkg-agent-types.js';
import {
  normalizePublishContextGraphId,
  isPublishAsyncQuadEnvelope,
  assertQuadArray,
  partitionPublishAsyncQuads,
  signWithPrivateKey,
  preSignedAttestationToLiftSeal,
  normalizeAgentDid,
  joinDelegationScope,
  normalizeSyncPhase,
  normalizeAdapterPublisherAddress,
  recoverCompactSigner,
  adapterOperationalPrivateKeyAddress,
  adapterHasOperationalPrivateKey,
  adapterGenericSignMessageMatchesAddress,
  adapterAdvertisesPublisherSigner,
  privateKeyAddress,
  inferAdapterPublisherAddress,
  defaultLargeLiteralStorage,
  createPublicSnapshotStore,
  applyDefaultLargeLiteralStorage,
  isLocalOxigraphConfig,
  sliceIntoCiphertextChunks,
} from './dkg-agent-helpers.js';
import {
  swmSenderStateKey,
  swmReceiverStateKey,
  serializeSwmSenderSendState,
  serializeSwmSenderReceiveState,
  serializePendingSenderKeyEntry,
  deserializeSwmSenderSendState,
  deserializeSwmSenderReceiveState,
  deserializePendingSenderKeyEntry,
} from './dkg-agent-swm-state.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { applyMixins } from './dkg-agent-apply-mixins.js';
import { CclPolicyMethods } from './dkg-agent-ccl.js';
import { EndorseVerifyMethods } from './dkg-agent-endorse.js';
import { ContextGraphRegistryMethods } from './dkg-agent-cg-registry.js';
import { JoinRequestMethods } from './dkg-agent-join.js';
import { SwmSubstrateMethods } from './dkg-agent-swm-substrate.js';
import { QueryMethods } from './dkg-agent-query.js';
import { AgentRegistryMethods } from './dkg-agent-registry.js';
import { WorkspaceCryptoMethods } from './dkg-agent-crypto.js';
import { LifecycleSyncMethods } from './dkg-agent-lifecycle.js';
import { PublishMethods } from './dkg-agent-publish.js';
import { SwmHostModeMethods } from './dkg-agent-swm-host.js';
import { ContextGraphMethods } from './dkg-agent-context-graph.js';
// Public surface re-exported so external consumers that import directly
// from `./dkg-agent.js` keep working. The new file `dkg-agent-types.ts`
// is the canonical home; `packages/agent/src/index.ts` re-exports from
// there.
export {
  ContextGraphNotFoundError,
  InvalidContentError,
};
export type {
  CclPublishedResultEntry,
  CclPublishedEvaluationRecord,
  PublishOpts,
  PublishAsyncOpts,
  PublishAsyncQuadEnvelope,
  PublishAsyncContent,
  PeerHealth,
  PeerConnectionSnapshot,
  PeerDiagnostics,
  ChatSendResult,
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  ContextGraphMemberPrincipalType,
  ContextGraphMemberStatus,
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
  DurableSyncDiagnostics,
  SharedMemorySyncDiagnostics,
  CatchupSyncDiagnostics,
  DKGAgentConfig,
};

/**
 * High-level facade that ties together all DKG agent capabilities:
 * identity, networking, publishing, querying, discovery, and messaging.
 *
 * Usage:
 *   const agent = await DKGAgent.create({ name: 'MyBot', skills: [...] });
 *   await agent.start();
 *   const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
 *   const response = await agent.invokeSkill(offerings[0], inputData);
 *   await agent.stop();
 */
export class DKGAgent extends DKGAgentBase {

  static async create(config: DKGAgentConfig): Promise<DKGAgent> {
    let wallet: DKGAgentWallet;
    if (config.dataDir) {
      try {
        wallet = await DKGAgentWallet.load(config.dataDir);
      } catch {
        wallet = await DKGAgentWallet.generate();
        await wallet.save(config.dataDir);
      }
    } else {
      wallet = await DKGAgentWallet.generate();
    }
    const log = new Logger('DKGAgent');
    const ctx = createOperationContext('system');
    let store: TripleStore;
    if (config.store) {
      store = config.store;
    } else if (config.storeConfig) {
      store = await createTripleStore(applyDefaultLargeLiteralStorage(config.storeConfig, config.dataDir, config.largeLiteralStorage));
      log.info(ctx, `Triple store backend: ${config.storeConfig.backend}`);
    } else if (config.dataDir) {
      const { join } = await import('node:path');
      const persistPath = join(config.dataDir, 'store.nq');
      store = await createTripleStore({
        backend: 'oxigraph-worker',
        options: { path: persistPath },
        largeLiteralStorage: defaultLargeLiteralStorage(config.dataDir, config.largeLiteralStorage),
      });
      log.info(ctx, `Persistent triple store (worker thread): ${persistPath}`);
    } else {
      store = await createTripleStore({ backend: 'oxigraph' });
      log.warn(ctx, `No dataDir — triple store is in-memory (data will be lost on restart)`);
    }

    const nodeRole = config.nodeRole ?? 'edge';
    let chain: ChainAdapter;
    let opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
      if (!opKeys?.length && typeof (chain as any).getOperationalPrivateKey === 'function') {
        opKeys = [(chain as any).getOperationalPrivateKey()];
      }
    } else if (config.chainConfig && opKeys?.length) {
      const evmConfigBase = {
        rpcUrl: config.chainConfig.rpcUrl,
        rpcUrls: config.chainConfig.rpcUrls,
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        tokenAddress: config.chainConfig.tokenAddress,
        chainId: config.chainConfig.chainId,
        approvalPolicy: config.chainConfig.approvalPolicy,
      };
      if (config.chainConfig.adminPrivateKey) {
        chain = new EVMChainAdapter({ ...evmConfigBase, adminPrivateKey: config.chainConfig.adminPrivateKey });
      } else {
        chain = new EVMChainAdapter({ ...evmConfigBase, allowNoAdminSigner: true });
      }
    } else {
      chain = new NoChainAdapter();
    }

    const eventBus = new TypedEventBus();
    const keypair = wallet.keypair;

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store);

    const port = config.listenPort ?? 0;
    const host = config.listenHost ?? '0.0.0.0';
    const nodeConfig: DKGNodeConfig = {
      listenAddresses: [`/ip4/${host}/tcp/${port}`],
      announceAddresses: config.announceAddresses,
      bootstrapPeers: config.bootstrapPeers,
      relayPeers: config.relayPeers,
      enableMdns: !config.bootstrapPeers?.length && !config.relayPeers?.length,
      privateKey: keypair.secretKey,
      nodeRole,
      relayServerCapacity: config.relayServerCapacity,
      relayReservationCount: config.relayReservationCount,
      nodeVersion: config.nodeVersion,
      ...pickNetworkTunables(config),
    };

    const node = new DKGNode(nodeConfig);
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();
    const publicSnapshotStore = createPublicSnapshotStore(config.dataDir, config.sharedMemoryPublicSnapshotStorage);
    const legacyAdapterOperationalKey = opKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(config.publisherAddress);
    const publisherAddressMatchesLegacyKey = Boolean(
      configuredPublisherAddress &&
      legacyAdapterOperationalAddress &&
      configuredPublisherAddress.toLowerCase() === legacyAdapterOperationalAddress.toLowerCase(),
    );
    const adapterCanPublishFromAdvertisedSigner = await adapterAdvertisesPublisherSigner(chain);
    const useLegacyAdapterOperationalKeyFallback = Boolean(
      config.chainAdapter &&
      legacyAdapterOperationalKey &&
      !adapterCanPublishFromAdvertisedSigner &&
      (!configuredPublisherAddress || publisherAddressMatchesLegacyKey),
    );
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: useLegacyAdapterOperationalKeyFallback ? legacyAdapterOperationalKey : undefined,
      publisherAddress: config.publisherAddress,
      publisherAddressResolver: config.publisherAddress || useLegacyAdapterOperationalKeyFallback
        ? undefined
        : (contextGraphId?: bigint) => inferAdapterPublisherAddress(chain, contextGraphId),
      sharedMemoryOwnedEntities: workspaceOwnedEntities,
      writeLocks,
      publicSnapshotStore,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} shared memory ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct shared memory ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    // GH #748: one-shot migration of SWM `prov:wasAttributedTo` from
    // peer-ID string literals to agent DID URIs. Idempotent via a
    // per-CG marker; non-fatal on failure (match the pattern above).
    try {
      const migrated = await publisher.migrateSwmAttributionToAgentDid();
      if (migrated.rewritten > 0 || migrated.skipped > 0) {
        const log = new Logger('DKGAgent');
        log.info(
          createOperationContext('init'),
          `Migrated SWM attribution across ${migrated.swmMetaGraphs} SWM meta graph(s): rewrote ${migrated.rewritten} literal(s) to agent DID, ${migrated.skipped} unresolved`,
        );
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to migrate SWM attribution to agent DID, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks, publicSnapshotStore,
    );
  }

  public getACKSignerCandidateWallets(ctx: OperationContext): ethers.Wallet[] {
    const operationalKeys = this.config.chainAdapter
      ? []
      : (this.config.chainConfig?.operationalKeys ?? []);
    const keys = [
      this.config.ackSignerKey,
      ...operationalKeys,
      typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined,
    ].filter((key): key is string => Boolean(key));

    const wallets: ethers.Wallet[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      try {
        const wallet = new ethers.Wallet(key);
        const addressKey = wallet.address.toLowerCase();
        if (seen.has(addressKey)) continue;
        seen.add(addressKey);
        wallets.push(wallet);
      } catch (err) {
        this.log.warn(ctx, `Ignoring invalid ACK signer key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return wallets;
  }

  public async resolveConfirmedACKSigner(
    identityId: bigint,
    candidates: ethers.Wallet[],
    ctx: OperationContext,
  ): Promise<ACKSignerResolution> {
    const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
    if (typeof isOperationalWalletRegistered !== 'function') {
      this.log.warn(
        ctx,
        'V10 StorageACK signer disabled: chain adapter does not implement required on-chain operational wallet confirmation',
      );
      return { wallet: null, retryable: false };
    }

    let sawLookupError = false;
    for (const wallet of candidates) {
      try {
        if (await isOperationalWalletRegistered.call(this.chain, identityId, wallet.address)) {
          return { wallet, retryable: false };
        }
      } catch (err) {
        sawLookupError = true;
        this.log.warn(
          ctx,
          `Unable to confirm ACK signer ${wallet.address} on-chain: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (sawLookupError) {
      this.log.warn(
        ctx,
        `V10 StorageACK handler registration deferred: signer confirmation failed due lookup error(s)`,
      );
      return { wallet: null, retryable: true };
    }

    this.log.warn(
      ctx,
      `V10 StorageACK signer disabled: no candidate key is confirmed on-chain as ` +
      `OPERATIONAL_KEY for identity ${identityId}`,
    );
    return { wallet: null, retryable: false };
  }

  // Overload: raw quads
  async publish(contextGraphId: string, quads: Quad[], privateQuads?: Quad[], opts?: PublishOpts): Promise<PublishResult>;
  // Overload: JSON-LD (bare doc = private, or { public?, private? } envelope)
  async publish(contextGraphId: string, content: JsonLdContent, opts?: PublishOpts): Promise<PublishResult>;
  async publish(
    contextGraphId: string,
    input: Quad[] | JsonLdContent,
    thirdArg?: Quad[] | PublishOpts,
    fourthArg?: PublishOpts,
  ): Promise<PublishResult> {
    // JSON-LD: convert to quads, then publish
    if (!Array.isArray(input)) {
      const { publicQuads, privateQuads } = await jsonLdToQuads(input);
      return this._publish(contextGraphId, publicQuads, privateQuads, thirdArg as PublishOpts);
    }
    // Quad[]: pass through directly
    if (Array.isArray(thirdArg)) {
      return this._publish(contextGraphId, input as Quad[], thirdArg, fourthArg);
    }
    return this._publish(contextGraphId, input as Quad[], undefined, thirdArg ?? fourthArg);
  }

  /**
   * Check whether a context graph exists in local storage. Definition triples in
   * ONTOLOGY/_meta count, and storage-backed graph presence also counts so local
   * shared-memory-only survivors are not treated as nonexistent.
   */
  async contextGraphExists(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> }
      } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) {
      return true;
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    return storedContextGraphs.includes(contextGraphId);
  }

  /**
   * Check whether the context graph has any actual content locally. A
   * contextGraph declaration triple in the ontology graph (from auto-discovery
   * via chain registry or ontology sync) does NOT count as content; it
   * only indicates the contextGraph was announced, not that we have access to
   * its data. This predicate is used to distinguish "genuinely synced /
   * has access" from "declaration only / probably denied".
   *
   * Looks for at least one triple in ANY graph under the context-graph
   * prefix (`did:dkg:context-graph:<cg>`, `…/<sg>`, `…/assertion/…`,
   * `…/_shared_memory`, …) except the `_meta` bookkeeping graphs. Tier-4l
   * Codex feedback: the previous check only inspected the root data
   * graph, so a project whose content was synced into sub-graphs
   * (`/tasks`, `/chat`, assertion graphs, SWM) looked like "no local
   * content" and the denial-cleanup path would unsubscribe it. Sub-graph
   * content is the normal state for any non-trivial project so the root
   * data graph is routinely empty.
   */
  async contextGraphHasLocalContent(contextGraphId: string): Promise<boolean> {
    const prefix = `did:dkg:context-graph:${contextGraphId}`;
    // ASK is cheap on Oxigraph; the FILTER keeps us inside this CG's
    // namespace and excludes `_meta` / `_shared_memory_meta` bookkeeping
    // which is written even for declaration-only discoveries.
    const sparql = `ASK WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STRSTARTS(STR(?g), "${prefix}"))
      FILTER(!STRENDS(STR(?g), "/_meta"))
      FILTER(!STRENDS(STR(?g), "/_shared_memory_meta"))
    }`;
    const result = await this.store.query(sparql);
    if (result.type === 'boolean') return result.value;
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * Check whether a context graph is declared as curated (private/allowlist)
   * locally. Reads the DKG accessPolicy predicate from either the ontology
   * graph (public CGs) or the CG's _meta graph (curated CGs). Returns false
   * when no declaration is present locally (caller should treat that as
   * "unknown, assume public" — this predicate is only used to gate
   * optimistic denial inference, not access control decisions).
   */
  async contextGraphIsCurated(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    try {
      const res = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      if (res.type !== 'bindings' || res.bindings.length === 0) return false;
      const ap = res.bindings[0]?.['ap']?.replace(/^"|"$/g, '');
      return ap === 'private';
    } catch {
      return false;
    }
  }

  public parseSyncRequest(data: Uint8Array): SyncRequestEnvelope {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      let parsed: SyncRequestEnvelope;
      try {
        parsed = JSON.parse(text) as SyncRequestEnvelope;
      } catch {
        // Malformed JSON — fall through to pipe-delimited parsing
        return this.parsePipeDelimitedSyncRequest(text);
      }
      return {
        contextGraphId: parsed.contextGraphId,
        offset: parsed.offset ?? 0,
        limit: Math.min(parsed.limit ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
        includeSharedMemory: parsed.includeSharedMemory ?? false,
        phase: normalizeSyncPhase(parsed.phase),
        snapshotRef: typeof parsed.snapshotRef === 'string' ? parsed.snapshotRef : undefined,
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
        // Phase C: unsigned delta hint. Validated/normalised in the responder.
        sinceBatchId: typeof parsed.sinceBatchId === 'string' ? parsed.sinceBatchId : undefined,
      };
    }

    return this.parsePipeDelimitedSyncRequest(text);
  }

  private parsePipeDelimitedSyncRequest(text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const phase = normalizeSyncPhase(parts[3]);
    // Phase C: the `|since|<n>` keyed token is ALWAYS the final two segments
    // emitted by `buildSyncRequestEnvelope` (after the optional phase/snapshot
    // suffix). Match only that trailing position — scanning every segment would
    // misparse an ordinary segment literally equal to "since" (e.g. a CG or
    // snapshotRef named "since") as a delta marker and turn a full sync into a
    // partial response. Old encoders never emit the suffix.
    let sinceBatchId: string | undefined;
    if (
      parts.length >= 2 &&
      parts[parts.length - 2] === 'since' &&
      /^\d+$/.test(parts[parts.length - 1])
    ) {
      sinceBatchId = parts[parts.length - 1];
    }
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase,
      snapshotRef: phase === 'snapshot' ? parts[4] : undefined,
      sinceBatchId,
    };
  }

  /**
   * Pick which local agent should sign sync requests for this CG.
   *
   * On a multi-agent node, hard-coding `defaultAgentAddress` for every
   * sync envelope is wrong: if agent B is allowlisted on the CG but
   * agent A happens to be the process default, the responder's
   * per-agent delegation lookup will only see A's claim and miss B's
   * stored delegation, silently failing sync auth for the actually
   * approved agent.
   *
   * Resolution order:
   *  1. If the process default is in the curator's allowlist (mirrored
   *     into our local `_meta` after first sync), keep using it. This
   *     preserves historical behavior for single-agent nodes.
   *  2. Otherwise pick the first local agent the curator allowlisted.
   *  3. If neither (no `_meta` yet, e.g. the very first catch-up after
   *     `join-approved` arrives), fall back to the locally-known
   *     join-request / join-approved hint in `localApprovedAgentByCG`.
   *     This is the codex round-4 fix — without it, the first
   *     post-approval sync on multi-agent nodes would bind to
   *     `defaultAgentAddress` and the responder would deny.
   *  4. If even the hint is unset (we're the curator handling our own
   *     CG, or restarted after approval), fall back to
   *     `defaultAgentAddress`.
   *
   * PR #448 review (rounds 4 and 5) — Codex flagged the multi-agent
   * silent-sync-failure bug, then the still-broken first-catch-up
   * case after the round-4 fix landed.
   */
  private async findLocalAgentForContextGraph(contextGraphId: string): Promise<string | undefined> {
    if (this.localAgents.size === 0) return this.defaultAgentAddress;

    // Hint first: if we have a definitive locally-known choice (just
    // signed, or just received a join-approved for this CG), prefer it
    // — but only if it still maps to a local agent we can sign with.
    const hintAddr = this.localApprovedAgentByCG.get(contextGraphId);
    const hintLocal = hintAddr
      ? [...this.localAgents.keys()].find((a) => a.toLowerCase() === hintAddr)
      : undefined;

    let allowedAgents: string[] = [];
    try {
      allowedAgents = await this.getContextGraphAllowedAgents(contextGraphId);
    } catch {
      return hintLocal ?? this.defaultAgentAddress;
    }
    if (allowedAgents.length === 0) {
      // No `_meta` yet — the hint is the most authoritative answer we
      // have for the post-approval bootstrap window.
      return hintLocal ?? this.defaultAgentAddress;
    }
    const allowedLower = new Set(allowedAgents.map((a) => a.toLowerCase()));
    // Hint wins if it's also on the allowlist — covers the "approved
    // agent ≠ process default, _meta has caught up" case.
    if (hintLocal && allowedLower.has(hintLocal.toLowerCase())) return hintLocal;
    const defaultLower = this.defaultAgentAddress?.toLowerCase();
    if (defaultLower && allowedLower.has(defaultLower)) return this.defaultAgentAddress;
    for (const localAddr of this.localAgents.keys()) {
      if (allowedLower.has(localAddr.toLowerCase())) return localAddr;
    }
    return hintLocal ?? this.defaultAgentAddress;
  }

  public async buildSyncRequest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    responderPeerId: string,
    phase: SyncPhase = 'data',
    snapshotRef?: string,
    sinceBatchId?: string,
  ): Promise<Uint8Array> {
    const isPrivate = await this.isPrivateContextGraph(contextGraphId);

    // If we don't have any local data for this CG yet (e.g. just subscribed
    // via invite), we can't determine the access policy. Send an
    // authenticated request so the remote peer can verify our identity
    // against its allowlist.
    const hasLocalData = this.subscribedContextGraphs.get(contextGraphId)?.synced === true;
    const needsAuth = isPrivate || !hasLocalData;
    const claimedAgentAddress = await this.findLocalAgentForContextGraph(contextGraphId);
    const claimedAgent = claimedAgentAddress ? this.localAgents.get(claimedAgentAddress) : undefined;
    return buildSyncRequestEnvelope({
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      targetPeerId: responderPeerId,
      requesterPeerId: this.peerId,
      phase,
      snapshotRef,
      // Phase C: only forwarded for the durable DATA phase — SWM has no
      // `dkg:batchId` (pre-chain) and meta must never be narrowed. The hint
      // is gap-safe only when it comes from a CONTIGUOUS watermark, so it is
      // supplied explicitly by callers, never auto-derived from local MAX().
      sinceBatchId: phase === 'data' && !includeSharedMemory ? sinceBatchId : undefined,
      needsAuth,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      getIdentityId: () => this.chain.getIdentityId(),
      signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
      claimedAgentAddress: claimedAgentAddress,
      claimedAgentPrivateKey: claimedAgent?.privateKey,
    });
  }

  private computeSyncDigest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string | undefined,
    requestId: string | undefined,
    issuedAtMs: number | undefined,
    requesterAgentAddress: string | undefined,
  ): Uint8Array {
    // `requesterAgentAddress` participates in the digest so the
    // "on behalf of" claim is signed, not free-form envelope data.
    // Without it, the responder's delegation lookup can be steered by
    // tampering with `requesterAgentAddress` after the signature was
    // produced — which would be a way to bypass the per-agent
    // delegation binding in `request-authorize`.
    return ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256', 'string'],
        [
          contextGraphId,
          BigInt(offset),
          BigInt(limit),
          includeSharedMemory,
          targetPeerId,
          requesterPeerId ?? '',
          requestId ?? '',
          BigInt(issuedAtMs ?? 0),
          (requesterAgentAddress ?? '').toLowerCase(),
        ],
      ),
    );
  }

  public async authorizeSyncRequest(request: SyncRequestEnvelope, remotePeerId: string): Promise<boolean> {
    const isPrivate = await this.isPrivateContextGraph(request.contextGraphId);
    if (!isPrivate) {
      return true;
    }
    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    return authorizePrivateSyncRequest({
      ctx: createOperationContext('sync'),
      request,
      remotePeerId,
      localPeerId: this.peerId,
      syncAuthMaxAgeMs: SYNC_AUTH_MAX_AGE_MS,
      seenRequestIds: this.seenPrivateSyncRequestIds,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      verifyIdentity: typeof verifyIdentity === 'function' ? verifyIdentity.bind(this.chain) : undefined,
      getParticipants: (contextGraphId) => this.getPrivateContextGraphParticipants(contextGraphId),
      getAllowedPeers: (contextGraphId) => this.getContextGraphAllowedPeers(contextGraphId),
      getAgentGateAddresses: (contextGraphId) => this.getContextGraphAgentGateAddresses(contextGraphId),
      getAllowedDelegateePeers: (contextGraphId) => this.getContextGraphAllowedDelegateePeers(contextGraphId),
      getAllowedDelegateeKeys: (contextGraphId) => this.getContextGraphAllowedDelegateeKeys(contextGraphId),
      refreshMetaFromCurator: (contextGraphId) => this.refreshMetaFromCurator(contextGraphId),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    });
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed participant-agent oracle
   * for {@link SharedMemoryHandler#chainAgentGateOracle}.
   *
   * Maps a CG identifier (cleartext or numeric form) to the on-chain
   * `ContextGraphStorage.getParticipantAgents` result, with in-memory
   * caching keyed by the numeric id (so cleartext and numeric callers
   * share cache entries). Used to authenticate gossip envelopes on
   * cores that host curated CGs they are not members of — the local
   * meta-graph has no allowlist triples for such CGs, so without the
   * chain fallback every envelope would be rejected at
   * `verifyHostModeEnvelopeAuthority` and the LU-6 substrate would
   * never collect ciphertext for them.
   *
   * Cleartext → numeric resolution probes (in order):
   *   1. `subscribedContextGraphs[cgId].onChainId` (set by the
   *      curator on create and by chain-event auto-discovery).
   *   2. `BigInt(cgId)` parse (covers the publishes that address the
   *      CG by its numeric on-chain id directly — see PublishIntent
   *      shape and the matching `isCgCurated` resolver above).
   *
   * Returns `null` when no resolution path yields a positive-id
   * numeric (the caller treats `null` as "no allowlist → reject
   * defensively"); empty `[]` from the chain is cached and returned
   * as-is so a brand-new id doesn't keep paying RPC per envelope.
   */
  async resolveOnChainParticipantAgents(contextGraphId: string): Promise<string[] | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    let numericId: bigint | null = null;
    // OT-RFC-38 / LU-6 Phase B — input may be cleartext (member-side
    // call), hash form (envelope from the wire), or already-numeric
    // (legacy publish path). Probe in cheapest-first order; we cache
    // by stringified numeric id below so an early hit reuses the
    // result regardless of which form the input took.
    //
    //   1. Direct hit on `subscribedContextGraphs` — covers cleartext
    //      (member local id) and hash form when the local node is a
    //      host-only core whose subscription key IS the hash.
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (sub?.onChainId) {
      try { numericId = BigInt(sub.onChainId); } catch { /* fall through */ }
    }
    //   2. Hash-form input where the local node is a MEMBER (the
    //      subscription is keyed by cleartext, not hash). Translate
    //      via the reverse index and re-probe.
    if (numericId === null && /^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      const localId = this.wireIdToLocalCgId.get(contextGraphId.toLowerCase());
      if (localId) {
        const memberSub = this.subscribedContextGraphs.get(localId);
        if (memberSub?.onChainId) {
          try { numericId = BigInt(memberSub.onChainId); } catch { /* fall through */ }
        }
      }
    }
    //   3. Cleartext-form input on a host-only core. Cores subscribed
    //      via the chain-event path keep their `subscribedContextGraphs`
    //      keyed by HASH (the curator-committed wire id), not cleartext.
    //      When a member's envelope arrives with cleartext in
    //      `contextGraphId` (the publish path keeps cleartext in the
    //      envelope for inner-consistency reasons — see
    //      `publishWorkspaceGossip`), the cleartext direct lookup at
    //      step 1 misses on the core. Hash the cleartext on-the-fly
    //      and re-probe before falling through to numeric parse.
    if (numericId === null && !/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      try {
        const computedHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
        const hostSub = this.subscribedContextGraphs.get(computedHash);
        if (hostSub?.onChainId) {
          try { numericId = BigInt(hostSub.onChainId); } catch { /* fall through */ }
        }
      } catch { /* malformed cleartext — fall through */ }
    }
    //   4. Numeric form input — accept it directly, but only AFTER the
    //      hash-form branch above. Otherwise a 32-byte hex hash would
    //      `BigInt(...)` cleanly and we'd treat its raw integer value
    //      as an on-chain id (it isn't — the on-chain id is sequential).
    if (numericId === null && !/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      try { numericId = BigInt(contextGraphId); } catch { /* not a numeric form */ }
    }
    if (numericId === null || numericId <= 0n) return null;

    const cacheKey = numericId.toString();
    const cached = this.onChainParticipantAgentsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached.length === 0 ? null : cached;
    }
    if (typeof this.chain.getContextGraphParticipantAgents !== 'function') {
      return null;
    }
    try {
      const agents = await this.chain.getContextGraphParticipantAgents(numericId);
      const normalised = Array.isArray(agents) ? agents : [];
      this.onChainParticipantAgentsCache.set(cacheKey, normalised);
      return normalised.length === 0 ? null : normalised;
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `resolveOnChainParticipantAgents: chain.getContextGraphParticipantAgents(${cacheKey}) failed — treating as UNKNOWN: ` +
        (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-race / pre-reg fallback for the
   * authority check on host-only cores. Returns the curator EOA the
   * local node pinned for `contextGraphId` from a previously-
   * received & verified discovery beacon (`beaconCuratorByWireId`,
   * keyed by wire-id hash).
   *
   * Wired into {@link SharedMemoryHandler#beaconCuratorOracle} as the
   * tertiary fallback after the local meta-graph and the chain
   * oracle. Input may be cleartext (envelope payload) or hash form
   * (host-only-core subscription key); we hash on the fly when the
   * input doesn't already match the wire-id regex.
   *
   * Returning a single address (the curator) is intentional: during
   * the race window we want to admit ONLY the curator's writes, not
   * the eventual member set. Once the chain event lands the
   * `chainAgentGateOracle` returns the full participant list and
   * this fallback drops out naturally.
   */
  async resolveBeaconPinnedCuratorEoa(contextGraphId: string): Promise<string | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    let wireId: string;
    if (/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      wireId = contextGraphId.toLowerCase();
    } else {
      try {
        wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
      } catch {
        return null;
      }
    }
    const curatorEoa = this.beaconCuratorByWireId.get(wireId);
    if (!curatorEoa || !ethers.isAddress(curatorEoa)) return null;
    return ethers.getAddress(curatorEoa);
  }

  // ── OT-RFC-38 / LU-6 Phase B — wire-id translation surface ────────
  //
  // All SWM wire forms (gossip topic, envelope `contextGraphId`,
  // signing payload, LU-7 catchup, host-mode store keys) are keyed by
  // `onChainHash` — `keccak256(bytes(cleartextId))` lowercase 0x-
  // prefixed hex. The wire id is the same for every node so cores can
  // derive it directly from the `ContextGraphCreated.nameHash` event
  // topic without ever learning the cleartext.
  //
  // Local form, by contrast, is whatever the node knows: cleartext for
  // CG members (who learned it via create / curator invite) and the
  // hash itself for cores that only host (never were members). The
  // helpers below are the SINGLE translation surface — every place
  // that crosses the local↔wire boundary MUST go through them. Direct
  // string concatenation against the topic format string is a recipe
  // for the curator/host topic-fragmentation bug.
  //
  // For backwards compatibility with CGs created before Phase B (the
  // `onChainHash` mapping is empty), the helpers fall back to the
  // cleartext local id as the wire id. Those CGs never went through
  // the chain-anchored discovery path so this preserves their behavior
  // — they'll keep working with curator-driven explicit subscribes.

  /**
   * Resolve the gossip wire id (hash form) for a local CG id.
   *
   * Lookup order:
   *   1. `subscribedContextGraphs[localId].onChainHash` — populated by
   *      the register-on-chain success path, the chain-event auto-
   *      discovery handler, the join-approved payload handler, and
   *      the discovery-beacon listener.
   *   2. If `localId` already looks like a wire id (32-byte hex), use
   *      it directly — handles the "core hosting a CG it never joined"
   *      case where `localId === wireId === onChainHash`.
   *   3. Compute on-the-fly via `keccak256(bytes(localId))` for CGs
   *      we created locally but haven't yet registered (allows
   *      pre-registration discovery-beacon broadcast to use a
   *      stable wire id).
   *
   * Returns lowercase 0x-prefixed hex.
   */
  gossipWireIdFor(localId: string): string {
    const sub = this.subscribedContextGraphs.get(localId);
    if (sub?.onChainHash) return sub.onChainHash;
    if (/^0x[0-9a-fA-F]{64}$/.test(localId)) return localId.toLowerCase();
    return ethers.keccak256(ethers.toUtf8Bytes(localId)).toLowerCase();
  }

  /**
   * OT-RFC-39 Codex review (round 2) on PR #727:
   * `gossipWireIdFor(rawId)` would happily keccak a literal numeric
   * string ("42") as if it were cleartext, producing a hash that does
   * NOT equal the curator-committed `nameHash`. That's fine in any
   * context where the input is guaranteed to be either cleartext or
   * bare hex (gossip-topic construction, host-mode bookkeeping). The
   * LU-11 ciphertext-chunk-store named graph is more sensitive: a
   * remote requester / ACK PublishIntent may legitimately carry the
   * numeric on-chain id, and pinning a SPARQL `GRAPH` to the wrong
   * hash means the lookup misses every persisted chunk and declines
   * a valid publish (Bug #4) or returns `chunk not found` (Bug #5).
   *
   * This helper resolves the canonical wire form for chunk-store
   * routing OR returns null to signal "use wildcard `GRAPH ?g`
   * fallback" — caller's responsibility. Numeric ids that can't be
   * resolved through the local subscription map (chain replay hasn't
   * caught up; CG isn't locally registered) return null rather than
   * silently producing the wrong hash.
   *
   * Routing rules (first match wins):
   *   1. `0x[64-hex]`             → lowercase, already wire form
   *   2. Tracked in `subscribedContextGraphs` → `gossipWireIdFor` (returns the onChainHash)
   *   3. Pure decimal → `resolveLocalCgIdByOnChainId` then wire-form; null if unknown
   *   4. Everything else (cleartext) → `gossipWireIdFor` (keccak of the cleartext bytes)
   *
   * Rule 3 NEVER falls through to a raw keccak of the decimal string —
   * that would reproduce the exact bug Codex called out. The caller
   * MUST handle the null return by widening to a wildcard scan.
   */
  canonicalChunkStoreCgIdOrNull(rawId: string): string | null {
    if (typeof rawId !== 'string' || rawId.length === 0) return null;
    if (/^0x[0-9a-fA-F]{64}$/.test(rawId)) return rawId.toLowerCase();
    if (this.subscribedContextGraphs.has(rawId)) return this.gossipWireIdFor(rawId);
    if (/^\d+$/.test(rawId)) {
      try {
        const local = this.resolveLocalCgIdByOnChainId(BigInt(rawId));
        if (local === null) return null;
        return this.gossipWireIdFor(local);
      } catch {
        return null;
      }
    }
    return this.gossipWireIdFor(rawId);
  }

  /**
   * Canonical key for the host-mode subscription bookkeeping maps
   * (`swmHostModeSubscribed`, `swmHostModeHandlers`).
   *
   * Codex PR #672 review `id=3302086589`: the four LU-6 Phase B
   * discovery paths (chain-event, beacon, reconciler, manual)
   * deliver the same CG to host-mode wiring in different shapes —
   * the chain-event and beacon paths already carry the curator-
   * committed wire hash, while the reconciler and manual paths
   * typically carry the cleartext local id (or whatever string the
   * operator POSTed). Without a single canonical key, a later
   * subscribe under a different shape misses `has()` and wires a
   * second handler on the same topic, doubling ingest and
   * persistence.
   *
   * We standardise on the WIRE FORM (curator-committed `nameHash`,
   * lowercase 0x-prefixed 32-byte hex) because it's the one shape
   * every path can reach without external lookups:
   * {@link gossipWireIdFor} already implements the reverse
   * cleartext→hash mapping (cache hit → on-chain hash; bare hex →
   * lowercased; otherwise `keccak256(utf8(cleartext))`, which IS the
   * curator-committed nameHash by definition).
   *
   * Thin alias today; kept as a separate method so the canonicalisation
   * intent is callsite-obvious and any future divergence between the
   * gossip topic key and the bookkeeping key can land in one place.
   */
  canonicalSwmHostModeKey(rawCgId: string): string {
    return this.gossipWireIdFor(rawCgId);
  }

  /**
   * Resolve the local CG id from a wire id. Used by the receive path
   * to map an envelope's `contextGraphId` (hash) back to the local id
   * used as storage/SPARQL key.
   *
   * Returns:
   *   - cleartext id if the local node is a member of the CG
   *   - the hash itself if the local node hosts but isn't a member
   *     (cores' canonical local id IS the hash — this is the
   *     "I never knew the cleartext" path)
   *   - the input as-is for non-hash inputs (pre-Phase-B fallback,
   *     plus a safety net for callers that already passed cleartext
   *     by mistake)
   *
   * Never throws. Read-only.
   */
  private localCgIdForWireId(wireId: string): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(wireId)) return wireId;
    const lower = wireId.toLowerCase();
    const localId = this.wireIdToLocalCgId.get(lower);
    if (localId) return localId;
    // Not a known member CG — return the hash as the local id. This
    // is the canonical "host-only core" path: the core's
    // subscribedContextGraphs is keyed by the hash and there's no
    // cleartext to recover.
    return lower;
  }

  /**
   * Record the curator-committed wire id for a local CG. Keeps the
   * forward (subscribedContextGraphs) and reverse (wireIdToLocalCgId)
   * mappings in lockstep. Idempotent.
   *
   * Pass `null` to clear the mapping (rare — used when a CG is
   * deactivated and we want to free the reverse-index slot).
   */
  recordCgWireId(localId: string, wireId: string | null): void {
    const sub = this.subscribedContextGraphs.get(localId);
    const lower = wireId ? wireId.toLowerCase() : null;
    if (sub) {
      sub.onChainHash = lower ?? undefined;
    }
    // Drop any stale reverse entry that pointed at this localId under
    // a different hash (curator rotated the wire id — currently
    // unsupported but cheap to defend against).
    if (sub?.onChainHash && (!lower || sub.onChainHash !== lower)) {
      const prev = sub.onChainHash;
      if (this.wireIdToLocalCgId.get(prev) === localId) {
        this.wireIdToLocalCgId.delete(prev);
      }
    }
    if (lower) {
      this.wireIdToLocalCgId.set(lower, localId);
    }
  }

  /**
   * Issue #865 — single source of truth for "what does this CG's
   * explicit accessPolicy say". Returns `'public'` / `'private'` if
   * an `accessPolicy` triple is present in either the ONTOLOGY graph
   * or this CG's `_meta` graph, otherwise `null` (no explicit
   * policy written — fall through to callers' legacy heuristics).
   *
   * Extracted so `isPrivateContextGraph` (read-path routing) and
   * `warnIfAllowlistWriteOnPublicCg` (write-path observability) can
   * never drift on the policy-resolution rules. If we ever add a new
   * policy value, the parsing fix lands in one place.
   */
  private async getExplicitAccessPolicy(
    contextGraphId: string,
  ): Promise<'public' | 'private' | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const policyValue = result.bindings[0]?.['policy'];
    if (policyValue === '"public"') return 'public';
    if (policyValue === '"private"') return 'private';
    // Defensive: any unknown literal (e.g. a future policy value the
    // older agent code doesn't recognize) is reported as `null` so
    // callers fall through to the legacy heuristic instead of
    // mis-routing on an opaque string.
    return null;
  }

  /**
   * Issue #865 — observability hook for the invite write paths. Emits a
   * warn log when the caller writes an allowlist quad on a CG that
   * carries an explicit `accessPolicy="public"` triple. We don't
   * throw here:
   *
   *   1. `publishPolicy=curated` on a public-discoverable CG is a
   *      legitimate combo (allowlist gates publishers, subscribers
   *      stay public). Rejecting would break it.
   *   2. The primary `isPrivateContextGraph` fix already prevents the
   *      original bug (silent re-route to the curated publish path).
   *   3. Pre-existing tests and adapter flows create CGs with no
   *      explicit accessPolicy and then invite — those should keep
   *      working.
   *
   * The warn line is the documentation: it tells the operator
   * "your allowlist write landed but read access stays open per the
   * explicit accessPolicy=public" so the next publisher confusion
   * has an obvious breadcrumb. Read-only, single SELECT (delegated
   * to `getExplicitAccessPolicy`) — does not mutate state.
   *
   * Codex review rounds 1, 4, and 5 on #873 — callers MUST defer
   * this until AFTER `store.insert(quadsToInsert)` succeeds. Two
   * constraints converge on the post-insert call site:
   *
   *   - Round 1 / round 4 (idempotency): logging when no quad
   *     would be inserted (no-op re-invite) misleads operators
   *     about which writes hit the store.
   *   - Round 5 (state truthfulness): logging BEFORE the insert
   *     resolves leaves a phantom breadcrumb if the insert throws.
   *
   * The current call sites in `inviteToContextGraph` /
   * `inviteAgentToContextGraph` fire this AFTER the awaited insert
   * (gated on `!alreadyAllowed` for the agent path's
   * delegation-only refresh case), so the warn is a faithful
   * record of persisted state and the wording is past-tense.
   */
  async warnIfAllowlistWriteOnPublicCg(
    contextGraphId: string,
    ctx: OperationContext,
    operation: string,
  ): Promise<void> {
    const policy = await this.getExplicitAccessPolicy(contextGraphId);
    if (policy !== 'public') return;
    this.log.warn(
      ctx,
      `${operation}: wrote allowlist quad on context graph "${contextGraphId}" which has explicit accessPolicy="public". ` +
        `The persisted quad does NOT enforce read access — anyone can still subscribe. ` +
        `Issue #865: as of this commit, the publisher no longer auto-flips public CGs to the curated publish path ` +
        `just because an allowlist exists. If you intended to make this CG invite-only, recreate it with accessPolicy=1.`,
    );
  }

  async isPrivateContextGraph(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;

    // Issue #865 — explicit `accessPolicy` ALWAYS wins over the allowlist
    // heuristic below. The previous behavior fell through to the ASK
    // check whenever `policy` was anything other than `"private"`, which
    // silently flipped a CG the curator explicitly created with
    // `accessPolicy="public"` into "private" the moment ANY invite landed
    // (`DKG_ALLOWED_AGENT` / `DKG_ALLOWED_PEER` write in `_meta`). The
    // publisher then took the LU-5 / LU-11 curated path, the publish
    // hung waiting for V2 ACKs from invitees, and the user had no
    // recovery path short of recreating the CG.
    //
    // Semantics post-#865: an allowlist on a public CG is INFORMATIONAL
    // (matches on-chain `accessPolicy=0` which the contract does not
    // enforce). Curator can still see "who I would have invited" in the
    // member list, but the publisher stays on the plaintext / public
    // path so cores can verify against SWM and the on-chain tx
    // actually submits.
    //
    // Codex review on #873 — policy lookup now delegated to the
    // shared `getExplicitAccessPolicy()` helper so this routing
    // function and the invite-path warning helper can never drift.
    const policy = await this.getExplicitAccessPolicy(contextGraphId);
    if (policy === 'private') return true;
    if (policy === 'public') return false;
    // policy === null falls through to the legacy heuristic below.

    // Legacy / discovered-CG fallback: when no explicit `accessPolicy`
    // triple exists (e.g. an old CG materialized before the predicate
    // was added, or a peer-only CG discovered via gossip without
    // ontology bootstrap), treat the presence of an allowlist
    // predicate as the curated signal. Both the V10 agent model AND
    // the legacy peer-ID model need to be recognized here so the
    // store-discovery path doesn't misclassify a freshly-invited CG
    // as "open / discoverable only" and skip the same-connect catchup.
    const allowlistResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?participantAgent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer }
        }
      }`,
    );
    if (allowlistResult.type === 'boolean' && allowlistResult.value === true) {
      return true;
    }

    return false;
  }

  async getPrivateContextGraphParticipants(contextGraphId: string): Promise<string[] | null> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value);
    };

    const localAgentParticipants = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents;
    if (localAgentParticipants) {
      for (const p of localAgentParticipants) add(p);
    }

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);

    // V10 agent model: local allowedAgent entries plus explicit on-chain
    // participantAgent entries both grant local curated access.
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        const raw = row['agent'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    // Legacy identity model: participantIdentityIds (numeric IDs as strings)
    const metaResult = await this.store.query(
      `SELECT ?identityId WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId
        }
      }`,
    );
    if (metaResult.type === 'bindings') {
      for (const row of metaResult.bindings) {
        const raw = row['identityId'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    if (merged.length > 0) return merged;

    // LU-2: on-chain CGs no longer expose `getContextGraphParticipants`.
    // Locally-stored allowedAgents/participantAgents/participantIdentityIds
    // (`merged` above) are the only authoritative source.
    return null;
  }

  /**
   * Re-sync the meta graph for a private CG from the curator to pick up
   * newly added participants. Rate-limited to avoid abuse.
   * Returns true if meta was refreshed, false if skipped or failed.
   */
  public async resolveCuratorPeerId(contextGraphId: string): Promise<string | undefined> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    const curatorResult = await this.store.query(
      `SELECT ?curator WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator
        }
      } LIMIT 1`,
    );
    if (curatorResult.type !== 'bindings' || curatorResult.bindings.length === 0) {
      return undefined;
    }
    const curatorDid = (curatorResult.bindings[0] as Record<string, string>)['curator'] ?? '';
    const didPrefix = 'did:dkg:agent:';
    if (!curatorDid.startsWith(didPrefix)) {
      return undefined;
    }
    const curatorIdentifier = curatorDid.slice(didPrefix.length);

    // Resolve curator identifier to a peer ID. The DID value is either a
    // libp2p peer ID (legacy) or an Ethereum wallet address (V10). For
    // wallet addresses, prefer the deterministic DKG_CREATOR triple (which
    // stores the libp2p peer ID) over the agent registry (which may return
    // an arbitrary match when multiple agents register the same wallet).
    let curatorPeerId = curatorIdentifier;
    if (curatorIdentifier.startsWith('0x')) {
      let resolved = false;

      // Preferred: look up the creator peer ID from the ontology definition
      // graph or the _meta graph. The dkg:creator triple uses the libp2p
      // peer ID while dkg:curator uses the wallet address.
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const creatorResult = await this.store.query(
        `SELECT ?creator WHERE {
          {
            GRAPH <${ontologyGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          } UNION {
            GRAPH <${cgMetaGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          }
        } LIMIT 1`,
      );
      if (creatorResult.type === 'bindings' && creatorResult.bindings.length > 0) {
        const creatorDid = (creatorResult.bindings[0] as Record<string, string>)['creator'] ?? '';
        if (creatorDid.startsWith(didPrefix)) {
          const creatorId = creatorDid.slice(didPrefix.length);
          if (!creatorId.startsWith('0x')) {
            curatorPeerId = creatorId;
            resolved = true;
          }
        }
      }

      // Fallback: agent registry lookup (non-deterministic if multiple agents
      // share the same wallet address, but better than failing outright)
      if (!resolved) {
        try {
          const agents = await this.discovery.findAgents();
          const match = agents.find(
            (a) => a.agentAddress?.toLowerCase() === curatorIdentifier.toLowerCase(),
          );
          if (match) {
            curatorPeerId = match.peerId;
            resolved = true;
          }
        } catch { /* registry unavailable */ }
      }

      if (!resolved) return undefined;
    }

    return curatorPeerId;
  }

  private async refreshMetaFromCurator(contextGraphId: string): Promise<boolean> {
    const now = Date.now();
    const lastRefresh = this.metaRefreshTimestamps.get(contextGraphId) ?? 0;
    if (now - lastRefresh < META_REFRESH_COOLDOWN_MS) {
      return false;
    }

    const ctx = createOperationContext('sync');
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!curatorPeerId) {
      return false;
    }

    if (curatorPeerId === this.peerId) {
      return false;
    }

    let connections = this.node.libp2p.getConnections();
    let isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);

    // If not directly connected, try dialing — first a regular dial (the peer
    // store may already have direct multiaddrs), then via relay as fallback.
    if (!isConnected) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const pid = peerIdFromString(curatorPeerId);

        try {
          await this.node.libp2p.dial(pid);
          connections = this.node.libp2p.getConnections();
          isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
        } catch { /* direct dial failed, try relay */ }

        if (!isConnected) {
          const agent = await this.discovery.findAgentByPeerId(curatorPeerId);
          if (agent?.relayAddress) {
            const { multiaddr } = await import('@multiformats/multiaddr');
            const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`);
            await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
            await this.node.libp2p.dial(pid);
            connections = this.node.libp2p.getConnections();
            isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
          }
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!isConnected) {
      return false;
    }

    try {
      const deadline = Date.now() + 10_000;
      const metaResult = await this.fetchSyncPages(ctx, curatorPeerId, contextGraphId, false, 'meta', cgMetaGraph, deadline);
      if (metaResult.quads.length > 0) {
        await this.store.insert(metaResult.quads);
        this.syncCheckpoints.delete(metaResult.checkpointKey);
        this.log.info(ctx, `Meta refresh for "${contextGraphId}": ${metaResult.quads.length} triples from curator ${curatorPeerId.slice(-8)}`);
        return true;
      }
      this.syncCheckpoints.delete(metaResult.checkpointKey);
      return false;
    } catch (err) {
      this.log.warn(ctx, `Meta refresh for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.metaRefreshTimestamps.set(contextGraphId, now);
    }
  }

  /**
   * List all known context graphs by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   *
   * Rows are backfilled from `_meta` with `DKG_CURATOR` when missing — open CGs only publish
   * curator triples locally in `_meta` while definitions sync on ONTOLOGY.
   *
   * With a valid `callerAgentAddress` option, each row includes `callerInvolved`.
   * With no usable caller wallet, omit that field entirely so callers can infer membership from `curator`.
   */
  async listContextGraphs(opts?: { callerAgentAddress?: string | null }): Promise<Array<{
    id: string;
    uri: string;
    name: string;
    description?: string;
    creator?: string;
    /** Wallet-scoped curator DID (from _meta / ontology), if present. */
    curator?: string;
    /** Declared access policy literal, e.g. public / private. */
    accessPolicy?: string;
    createdAt?: string;
    isSystem: boolean;
    subscribed: boolean;
    synced: boolean;
    onChainId?: string;
    /**
     * When `callerAgentAddress` is omitted or invalid: property is omitted —
     * clients fall back to comparing `curator` to identity (listing was not scoped to a caller).
     * When a valid caller is provided: explicit true/false.
     */
    callerInvolved?: boolean;
  }>> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const result = await this.store.query(`
      SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `);

    const prefix = 'did:dkg:context-graph:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; curator?: string; accessPolicy?: string; createdAt?: string; isSystem: boolean;
      subscribed: boolean; synced: boolean; onChainId?: string;
    }>();

    if (result.type === 'bindings') {
      const byUri = new Map<string, Record<string, string>>();
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['ctxGraph'] ?? '';
        if (!uri || byUri.has(uri)) continue;
        byUri.set(uri, row);
      }
      // Parallel lookups — sequential await per ontology row multiplied list latency noticeably.
      await Promise.all([...byUri.values()].map(async (row) => {
        const uri = row['ctxGraph'] ?? '';
        if (seen.has(uri)) return;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedContextGraphs.get(id);
        const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(row['access'] ? { accessPolicy: stripLiteral(row['access']) } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: !!row['isSystem'],
          subscribed: sub?.subscribed ?? false,
          // `synced` now means "we've actually pulled CG data from a peer
          // and stored it locally" — not "we've seen the definition
          // triple gossip across ONTOLOGY/AGENTS." The earlier behaviour
          // hard-coded `true` here, which made every gossip-discovered
          // CG look fully synced and let stale public CGs (curators
          // long gone) persist in the Oracle browse catalogue
          // indefinitely. Now `synced` mirrors the daemon's authoritative
          // subscription state set by the catchup runner (see
          // `markContextGraphSubscriptionState` at routes/context-graph.ts:1301).
          synced: sub?.synced ?? false,
          ...(onChainId ? { onChainId } : {}),
        });
      }));
    }

    // Curated CGs store their definition in their own _meta graph, not in
    // ONTOLOGY. Check _meta for any subscribed CGs not yet found above.
    for (const [id, sub] of this.subscribedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const metaGraph = contextGraphMetaGraphUri(id);
      const pUri = contextGraphDataGraphUri(id);
      const metaResult = await this.store.query(`
        SELECT ?name ?desc ?creator ?created ?curator ?access WHERE {
          GRAPH <${metaGraph}> {
            <${pUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          }
        } LIMIT 1
      `);

      if (metaResult.type === 'bindings' && metaResult.bindings.length > 0) {
        const row = metaResult.bindings[0] as Record<string, string>;
        const onChainId = sub.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? sub.name ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(row['access'] ? { accessPolicy: stripLiteral(row['access']) } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: false,
          subscribed: sub.subscribed,
          synced: sub.synced,
          ...(onChainId ? { onChainId } : {}),
        });
        continue;
      }

      // No declaration in ontology, agents, or _meta graphs. Three cases:
      //
      //  1. Chain-attested but not-yet-synced (sub.onChainId set):
      //     auto-discovery from the on-chain registry found this CG and
      //     subscribed us. Surface it as subscribed+synced=false so the
      //     UI can show a legitimate "waiting for sync" state. Any
      //     genuinely inaccessible curated CG will be removed from
      //     `subscribedContextGraphs` by the daemon's authoritative
      //     denial path (accessDeniedPeers > 0) before we get here.
      //
      //  2. Curator-approved but not-yet-meta-synced (sub.pendingMeta
      //     set): the join-approved handler subscribed us seconds ago
      //     and the first meta sync hasn't completed yet. Same UX
      //     treatment as case 1 — surface as "waiting for sync" so the
      //     project entry shows up in the sidebar immediately on
      //     approval, instead of disappearing for ~107s until the
      //     periodic catchup reconciler eventually pulls _meta. Cleared
      //     in `refreshMetaSyncedFlags` once meta arrives, at which
      //     point this entry instead surfaces via the `_meta` branch
      //     above.
      //
      //  3. Not chain-attested, not pending-meta, AND no local content:
      //     a truly phantom entry (pre-discovery subscribe that never
      //     resolved). Hide it to avoid polluting the UI. If the user
      //     legitimately subscribes later, the next catch-up writes
      //     _meta or data and the entry will appear on the next
      //     refresh.
      if (!sub.onChainId && !sub.pendingMeta) {
        // Delegate to `contextGraphHasLocalContent()` so the check
        // covers sub-graphs, assertion graphs and SWM — not just the
        // root data graph. For any non-trivial project the root data
        // graph is routinely empty (content lives in `/tasks`,
        // `/chat`, `/assertion/...`, `_shared_memory`), and checking
        // only the root caused legitimate synced projects to be
        // hidden as phantoms here (Codex tier-4m follow-up to N29,
        // same issue in a separate call site).
        const hasContent = await this.contextGraphHasLocalContent(id);
        if (!hasContent) continue;
      }

      seen.set(uri, {
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
        ...(sub.onChainId ? { onChainId: sub.onChainId } : {}),
      });
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    for (const id of storedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const sub = this.subscribedContextGraphs.get(id);
      const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
      seen.set(uri, {
        id,
        uri,
        name: sub?.name ?? id,
        isSystem: false,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        ...(onChainId ? { onChainId } : {}),
      });
    }

    let rows = Array.from(seen.values());

    /**
     * Open CGs replicate `DKG_CREATOR`/name/policy on ONTOLOGY but keep `DKG_CURATOR` in `_meta` only,
     * so list rows lack `curator` and the sidebar cannot classify "mine" without a Bearer-scoped pass.
     * Backfill once (parallelised) — also removes duplicate SPARQL in the involvement pass below.
     */
    rows = await Promise.all(rows.map(async (r) => {
      if (r.curator?.trim()) return r;
      const c = await this.getContextGraphCurator(r.id);
      return c ? { ...r, curator: c } : r;
    }));

    let checksum: string | null = null;
    const rawCaller = opts?.callerAgentAddress?.trim();
    if (rawCaller && ethers.isAddress(rawCaller)) {
      try {
        checksum = ethers.getAddress(rawCaller);
      } catch {
        checksum = null;
      }
    }

    // Privacy filter: curated/private CGs must never leak past the daemon to a non-member
    // caller. With no caller wallet (Bearer absent), drop all private rows; with a caller,
    // keep private rows only when they are curator or allowlisted participant.
    const isPrivateRow = (ap?: string): boolean => {
      if (!ap?.trim()) return false;
      const t = ap.trim().replace(/^["']|["']$/g, '').toLowerCase();
      return t === 'private';
    };

    if (!checksum) {
      // Without a caller wallet we still leave `callerInvolved` unset so the UI can use the
      // curator-vs-identity fallback for OPEN graphs.
      return rows.filter((r) => !isPrivateRow(r.accessPolicy));
    }

    const annotated = await Promise.all(rows.map(async (r) => {
      const curatorMatch = this.curatorDidMatchesChecksumAgent(r.curator, checksum);
      const allowlisted = await this.callerIsAllowlistedAgentParticipant(r.id, checksum);
      // `callerInvolved` must reflect ONLY the provided caller wallet.
      // Using local node identity (`creatorIsSelf`) leaks curated rows to unrelated callers.
      const involved = curatorMatch || allowlisted;
      return { ...r, callerInvolved: involved };
    }));

    return annotated.filter((r) => !isPrivateRow(r.accessPolicy) || r.callerInvolved === true);
  }

  async networkId(): Promise<string> {
    return computeNetworkId();
  }

  get peerId(): string {
    return this.node.peerId;
  }

  get nodeName(): string {
    return this.config.name;
  }

  get nodeFramework(): string | undefined {
    return this.config.framework;
  }

  public async getCclPolicyByUri(policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
    const records = await this.listCclPolicies({ includeBody: opts.includeBody });
    return records.find(record => record.policyUri === policyUri) ?? null;
  }

  /**
   * Verify that the caller is the owner of a context graph. When an explicit
   * callerAgentAddress is provided (agent-level token), only that identity is
   * checked — no fallback to node-level identities. This prevents non-owner
   * agents on the same node from piggybacking on the node's default agent.
   *
   * Legacy fallback (peerId / defaultAgentAddress) only applies when no
   * explicit caller is known (node-level token / backward compat).
   */
  assertCallerIsOwner(owner: string, callerAgentAddress: string | undefined, action: string): void {
    const callerDid = callerAgentAddress ? `did:dkg:agent:${callerAgentAddress}` : null;
    const selfDid = `did:dkg:agent:${this.peerId}`;

    let authorized: boolean;
    if (callerDid) {
      // Explicit caller: check only their DID.
      // Also allow through if the caller is the default agent and the owner
      // is stored under the legacy peerId-based DID (pre-agent-model CGs).
      authorized = owner === callerDid ||
        (callerAgentAddress === this.defaultAgentAddress && owner === selfDid);
    } else {
      // No explicit caller (node-level token): allow peerId and default agent only
      const defaultDid = this.defaultAgentAddress ? `did:dkg:agent:${this.defaultAgentAddress}` : null;
      authorized = owner === selfDid || (defaultDid != null && owner === defaultDid);
    }

    if (!authorized) {
      throw new Error(
        `Only the context graph creator can ${action}. ` +
        `Creator=${owner}, caller=${callerDid ?? selfDid}`,
      );
    }
  }

  public async assertContextGraphPolicyOwner(contextGraphId: string, callerAgentAddress?: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`ContextGraph "${contextGraphId}" has no registered owner; cannot manage policies.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      throw new Error(`Only the contextGraph owner can manage policies for "${contextGraphId}". Owner=${owner}, caller=${`did:dkg:agent:${callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`);
    }
  }

  /**
   * Public owner-check used by HTTP routes that need to gate curator-only
   * actions (manifest publish, SWM template rewrites, etc.). Throws a
   * caller-friendly "Only the …" error when the caller isn't the CG's
   * registered owner/curator; returns silently when they are.
   *
   * The `action` string is interpolated into the error message so the
   * 403 response can tell the user exactly what they tried to do
   * ("publish a project manifest", "overwrite onboarding templates", …).
   */
  async assertContextGraphOwner(contextGraphId: string, callerAgentAddress: string | undefined, action: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`Context graph "${contextGraphId}" has no registered owner; cannot ${action}.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      const caller = callerAgentAddress
        ? `did:dkg:agent:${callerAgentAddress}`
        : `did:dkg:agent:${this.defaultAgentAddress ?? this.peerId}`;
      throw new Error(
        `Only the context graph curator can ${action} for "${contextGraphId}". ` +
        `Owner=${owner}, caller=${caller}.`,
      );
    }
  }

  /**
   * Check if the given owner DID matches the caller or the node's own identity.
   * When `callerAgentAddress` is provided, only that exact address is accepted
   * (plus legacy peerId compat only for the default agent).
   * Without a caller (node-level token), falls back to defaultAgentAddress and peerId.
   */
  isCallerOrNodeOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const peerDid = `did:dkg:agent:${this.peerId}`;
    if (callerAgentAddress) {
      if (ownerDid === `did:dkg:agent:${callerAgentAddress}`) return true;
      if (callerAgentAddress === this.defaultAgentAddress && ownerDid === peerDid) return true;
      return false;
    }
    // No explicit caller (SDK / node-level token): accept only the node's
    // own identities (peerId + defaultAgentAddress). On multi-agent nodes,
    // callers must supply callerAgentAddress to operate on non-default CGs.
    if (ownerDid === peerDid) return true;
    if (this.defaultAgentAddress && ownerDid === `did:dkg:agent:${this.defaultAgentAddress}`) return true;
    return false;
  }

  /**
   * Chain registration must be authorized by an EVM-address principal. A
   * libp2p peer ID proves transport identity, not on-chain authority.
   */
  isCallerOrNodeAddressOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const ownerAddress = ownerDid.replace(/^did:dkg:agent:/, '');
    if (!ethers.isAddress(ownerAddress)) return false;
    if (callerAgentAddress) {
      return ethers.isAddress(callerAgentAddress) && ownerAddress.toLowerCase() === callerAgentAddress.toLowerCase();
    }
    return !!this.defaultAgentAddress
      && ethers.isAddress(this.defaultAgentAddress)
      && ownerAddress.toLowerCase() === this.defaultAgentAddress.toLowerCase();
  }

  /**
   * Address that will SIGN on-chain CG-state-changing txs (the wallet
   * the adapter binds to `contracts.contextGraphs` and invokes
   * `createContextGraph`/`updatePublishPolicy`/etc with).
   *
   * Codex PR #502 round-8/round-9: this MUST be the actual tx signer,
   * NOT the publishing principal. We deliberately skip:
   *   - `config.publisherAddress` — the configured KA publisher
   *     address, which can be a publishing delegate that does NOT
   *     sign chain txs.
   *   - `getAuthorizedPublisherAddress(contextGraphId)` — per-CG
   *     publish-time delegate registered on chain.
   *   - The generic `signMessage` probe — returns the adapter's
   *     signing principal for arbitrary messages, not its tx-signing
   *     wallet specifically.
   *
   * We only probe signer-specific adapter surfaces:
   *   1. `getSignerAddress()` (modern method — used by the EVM
   *      adapter).
   *   2. `getSignerAddresses()` (multi-signer pool; we take the
   *      first valid address).
   *   3. `signerAddress` property (mock adapter and parity tests).
   *   4. `getOperationalPrivateKey()` (legacy adapters).
   *
   * Returning `undefined` triggers the round-5 "fail closed" branch
   * in `registerContextGraph`: PCA registration is rejected because
   * the invariant cannot be verified.
   */
  async getRegistrationTxSignerAddress(): Promise<string | undefined> {
    const chain = this.chain;

    const signerAddressGetter = (chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
    if (typeof signerAddressGetter === 'function') {
      try {
        const address = normalizeAdapterPublisherAddress(await Promise.resolve(signerAddressGetter.call(chain)));
        if (address) return address;
      } catch {
        // Best-effort probe; fall through to broader signer surfaces.
      }
    }

    const signerAddressesGetter = (chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
    if (typeof signerAddressesGetter === 'function') {
      try {
        const advertised = await Promise.resolve(signerAddressesGetter.call(chain));
        if (Array.isArray(advertised)) {
          for (const value of advertised) {
            const address = normalizeAdapterPublisherAddress(value);
            if (address) return address;
          }
        }
      } catch {
        // Best-effort probe.
      }
    }

    const signerAddress = normalizeAdapterPublisherAddress(
      (chain as unknown as { signerAddress?: unknown }).signerAddress,
    );
    if (signerAddress) return signerAddress;

    const adapterOperationalAddress = adapterOperationalPrivateKeyAddress(chain);
    if (adapterOperationalAddress) return adapterOperationalAddress;

    return undefined;
  }

  async getChainPublishAuthorityAddress(contextGraphId?: string): Promise<string | undefined> {
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(this.config.publisherAddress);
    if (configuredPublisherAddress) return configuredPublisherAddress;

    const legacyAdapterOperationalKey = this.config.chainConfig?.operationalKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    if (
      this.config.chainAdapter &&
      legacyAdapterOperationalAddress &&
      !(await adapterAdvertisesPublisherSigner(this.chain))
    ) {
      return legacyAdapterOperationalAddress;
    }

    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(contextGraphId ?? '');
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Local descriptive CG ids cannot be used as adapter context hints.
    }
    // This mirrors the publisher resolver, including the adapter-only
    // `getOperationalPrivateKey()` fallback used by custom ChainAdapters.
    return inferAdapterPublisherAddress(this.chain, publisherContextGraphId, {
      includeReservingPublisherProbe: false,
      includeGenericSignMessageProbe: false,
    });
  }

  // NOTE: `getContextGraphPublishAuthorityAccountId` and
  // `setContextGraphPublishAuthorityAccountId` helpers were removed in
  // Codex PR #502 round-6. With `registerContextGraph` no longer
  // falling back to stored values and `createContextGraph` no longer
  // persisting them, nothing on this code path reads or writes the
  // `DKG_PUBLISH_AUTHORITY_ACCOUNT_ID` triple anymore — pcaAccountId
  // lives strictly in the explicit `publishAuthorityAccountId` opt on
  // `registerContextGraph`.

  /**
   * Return true when `senderPeerId` is currently acting as the curator
   * of `contextGraphId`. Used as a minimal anti-spoof gate on join
   * lifecycle notifications (approve/reject) — those arrive unsigned
   * over p2p, so without this check any peer that knows a local
   * agent's address could forge a rejection and drive our UI into a
   * false "denied" state (Codex tier-4k N27).
   *
   * Resolution order:
   *  1. If the CG's recorded curator is a peer-ID DID
   *     (`did:dkg:agent:<libp2p-peer-id>`, legacy/creator path), match
   *     directly against `senderPeerId`.
   *  2. Otherwise the CG was registered with a wallet-scoped curator
   *     (`did:dkg:agent:0x…`). Consult the agent registry and accept
   *     the sender iff the curator agent's currently advertised peer
   *     ID matches. Registry lookup is cheap (local graph query).
   *
   * A missing curator / registry failure is treated as "not curator"
   * — we'd rather drop a real rejection than surface a forged one.
   */
  /**
   * Authorise the sender of a join-approved/rejected notification for
   * `(contextGraphId, agentAddress)`. Tries two sources, in order:
   *
   *   1. `joinRequestAcceptedBy` — peers that returned `{ok: true}`
   *      to our broadcast in `forwardJoinRequest`. This is the only
   *      check that works for the freshly-rejected case (no _meta
   *      access yet).
   *   2. `senderIsContextGraphCurator` — meta-graph curator lookup
   *      with registry fallback. This catches the case where we
   *      restarted between submit and decision (in-memory map lost),
   *      or where we're an already-approved member receiving a later
   *      decision (we have meta access from the prior approval).
   */
  public async isTrustedJoinDecisionSender(
    contextGraphId: string,
    agentAddress: string,
    senderPeerId: string,
  ): Promise<boolean> {
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;
    const accepted = this.joinRequestAcceptedBy.get(acceptedKey);
    if (accepted?.has(senderPeerId)) return true;
    return this.senderIsContextGraphCurator(contextGraphId, senderPeerId);
  }

  private async senderIsContextGraphCurator(contextGraphId: string, senderPeerId: string): Promise<boolean> {
    try {
      const owner = await this.getContextGraphOwner(contextGraphId);
      if (!owner) return false;
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (ownerTail === senderPeerId) return true;
      // Wallet-scoped curator: resolve via registry. The curator's
      // peer ID is whatever they currently advertise — `findAgents()`
      // returns the freshest mapping we know about.
      if (/^0x[0-9a-fA-F]{40}$/.test(ownerTail)) {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === ownerTail.toLowerCase());
        if (match && match.peerId === senderPeerId) return true;
      }
    } catch {
      // Any lookup failure → err on the side of "not curator" and drop.
    }
    return false;
  }

  async getContextGraphOwner(contextGraphId: string): Promise<string | null> {
    // Prefer the curator (wallet-scoped owner) so per-agent authorization
    // works on multi-agent nodes. Fall back to the creator (libp2p peer ID)
    // for legacy CGs created before the curator triple existed.
    //
    // Delegates to `getContextGraphCurator`, which already handles the
    // "multiple `dkg:curator` triples on the same local store" hazard
    // (peer sync replicates foreign curator triples) by preferring a
    // LOCAL agent's DID before falling back to the first row. Without
    // that preference, the LIMIT-1 lookup here would non-deterministically
    // pick a foreign curator and lock the real local curator out of
    // manage-participants / rename / policy operations.
    const curatorOwner = await this.getContextGraphCurator(contextGraphId);
    if (curatorOwner) return curatorOwner;
    const fromCreator = await this.getContextGraphCreator(contextGraphId);
    if (fromCreator) return fromCreator;
    // Final fallback: V10 wallet-scoped cgId convention (`0x.../<name>`)
    // encodes the curator structurally, which lets us answer for CGs
    // whose RDF `_meta` triples were never written locally — most
    // commonly because on-chain registration didn't complete (no
    // identity, RPC down, mid-flight crash). Without this fallback, the
    // PROTOCOL_JOIN_REQUEST handler silently rejects every join attempt
    // for these CGs and the joiner sees only a generic "no reachable
    // curator". See `deriveCuratorDidFromCgId` for the full rationale.
    //
    // Gate: only return the structurally-derived curator when the CG
    // actually exists locally. Without this gate, a node would accept
    // PROTOCOL_JOIN_REQUEST for any wallet-prefixed CG id starting
    // with one of its agent addresses (`0x<my-addr>/<anything>`) and
    // create stray `_meta` rows for graphs that were never created
    // here. The fallback is meant to rescue real-but-half-registered
    // graphs, not impersonate ownership of unknown ones.
    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) return null;
    return deriveCuratorDidFromCgId(contextGraphId);
  }

  async getContextGraphCurator(contextGraphId: string): Promise<string | null> {
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    // Multi-curator scenario: peer-to-peer sync of CG `_meta` triples
    // can replicate FOREIGN `dkg:curator` triples onto a node's local
    // store. The original behaviour (`LIMIT 1`) made ownership lookup
    // non-deterministic — any subscribing node could win the unordered
    // query, locking the real curator out of their own CG-management
    // operations (revoke, rename, policy edits). Comment at
    // `ensureContextGraphLocal` (~13754) already documents this hazard
    // for the bootstrap path; the same fix applies at lookup time so
    // we're robust to any future re-introduction of foreign-curator
    // syncing.
    //
    // Resolution: enumerate ALL curator triples and prefer one that
    // matches a LOCAL agent (the node's own peer-id DID, any of its
    // wallet-scoped agents, or the default-agent DID). Falls back to
    // the first curator triple when no local match exists, preserving
    // the legacy "subscriber sees foreign owner" semantics for
    // membership/UI queries against CGs this node did not curate.
    const curatorResult = await this.store.query(`
      SELECT ?owner WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?owner .
        }
      }
    `);
    if (curatorResult.type !== 'bindings' || curatorResult.bindings.length === 0) {
      return null;
    }
    const owners: string[] = [];
    for (const b of curatorResult.bindings) {
      const o = (b as Record<string, string>)['owner'];
      if (o) owners.push(o);
    }
    if (owners.length === 0) return null;
    if (owners.length === 1) return owners[0];
    const selfDid = `did:dkg:agent:${this.peerId}`;
    const localAgentDids = new Set<string>();
    localAgentDids.add(selfDid);
    if (this.defaultAgentAddress) {
      localAgentDids.add(`did:dkg:agent:${this.defaultAgentAddress}`);
    }
    for (const addr of this.localAgents.keys()) {
      localAgentDids.add(`did:dkg:agent:${addr}`);
    }
    const localOwner = owners.find((o) => localAgentDids.has(o));
    return localOwner ?? owners[0];
  }

  /**
   * Curator DID (`did:dkg:agent:0x…`) matches the caller's checksummed wallet address.
   */
  private curatorDidMatchesChecksumAgent(curatorRaw: string | undefined, checksumAddress: string): boolean {
    if (!curatorRaw?.trim()) return false;
    let t = curatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${checksumAddress.toLowerCase()}`;
    return t.toLowerCase() === expected;
  }

  /**
   * Creator DID (`did:dkg:agent:<peerId>`) matches THIS node's libp2p peer id.
   * Membership signal for CGs created via this node before wallet-based curator metadata
   * was the convention — without this, a node admin (bearer-authed) loses sight of CGs
   * their own node created. Peer ids are case-sensitive base58, so we match exactly after
   * stripping IRI/quote framing.
   */
  private creatorDidMatchesSelfPeer(creatorRaw: string | undefined): boolean {
    if (!creatorRaw?.trim()) return false;
    let t = creatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${this.node.peerId}`;
    return t === expected;
  }

  /**
   * Whether the wallet is on the CG allowlist (participant / allowed-agent) or tied to a
   * listed on-chain identity ID. Does not consult curator — compose with curator checks separately.
   */
  private async callerIsAllowlistedAgentParticipant(contextGraphId: string, checksumAddress: string): Promise<boolean> {
    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);
    if (!participants?.length) return false;

    for (const raw of participants) {
      const p = String(raw).replace(/^["']|["']$/g, '');
      if (ethers.isAddress(p)) {
        if (ethers.getAddress(p).toLowerCase() === checksumAddress.toLowerCase()) return true;
        continue;
      }
      if (/^\d+$/.test(p) && this.chain.isOperationalWalletRegistered) {
        try {
          if (await this.chain.isOperationalWalletRegistered(BigInt(p), checksumAddress)) return true;
        } catch {
          // ignore chain read errors — treat as non-participant
        }
      }
    }
    return false;
  }

  async getContextGraphParticipantAgentAddresses(contextGraphId: string): Promise<string[]> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const normalized = value.replace(/^"|"$/g, '');
      if (!ethers.isAddress(normalized)) return;
      const checksumAddress = ethers.getAddress(normalized);
      if (checksumAddress === ethers.ZeroAddress) {
        throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(checksumAddress);
    };

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    // OT-RFC-38 / LU-6 Phase B — the on-chain participant-agent list
    // is now the authoritative source for the host-mode envelope
    // authority check on cores (see `resolveOnChainParticipantAgents`
    // + `chainAgentGateOracle` in the publisher). For cores hosting
    // CGs they didn't create or join, the local `_meta` allowlist is
    // unreachable, so the chain list MUST contain every wallet that
    // will sign envelopes — otherwise valid ciphertext gets rejected
    // and pre-registration auto-host can't bootstrap.
    //
    // Pre-Phase-B, `DKG_PARTICIPANT_AGENT` and `DKG_ALLOWED_AGENT`
    // were semantically distinct: PARTICIPANT was the chain-side
    // allowlist (for KA publish + attestation signing), ALLOWED was
    // the local-side allowlist (for SWM decrypt). Cores never needed
    // ALLOWED because they didn't subscribe to curated SWM. With
    // Phase B they do, so the chain list MUST be a SUPERSET of the
    // local list. We merge `DKG_ALLOWED_AGENT` into the result here.
    //
    // Backward-compat: callers that explicitly passed
    // `participantAgents` on `createContextGraph` keep their values
    // (those are persisted as PARTICIPANT triples). The merge below
    // is a UNION so any per-CG explicit list survives and just gets
    // augmented with whatever local allowlist exists.
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        add(row['agent']);
      }
    }
    return merged;
  }

  /**
   * Read `dkg:creator` (peer-ID DID) for a contextGraph. This is the publicly
   * discoverable owner handle used in gossip validation — it propagates
   * through ONTOLOGY sync for open CGs, while `dkg:curator` stays in `_meta`.
   * Emitted approve/revoke binding metadata must use this value so remote
   * peers validating via `gossip-publish-handler` see a matching owner.
   */
  async getContextGraphCreator(contextGraphId: string): Promise<string | null> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(`
      SELECT ?owner WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        }
      }
      LIMIT 1
    `);
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    return (result.bindings[0] as Record<string, string>)['owner'] ?? null;
  }

  public async listCclPolicyBindings(opts: {
    contextGraphId?: string;
    name?: string;
  } = {}): Promise<PolicyApprovalBinding[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const result = await this.store.query(`
      SELECT ?binding ?policy ?contextGraph ?name ?contextType ?bindingStatus ?approvedAt ?approvedBy ?revokedAt ?revokedBy WHERE {
        GRAPH <${ontologyGraph}> {
          ?binding <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_POLICY_BINDING}> ;
                   <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                   <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                   <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy ;
                   <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt .
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS}> ?bindingStatus }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_AT}> ?revokedAt }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_BY}> ?revokedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?approvedAt)
    `);

    if (result.type !== 'bindings') return [];
    const byBinding = new Map<string, PolicyApprovalBinding>();
    for (const row of result.bindings as Record<string, string>[]) {
      const bindingUri = row['binding'];
      const revokedAt = row['revokedAt'] ? stripLiteral(row['revokedAt']) : undefined;
      const next: PolicyApprovalBinding = {
        bindingUri,
        policyUri: row['policy'],
        contextGraphId: row['contextGraph'].startsWith('did:dkg:context-graph:') ? row['contextGraph'].slice('did:dkg:context-graph:'.length) : row['contextGraph'],
        name: stripLiteral(row['name']),
        contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
        status: revokedAt || (row['bindingStatus'] && stripLiteral(row['bindingStatus']) === 'revoked') ? 'revoked' : 'approved',
        approvedAt: stripLiteral(row['approvedAt']),
        approvedBy: row['approvedBy'],
        revokedAt,
        revokedBy: row['revokedBy'],
      };
      const current = byBinding.get(bindingUri);
      if (!current) {
        byBinding.set(bindingUri, next);
        continue;
      }
      byBinding.set(bindingUri, {
        ...current,
        status: (current.revokedAt || next.revokedAt) ? 'revoked'
          : (current.status === 'superseded' || next.status === 'superseded') ? 'superseded'
          : 'approved',
        revokedAt: current.revokedAt ?? next.revokedAt,
        revokedBy: current.revokedBy ?? next.revokedBy,
        approvedBy: current.approvedBy ?? next.approvedBy,
      });
    }
    const allBindings = Array.from(byBinding.values()).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

    // Mark non-revoked, non-latest bindings as "superseded" per scope
    const latestByScope = new Map<string, string>();
    for (const b of allBindings) {
      if (b.status === 'revoked') continue;
      const key = `${b.contextGraphId}|${b.name}|${b.contextType ?? ''}`;
      if (!latestByScope.has(key)) {
        latestByScope.set(key, b.bindingUri);
      } else if (b.bindingUri !== latestByScope.get(key)) {
        b.status = 'superseded';
      }
    }
    return allBindings;
  }

  public selectLatestNonRevokedBindings(bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
    const latestByScope = new Map<string, PolicyApprovalBinding>();
    for (const binding of bindings) {
      if (binding.status === 'revoked' || binding.status === 'superseded') continue;
      const key = `${binding.contextGraphId}|${binding.name}|${binding.contextType ?? ''}`;
      const current = latestByScope.get(key);
      if (!current || binding.approvedAt > current.approvedAt) {
        latestByScope.set(key, binding);
      }
    }
    return latestByScope;
  }

  public resolveCclPolicyBinding(
    latestByScope: Map<string, PolicyApprovalBinding>,
    contextGraphId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${contextGraphId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${contextGraphId}|${name}|`)
      ?? null;
  }

  public async getActiveCclPolicyBinding(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<PolicyApprovalBinding | null> {
    const record = await this.getCclPolicyByUri(opts.policyUri);
    if (!record) return null;
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const active = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, record.name, opts.contextType);
    if (!active || active.policyUri !== opts.policyUri) return null;
    return active;
  }

  public deriveCclPolicyStatus(
    policyUri: string,
    storedStatus: string,
    bindings: PolicyApprovalBinding[],
    latestByScope: Map<string, PolicyApprovalBinding>,
  ): string {
    if (Array.from(latestByScope.values()).some(binding => binding.policyUri === policyUri)) {
      return 'approved';
    }
    if (bindings.some(binding => binding.policyUri === policyUri)) {
      return 'revoked';
    }
    return storedStatus;
  }

  public async publishOntologyQuads(ual: string, quads: Quad[]): Promise<void> {
    const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const msg = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      kas: [],
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: '',
      startKAId: 0,
      endKAId: 0,
      chainId: '',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    try {
      await this.gossip.publish(ontologyTopic, msg);
    } catch {
      // No peers subscribed — ok for local-only operation
    }
  }

  get identityId(): bigint {
    return this.publisher.getIdentityId();
  }

  /**
   * Sign the context graph participant digest: keccak256(contextGraphId, merkleRoot).
   * Returns the caller's identity ID and compact ECDSA (r, vs) values that the
   * ContextGraphs contract can verify via ecrecover.
   */
  async signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> {
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('Chain adapter does not support signMessage');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, ethers.hexlify(merkleRoot)],
    );
    const sig = await this.chain.signMessage(ethers.getBytes(digest));
    return { identityId: this.identityId, ...sig };
  }

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  /** Returns a snapshot of the context graph subscription registry. */
  getSubscribedContextGraphs(): ReadonlyMap<string, ContextGraphSub> {
    return this.subscribedContextGraphs;
  }

  /** Returns the latest health snapshot for all known peers. */
  getPeerHealth(): ReadonlyMap<string, PeerHealth> {
    return this.peerHealth;
  }

  async getPeerProtocols(peerId: string): Promise<string[]> {
    return diagnostics.getPeerProtocols(this.node, peerId);
  }

  /**
   * Snapshot of the Universal Messenger SLO histogram + counters
   * across every protocol the substrate has seen traffic for.
   * Source of truth for the rc.9 ship-gate overnight soak; surfaced
   * via the daemon's localhost-only `/api/slo` endpoint.
   *
   * rc.9 PR-12.
   */
  getMessengerSloStats(): Record<string, SloProtocolStats> {
    return this.messenger.getSloStats();
  }

  /**
   * Snapshot of SWM gossip publish health (rc.9 PR-A).
   *
   * - `publishFailures` — per-cgId count of failed `gossip.publish`
   *   calls. Pre-rc.9 these were silently swallowed; now they're
   *   observable. A non-zero counter is operator-visible signal that
   *   some shares went out-of-band only (local commit succeeded;
   *   catch-up will run via `runSyncOnConnect` on the next peer
   *   reconnect).
   * - `publishFailuresOverflow` — sum of counters that were evicted
   *   when the per-cgId tracking set crossed
   *   `SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS`. Always 0 in normal
   *   deployments; non-zero only when a caller has been failing
   *   publishes against thousands of distinct cgIds.
   * - `publishFailuresTruncated` — sticky boolean, true once the
   *   eviction path has fired. Surfaced via Codex PR #570 R5 so
   *   operators see that the per-cgId breakdown is partial even
   *   though the grand total (`sum(publishFailures) +
   *   publishFailuresOverflow`) is still accurate.
   */
  getSwmGossipStats(): {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  } {
    return diagnostics.getSwmGossipStats({
      publishFailures: this.swmGossipPublishFailures,
      publishFailuresOverflow: this.swmGossipPublishFailuresOverflow,
      publishFailuresTruncated: this.swmGossipPublishFailuresTruncated,
    });
  }

  /**
   * Snapshot of receiver-side SWM apply metrics (rc.9 PR-A).
   *
   * - `redundantApplies` — per-cgId count of times
   *   `SharedMemoryHandler.handle()` saw a (cgId, shareOpId) it had
   *   already processed within the TTL window AND both deliveries
   *   actually applied to the store. Used to inform the rc10
   *   decision on whether to add explicit receiver-side dedup
   *   (Concern-2 in the SWM reliable fan-out plan).
   * - `redundantAppliesLowerBound` — sticky boolean, true once the
   *   seenShareOps cap eviction had to trim a still-live entry.
   *   Surfaced via Codex PR #570 R3 so operators can detect that
   *   the metric has become a lower bound (configured cap too small
   *   for current throughput).
   * - `redundantAppliesOverflow` — sum of per-cgId counters evicted
   *   into the overflow bucket when the per-cgId map crossed the
   *   `redundantAppliesMaxCgs` cap. Surfaced via Codex PR #570 R9.
   * - `redundantAppliesTruncated` — sticky boolean, true once R9
   *   eviction has fired. Means the per-cgId breakdown is partial;
   *   the grand total is still `sum(redundantApplies) +
   *   redundantAppliesOverflow`.
   *
   * Returns the empty / pristine snapshot if the SharedMemoryHandler
   * has not yet been initialised (no SWM share has ever been received
   * locally).
   */
  getSwmHandlerStats(): {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
  } {
    return diagnostics.getSwmHandlerStats(this.sharedMemoryHandler);
  }

  async getPeerDiagnostics(peerId: string): Promise<PeerDiagnostics> {
    return diagnostics.getPeerDiagnostics(
      { node: this.node, messenger: this.messenger, peerHealth: this.peerHealth },
      peerId,
    );
  }

  /**
   * Ping all known peers to check liveness. Updates the peerHealth map with
   * latency and last-seen timestamps. Returns the number of peers that responded.
   */
  async pingPeers(): Promise<number> {
    return diagnostics.pingPeers({ node: this.node, peerHealth: this.peerHealth, log: this.log });
  }

  /**
   * Scan the local ONTOLOGY graph and curated/private _meta graphs for context
   * graph definitions and auto-subscribe to any that aren't yet in the
   * subscription registry. Called after syncFromPeer to catch context graphs
   * discovered via ONTOLOGY sync or authenticated _meta sync.
   */
  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, { id: string; name: string; source: 'ontology' | 'meta' }>();

    const collectEntries = (
      rows: Record<string, string>[],
      source: 'ontology' | 'meta',
    ) => {
      for (const row of rows) {
        const uri = row['ctxGraph'] ?? '';
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!id) continue;
        if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

        const existing = discoveredEntries.get(id);
        const name = row['name'] ? stripLiteral(row['name']) : existing?.name ?? id;

        if (!existing || (existing.source === 'meta' && source === 'ontology')) {
          discoveredEntries.set(id, { id, name, source });
        }
      }
    };

    const ontologyResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (ontologyResult.type === 'bindings') {
      collectEntries(ontologyResult.bindings as Record<string, string>[], 'ontology');
    }

    const metaResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH ?metaGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
          FILTER(STRENDS(STR(?metaGraph), "/_meta"))
        }
      }
    `);
    if (metaResult.type === 'bindings') {
      collectEntries(metaResult.bindings as Record<string, string>[], 'meta');
    }

    for (const { id, name, source } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) continue;

      // Two kinds of discovered CG, two different opt-in semantics:
      //
      // - Open / public CG (no curated _meta graph locally): Viktor's
      //   v10-rc hardening (commit b9a73e7e "better sync") says do
      //   NOT auto-subscribe — a node shouldn't auto-ingest every
      //   public CG a peer happens to know about. Explicit subscribe
      //   (UI "Join" / `subscribeToContextGraph`) is the opt-in.
      //
      // - Curated / private CG (access policy "private" or has an
      //   allowlist): auto-subscribe so `trySyncFromPeer`'s
      //   "newly discovered CGs" catchup pass (see dkg-agent.ts
      //   ~#1009) actually fetches the KC data on the same connect
      //   cycle. Without this, a freshly invited node would see
      //   the CG registered locally but never pull any KCs —
      //   regressed the e2e-privacy "B discovers and syncs a
      //   private CG in a single connect cycle via trySyncFromPeer"
      //   test. `authorizeSyncRequest` still enforces the allowlist
      //   on the responder side, so auto-subscribing here cannot
      //   leak private data to non-participants; it only means
      //   "attempt the catchup now instead of deferring it".
      //   NOTE: we use `isPrivateContextGraph` (which reads the
      //   ontology OR the _meta graph for `dkg:accessPolicy
      //   "private"`, and also treats any CG with a `DKG_ALLOWED_
      //   AGENT` allowlist as private) rather than
      //   `source === 'meta'`, because the ontology-vs-meta
      //   collision resolver above lets an ontology row shadow a
      //   meta row when both exist for the same id.
      const isCurated = await this.isPrivateContextGraph(id);

      if (isCurated) {
        // Seed the subscription entry BEFORE calling subscribeToContextGraph
        // so the `...existing` spread in `subscribeToContextGraph` preserves
        // the discovered human-readable `name` (otherwise the UI/listing
        // APIs fall back to the raw CG id).
        //
        // `synced: false` is the truthful state at discovery — we have
        // the definition triple but no CG content yet. The catchup
        // runner flips it to true once data has actually been pulled
        // (see `markContextGraphSubscriptionState` at
        // routes/context-graph.ts:1301).
        //
        // Intentionally leave `metaSynced` FALSE here for the same
        // reason: the gossip handler's "deny until _meta is synced"
        // guard must stay armed until the authenticated allowlist
        // (`_meta` graph) has actually arrived. The follow-up
        // `refreshMetaSyncedFlags(newlyDiscovered)` call from
        // `trySyncFromPeer` will flip it once the allowlist has been
        // fetched via the authenticated sync path.
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: false,
          onChainId: undefined,
        }, { persist: false });
        this.subscribeToContextGraph(id);
        this.log.info(ctx, `Discovered invited context graph "${name}" (${id}) — auto-subscribed (private/allowlisted)`);
      } else {
        // Same truthful-flag rationale as the curated branch above:
        // `synced` reflects "have CG data locally", not "have heard the
        // definition triple from gossip."
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: source === 'meta',
          onChainId: undefined,
        }, { persist: false });
        this.log.info(ctx, `Discovered context graph "${name}" (${id}) from ${source} store — added as discoverable only`);
      }
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store`);
    }
    return discovered;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }

    let onChainContextGraphs;
    try {
      onChainContextGraphs = await this.chain.listContextGraphsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain context graph scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainContextGraphs) {
      if (knownOnChainIds.has(p.contextGraphId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.contextGraphId);
        continue;
      }

      // Curated CGs (accessPolicy=1) must not silently land in non-participants' lists.
      // We can't query the V10 ContextGraphs participant set from a NameRegistry event alone,
      // so apply the strict default: only auto-subscribe when this node's wallet matches
      // `creator` (the address that called claimName). Real participants will have the CG
      // surfaced through manual subscribe / catch-up triggered by their curator.
      if (Number(p.accessPolicy) === 1) {
        const isCurator = !!this.defaultAgentAddress
          && typeof p.creator === 'string'
          && p.creator.toLowerCase() === this.defaultAgentAddress.toLowerCase();
        if (!isCurator) {
          this.log.info(ctx, `Skipping auto-subscribe to curated chain entry "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — not curator`);
          knownOnChainIds.add(p.contextGraphId);
          continue;
        }
      }

      this.setContextGraphSubscription(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        metaSynced: false,
        onChainId: p.contextGraphId,
      });
      this.subscribeToContextGraph(p.name, { trackSyncScope: false });

      // Persist the on-chain ID to the ontology graph so the publisher's
      // VM registration guard can find it via RDF (it has no access to
      // the in-memory subscribedContextGraphs map).
      const cgUri = contextGraphDataGraphUri(p.name);
      const ontoGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      await this.store.insert([{
        subject: cgUri,
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: `"${p.contextGraphId}"`,
        graph: ontoGraph,
      }]);

      this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    return discovered;
  }

  /**
   * Snapshot of the V10 Random Sampling prover's recent activity.
   * Returns a disabled-handle status when the prover never started
   * (edge node, no identity, missing chain methods). Used by the
   * daemon's `/api/random-sampling/status` route + the CLI's
   * `random-sampling status` subcommand.
   */
  getRandomSamplingStatus(): RandomSamplingStatus {
    if (this.randomSamplingHandle) return this.randomSamplingHandle.getStatus();
    return {
      enabled: false,
      role: (this.config.nodeRole ?? 'edge') as 'core' | 'edge',
      identityId: '0',
      loop: null,
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      // Await so any in-flight poll (and its HTTP keep-alive socket) settles
      // BEFORE we tear down the chain adapter — otherwise the RPC connection
      // closure surfaces as an `ECONNRESET` unhandled rejection from inside
      // ethers (the same flake that has been hitting `publisher [2/4]` in CI).
      await this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
    if (this.hostModeReconcilerTimer) {
      clearInterval(this.hostModeReconcilerTimer);
      this.hostModeReconcilerTimer = null;
    }
    if (this.hostModePruneTimer) {
      clearInterval(this.hostModePruneTimer);
      this.hostModePruneTimer = null;
    }
    if (this.beaconReannounceTimer) {
      clearInterval(this.beaconReannounceTimer);
      this.beaconReannounceTimer = undefined;
    }
    if (this.agentProfileHeartbeatTimer) {
      clearInterval(this.agentProfileHeartbeatTimer);
      this.agentProfileHeartbeatTimer = undefined;
    }
    if (this.syncReconcilerTimer) {
      clearInterval(this.syncReconcilerTimer);
      this.syncReconcilerTimer = null;
    }
    if (this.warmCoreTimer) {
      clearInterval(this.warmCoreTimer);
      this.warmCoreTimer = null;
    }
    if (this.vmReconcileTimer) {
      clearInterval(this.vmReconcileTimer);
      this.vmReconcileTimer = null;
    }
    if (this.messengerOutboxTimer) {
      clearInterval(this.messengerOutboxTimer);
      this.messengerOutboxTimer = null;
    }
    if (this.swmAckQuorumTimer) {
      clearInterval(this.swmAckQuorumTimer);
      this.swmAckQuorumTimer = null;
    }
    // rc.9 PR-10: joinApprovalRetryTimer + joinApprovalRetryQueue
    // deleted; substrate outbox owns retry state and drains itself
    // via the messengerOutboxTimer cleared just above.
    this.clearRandomSamplingBindRetry();
    this.clearStorageACKRegistrationRetry();
    this.storageACKRegistrationRetryInFlight = false;
    if (this.randomSamplingHandle) {
      try { await this.randomSamplingHandle.stop(); } catch { /* swallow on shutdown */ }
      this.randomSamplingHandle = null;
    }
    // rc.9 PR-G codex follow-up #G3: drain background substrate
    // fan-outs spawned by `publishWorkspaceGossip` (G2's
    // fire-and-forget detach) before tearing down libp2p. Without
    // this drain, a process that calls `share()` and then
    // shuts down (test runs, soak script SIGTERM, daemon
    // restart) could abandon mid-flight per-peer substrate sends
    // — regressing the pre-G2 guarantee that share() didn't
    // return until every substrate attempt either succeeded or
    // landed in the durable outbox. The bookkeeper still feeds
    // the per-cgId counters during the drain, so /api/slo's
    // last sample before shutdown reflects the true completion
    // state.
    //
    // We bound the wait with `Promise.race` against
    // `SWM_SUBSTRATE_FANOUT_TIMEOUT_MS + 1s`. Per-peer sends
    // already have that timeout; the +1s slack covers post-
    // timeout cleanup (counter update + INFO log emit) for
    // peers that hit the timeout right as `stop()` is called.
    // After the bound we proceed with libp2p teardown even if
    // some fan-outs remain — better to enforce a shutdown SLA
    // than to hang the process indefinitely on one unresponsive
    // peer. The unfinished sends will fall back to outbox on
    // recoverable failures (queued count bumps) just as they
    // would under any other teardown.
    if (this.inFlightSubstrateFanOutCount() > 0) {
      const drainBoundMs = DKGAgent.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS + 1000;
      await Promise.race([
        this.awaitInFlightSubstrateFanOuts(),
        new Promise<void>((resolve) => setTimeout(resolve, drainBoundMs).unref?.()),
      ]);
      if (this.inFlightSubstrateFanOutCount() > 0) {
        this.log.warn(
          createOperationContext('share'),
          `DKGAgent.stop: ${this.inFlightSubstrateFanOutCount()} substrate fan-outs still in flight after ${drainBoundMs}ms drain bound — proceeding with shutdown (outbox will pick up residual queued sends on next start)`,
        );
      }
    }
    // Tear down any pooled wire-protocol overlays before libp2p
    // stops so per-peer streams close gracefully rather than via
    // libp2p teardown (which would surface as recoverable resets
    // and trigger spurious outbox retries on the very last cycle).
    try {
      await this.router.closePooling();
    } catch {
      // best-effort; libp2p teardown below will close residual streams
    }
    await this.node.stop();
    if (this.syncVerifyWorker) {
      await this.syncVerifyWorker.close();
      this.syncVerifyWorker = undefined;
    }
    // Flush WM to disk before exit so the debounced 50ms flush in the
    // Oxigraph adapter can't lose the latest inserts when the process
    // exits. See docs/bugs/wm-persistence-regression.md.
    //
    // `store.close()` now THROWS on durable-write failures (ENOSPC,
    // EACCES, EROFS, etc.) — see oxigraph.ts. We log loudly but do not
    // re-throw because shutdown is unwinding other state too; surfacing
    // the failure to the operator (via stderr + ideally the exit code)
    // is what matters here.
    try {
      await this.store.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[DKGAgent.stop] WM final flush FAILED on shutdown: ${(err as Error).message}. ` +
          `The store on disk may be missing recent inserts — operator should investigate ` +
          `(disk full, permission revoked, filesystem read-only, …). ` +
          `See docs/bugs/wm-persistence-regression.md for the durability contract.`,
      );
    }
    this.started = false;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) return;

    // Insert genesis quads
    const genesisQuads = getGenesisQuads();
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
  }

  /**
   * Create a V10 ACK provider callback for the publisher.
   * Uses ACKCollector to broadcast PublishIntent and collect StorageACKs
   * via direct P2P from connected core nodes. The required number of ACKs
   * is read from chain ParametersStorage.minimumRequiredSignatures().
   */
  createV10ACKProvider(contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    // `isV10Ready()` is the authoritative V10 capability gate. Using it
    // (instead of probing for `createKnowledgeAssets`) keeps
    // `NoChainAdapter` — whose stub methods throw — out of the V10 path.
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    // Require on-chain identity verification to prevent accepting unverified ACKs
    // that would fail on-chain and waste gas. Fall back to legacy path if unavailable.
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    // The H5 prefix requires a numeric chain id AND the deployed KAV10
    // address. Without BOTH, the collector cannot build a digest that
    // matches what core-node ACK handlers sign, so refuse to hand back a
    // provider at all rather than crash on the first publish with
    // `chain.getEvmChainId is not a function`. Mirrors the guard at
    // `packages/cli/src/publisher-runner.ts:createV10ACKProviderForPublisher`.
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      // rc.9 PR-11: ACKCollector now routes through messenger.send
      // Reliable so /dkg/10.0.1/storage-ack gets envelope wrap +
      // sender-side idempotency. ACKCollector's own MAX_RETRIES=3 loop
      // sits on top; queued counts as a per-peer failure that the
      // collector handles via its existing retry-then-skip path.
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const sendResult = await this.messenger.sendReliable(peerId, protocol, data);
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        return sendResult.response;
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        // Prefer peers confirmed as core nodes (advertise StorageACK protocol).
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        // Fallback: return all connected peers during early startup before
        // protocol discovery completes. Since only core nodes register the
        // StorageACK handler, requests to edge nodes fail at protocol
        // negotiation (fast, no error logs on the remote side).
        return connected;
      },
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      // Surface the structured verifier when the chain adapter implements
      // it. Translates a thrown chain-side exception into an explicit
      // `'rpc-error'` reason so the ACKCollector can log infra failures
      // distinctly from definitive key/stake rejections — pre-PR this
      // try/catch swallowed RPC errors as `false`, conflating them.
      verifyIdentityDetailed: typeof this.chain.verifyACKIdentityDetailed === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId);
            } catch {
              return { valid: false, reason: 'rpc-error' as const };
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('publish');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (
      merkleRoot: Uint8Array,
      contextGraphId: string,
      kaCount: number,
      rootEntities: string[],
      publicByteSize: bigint,
      stagingQuads: Uint8Array | undefined,
      epochs: number | undefined,
      tokenAmount: bigint | undefined,
      swmGraphId: string | undefined,
      subGraphName: string | undefined,
      merkleLeafCount: number,
      isEncryptedPayload?: boolean,
      // OT-RFC-38 LU-11 — when present, the publisher's chunked
      // emitter has already AEAD-encrypted + SWM-gossiped per-chunk
      // ciphertexts. The collector routes through V2 ACK with empty
      // stagingQuads and these fields populating PublishIntent.
      chunkedCommitment?: {
        ciphertextChunksRoot: Uint8Array;
        ciphertextChunkCount: number;
      },
    ) => {
      // Fail loud on non-numeric or non-positive CG ids: V10 publish requires
      // a real on-chain context graph and the contract rejects `cgId == 0`
      // with `ZeroContextGraphId`. Reject `<= 0n` (not `=== 0n`) because
      // `BigInt("-1")` returns `-1n` without throwing — a naive zero check
      // would let negative ids through to the evm-adapter pre-tx guard,
      // where ethers' uint256 encoder would throw a cryptic low-level
      // error. Matches the same guard in dkg-publisher, storage-ack-handler,
      // and async publisher-runner so ACK signers, ACK verifiers, and the
      // chain submitter all agree on the legal domain. `contextGraphId`
      // here is the TARGET on-chain id — `swmGraphId` (optional) is the
      // source SWM graph name and is NOT required to be numeric.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (!Number.isInteger(merkleLeafCount) || merkleLeafCount < 1) {
        throw new Error(
          `V10 ACK collection requires a positive integer merkleLeafCount; got ${merkleLeafCount}. ` +
          'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
        );
      }

      // PR3: chain pre-flight reads are split into individual try/catch
      // shells so a failure can be promoted to the typed
      // `RpcPreconditionError` with the specific adapter method that
      // died. Without this discriminator, dzudza-style RPC rate-limits
      // (`-32016 over rate limit` on `eth_chainId`) get logged as the
      // same opaque "V10 ACK collection failed" string as a peer-side
      // QuorumUnmet — operators cannot tell whether to fix their RPC
      // config or their network topology.
      let requiredACKs: number | undefined;
      if (typeof chain.getMinimumRequiredSignatures === 'function') {
        try {
          requiredACKs = await chain.getMinimumRequiredSignatures();
        } catch (err) {
          throw wrapAsRpcPreconditionIfApplicable(err, 'getMinimumRequiredSignatures');
        }
      }

      // H5 prefix inputs — both come from the chain adapter so that
      // publisher-side digest construction matches what core-node handlers
      // produced on their side. These are required for any V10 path; the
      // adapter must implement them.
      let chainIdBig: bigint;
      try {
        chainIdBig = await chain.getEvmChainId();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getEvmChainId');
      }
      let kav10Address: string;
      try {
        kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getKnowledgeAssetsLifecycleAddress');
      }

      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize,
        isPrivate: isEncryptedPayload === true,
        kaCount,
        rootEntities,
        chainId: chainIdBig,
        kav10Address,
        requiredACKs,
        stagingQuads,
        epochs,
        tokenAmount,
        swmGraphId,
        subGraphName,
        merkleLeafCount,
        isEncryptedPayload,
        chunkedCommitment,
      });
      return result.acks;
    };
  }

  async broadcastPublish(contextGraphId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const onChain = result.onChainResult;
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: new TextEncoder().encode(ntriples),
      contextGraphId: contextGraphId,
      kas: result.kaManifest.map(ka => ({
        tokenId: Number(ka.tokenId),
        rootEntity: ka.rootEntity,
        privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
        privateTripleCount: ka.privateTripleCount ?? 0,
      })),
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: onChain?.publisherAddress ?? '',
      startKAId: Number(onChain?.startKAId ?? 0),
      endKAId: Number(onChain?.endKAId ?? 0),
      chainId: this.chain.chainId,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash: onChain?.txHash ?? '',
      blockNumber: onChain?.blockNumber ?? 0,
      operationId: ctx.operationId,
      subGraphName: result.subGraphName,
    });

    const topic = contextGraphPublishTopic(contextGraphId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  get assertion() {
    const agent = this;
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    return {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        return agent.publisher.assertionCreate(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * Write triples to a WM assertion. Accepts:
       * - `Quad[]` — standard quad array (same as publish/share)
       * - `JsonLdContent` — JSON-LD document, auto-converted to quads
       * - `Array<{ subject, predicate, object }>` — simple triple array
       */
      async write(
        contextGraphId: string,
        name: string,
        input: import('@origintrail-official/dkg-storage').Quad[] | JsonLdContent | Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string },
      ): Promise<void> {
        let quads: import('@origintrail-official/dkg-storage').Quad[];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          quads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          const { publicQuads, privateQuads } = await jsonLdToQuads(input as JsonLdContent);
          quads = [...publicQuads, ...privateQuads];
        } else {
          quads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        return agent.publisher.assertionWrite(contextGraphId, name, agentAddress, quads, opts?.subGraphName);
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        return agent.publisher.assertionQuery(contextGraphId, name, agentAddress, opts?.subGraphName);
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string }): Promise<{ promotedCount: number }> {
        // Resolve the gossip signer up-front (mirrors `share()` /
        // `conditionalShare()` patterns) so the publisher can wrap the
        // promoted SWM gossip in the Sender Key encrypted envelope.
        // Without this, private/agent-gated CGs receive plaintext
        // gossip and the new `SharedMemoryHandler` check rejects it.
        const gossipSigner = await agent.resolveWorkspaceGossipSigningAgent(contextGraphId);
        const { promotedCount, gossipMessage } = await agent.publisher.assertionPromote(
          contextGraphId, name, agentAddress,
          {
            ...opts,
            publisherPeerId: agent.node.peerId.toString(),
            senderAgentAddress: gossipSigner?.agentAddress,
          },
        );
        if (gossipMessage) {
          try {
            await agent.publishWorkspaceGossip(contextGraphId, gossipMessage, createOperationContext('share'), gossipSigner);
          } catch (err: any) {
            agent.log.warn(createOperationContext('share'), `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
          }
        }
        return { promotedCount };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        return agent.publisher.assertionDiscard(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * RFC-001 §9.x — finalize a Working Memory assertion.
       *
       * This is the moment the assertion's content is cryptographically
       * committed to a chain target: the daemon computes the canonical
       * merkleRoot from the assertion's quads, builds the EIP-712
       * AuthorAttestation typed data, signs it (or verifies a pre-signed
       * payload), and stamps the result as a block of `_meta` triples
       * keyed by the assertion URI.
       *
       * After finalize, the assertion's content is sealed: subsequent
       * `write` calls would invalidate the seal. The seal travels with
       * the assertion through SWM gossip (because `_meta` propagates by
       * default) and is consumed verbatim by the chain publish path —
       * publish never re-signs or re-hashes.
       *
       * Authorship resolution mirrors `publishFromSharedMemory`:
       *   1. `preSignedAuthorAttestation` wins (self-sovereign agents).
       *   2. `authorAgentAddress` → custodial agent's private key from
       *      the local keystore.
       *   3. Otherwise → throw. The route layer is responsible for
       *      defaulting to the request token's agent (or to the
       *      publisher EOA when an admin token is presented).
       *
       * Idempotent: re-finalizing an already-sealed assertion with the
       * same content returns the existing seal without re-signing. A
       * conflicting re-finalize (different content / author) throws.
       */
      async finalize(
        contextGraphId: string,
        name: string,
        opts?: {
          subGraphName?: string;
          authorAgentAddress?: string;
          preSignedAuthorAttestation?: PreSignedAuthorAttestation;
          schemeVersion?: number;
        },
      ): Promise<{
        assertionUri: string;
        merkleRoot: Uint8Array;
        authorAddress: string;
        schemeVersion: number;
        chainId: bigint;
        kav10Address: string;
        eip712Digest: string;
      }> {
        return agent.assertionFinalize(contextGraphId, name, agentAddress, opts);
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const lifecycleUri = assertionLifecycleUri(contextGraphId, addr, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Query assertion entity (current state + layer)
        const entityResult = await agent.store.query(
          `SELECT ?state ?memoryLayer ?assertionGraph WHERE {
            GRAPH <${metaGraph}> {
              <${lifecycleUri}> <${DKG_NS}state> ?state .
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
            }
          } LIMIT 1`,
        );
        if (entityResult.type !== 'bindings' || entityResult.bindings.length === 0) return null;

        const row = entityResult.bindings[0];
        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const graphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?kcUal ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              ?event <${DKG_NS}fromLayer> ?fromLayer .
              ?event <${DKG_NS}toLayer> ?toLayer .
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}kcUal> ?kcUal }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? '',
                toLayer: strip(b['toLayer']) ?? '',
                shareOperationId: strip(b['shareOpId']),
                kcUal: strip(b['kcUal']),
                rootEntities: b['rootEntity'] ? [b['rootEntity']] : undefined,
              });
            } else if (b['rootEntity']) {
              const existing = eventMap.get(eventUri)!;
              if (!existing.rootEntities) existing.rootEntities = [];
              if (!existing.rootEntities.includes(b['rootEntity'])) {
                existing.rootEntities.push(b['rootEntity']);
              }
            }
          }
        }

        return {
          contextGraphId,
          agentAddress: addr,
          name,
          state: stateStr,
          memoryLayer: (layerStr as MemoryLayer) ?? null,
          assertionGraph: graphUri,
          events: [...eventMap.values()],
        };
      },

      // ── Async promote (RFC: docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md) ──
      //
      // These five methods are thin pass-throughs to the queue. The
      // worker that actually drains the queue lives in the daemon (PR
      // #3); on this surface we only enqueue, inspect, cancel, and
      // recover. No memoryGraphChanged event is emitted at enqueue time
      // — emission happens when the worker reports success.
      async promoteAsync(
        contextGraphId: string,
        name: string,
        opts?: { entities?: readonly string[] | 'all'; subGraphName?: string },
      ): Promise<{ jobId: string }> {
        const jobId = await agent.promoteQueue.enqueue({
          contextGraphId,
          assertionName: name,
          subGraphName: opts?.subGraphName,
          entities: opts?.entities ?? 'all',
        });
        return { jobId };
      },
      async getPromoteAsyncStatus(jobId: string): Promise<PromoteJob | null> {
        return agent.promoteQueue.getStatus(jobId);
      },
      async listPromoteAsyncJobs(filter?: PromoteListFilter): Promise<PromoteJob[]> {
        return agent.promoteQueue.list(filter);
      },
      async cancelPromoteAsync(jobId: string): Promise<void> {
        return agent.promoteQueue.cancel(jobId);
      },
      async recoverPromoteAsync(jobId: string): Promise<void> {
        return agent.promoteQueue.recover(jobId);
      },
    };
  }

  /**
   * Lazily-constructed async-promote queue. First access materialises
   * the `TripleStoreAsyncPromoteQueue` against `this.store`; subsequent
   * accesses return the same instance. The queue's control graph
   * (`urn:dkg:promote-queue:control-plane`) lives in the same triple
   * store as everything else, so it survives daemon restarts.
   *
   * Exposed publicly so PR #3's worker loop can drive the worker-side
   * surface (`claimNext` / `heartbeat` / `succeed` / `fail` /
   * `recordCommitMarker` / `recoverOnStartup`) without the assertion
   * subsurface having to leak those methods to user-facing callers.
   */
  get promoteQueue(): AsyncPromoteQueue {
    if (!this._promoteQueue) {
      this._promoteQueue = new TripleStoreAsyncPromoteQueue(this.store, this._promoteQueueConfig ?? {});
    }
    return this._promoteQueue;
  }

  /**
   * Override the promote-queue config (e.g. inject deterministic
   * `now`/`idGenerator` for tests, or tune `maxRetries`/`leaseMs` from
   * daemon config). Must be called BEFORE the first `promoteQueue`
   * access; throws otherwise so the override doesn't silently no-op.
   */
  configurePromoteQueue(config: Partial<AsyncPromoteQueueConfig>): void {
    if (this._promoteQueue) {
      throw new Error('configurePromoteQueue must be called before the queue is first accessed');
    }
    this._promoteQueueConfig = config;
  }

}


export interface DKGAgent extends ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods {}
applyMixins(DKGAgent, [ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods]);
