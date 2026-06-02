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

  async query(
    sparql: string,
    options?: string | {
      contextGraphId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      /** @deprecated Use includeSharedMemory */
      includeWorkspace?: boolean;
      /**
       * Opt-in for dashboard/count queries that intentionally enumerate all
       * registered public content partitions in a scoped `GRAPH ?g` scan.
       */
      includeContextGraphPartitions?: boolean;
      /**
       * Opt-in: allow the scoped query to reference the context graph's own
       * `_private` partition (excluded from the scope guard's allow-set by
       * default). Used by the EPCIS events query, whose SPARQL always names
       * `<cg>/_private`. Does not widen access for other callers.
       */
      includePrivate?: boolean;
      operationCtx?: OperationContext;
      view?: GetView;
      agentAddress?: string;
      verifiedGraph?: string;
      assertionName?: string;
      subGraphName?: string;
      /**
       * EVM address of the authenticated caller, as resolved by an
       * outer layer (typically the daemon's per-request auth token).
       * When set, the agent layer enforces that `view: 'working-memory'`
       * queries can only read this caller's own WM — cross-agent reads
       * via a foreign `agentAddress` are silently denied.
       *
       * Undefined = no caller authentication context (in-process call
       * from trusted code). Backwards-compatible with callers that
       * predate A-1 — they bypass the isolation check.
       *
       * Invariant: on a `view: 'working-memory'` read, the agent layer
       * rejects (silently, with an empty-per-kind result) any
       * `agentAddress` that differs from `callerAgentAddress`. If
       * `agentAddress` is omitted, it defaults to `callerAgentAddress`
       * so an authenticated caller cannot escape isolation by omission.
       * See spec §04 / RFC-29 for the policy source.
       */
      callerAgentAddress?: string;
      /**
       * Minimum trust level for the verified-memory view (spec §14).
       * Values above `SelfAttested` require explicit writer-side
       * `dkg:trustLevel` metadata. Ignored for other views.
       */
      minTrust?: TrustLevel;
      /**
       * @deprecated Use `minTrust`. Legacy underscore alias preserved for
       * V10-rc SDK consumers. When both are supplied, `minTrust` wins.
       * See QueryOptions._minTrust for the deprecation policy.
       */
      _minTrust?: TrustLevel;
    },
  ) {
    const rawOpts = typeof options === 'string' ? { contextGraphId: options } : options ?? {};
    const opts = {
      ...rawOpts,
      contextGraphId: rawOpts.contextGraphId,
      includeSharedMemory: rawOpts.includeSharedMemory ?? rawOpts.includeWorkspace,
    };
    const ctx = opts.operationCtx ?? createOperationContext('query');
    const sgLabel = opts.subGraphName ? `/${opts.subGraphName}` : '';
    const viewLabel = opts.view ? ` view=${opts.view}` : '';
    this.log.info(ctx, `Query on contextGraph="${opts.contextGraphId ?? 'all'}"${sgLabel}${viewLabel} sparql="${sparql.slice(0, 80)}"`);

    // Validate the SPARQL query is read-only BEFORE any access-denied
    // fast-path. `DKGQueryEngine.query` runs this guard too, but the
    // three early returns below (canReadContextGraph deny, WM
    // isolation deny, private-CG deny) short-circuit before reaching
    // it. Without this check, a caller can send `INSERT DATA { ... }`
    // through a cross-agent WM request and get a 200 empty result
    // instead of the 400 rejection that plain queries receive —
    // effectively silently swallowing a mutation attempt. Run it
    // once here so the deny path and the engine path share the same
    // input contract.
    const readOnlyGuard = validateReadOnlySparql(sparql);
    if (!readOnlyGuard.safe) {
      throw new Error(`SPARQL rejected: ${readOnlyGuard.reason}`);
    }

    const targetsSharedMemory =
      opts.graphSuffix === '_shared_memory'
      || opts.includeSharedMemory === true
      || opts.view === 'shared-working-memory';

    // A-1: Working-Memory isolation. When the caller is authenticated
    // (an outer layer like the daemon's `/api/query` route has resolved
    // the request to a specific agent and passed `callerAgentAddress`),
    // a WM query must not be allowed to read a different agent's
    // private memory. Cross-agent WM reads are silently denied (empty
    // bindings) rather than thrown — that matches the spec-safe
    // "deny without leaking existence" semantics used elsewhere in
    // this file for private context graphs.
    //
    // When `callerAgentAddress` is undefined we assume a trusted
    // in-process caller (e.g. ChatMemoryManager running inside the
    // daemon process) and leave the legacy behaviour intact. Those
    // call sites are tracked as follow-up A-1.2 for migration to an
    // authenticated scoped handle.
    // A-1 review: `/api/query` passes the raw JSON body through, so
    // `agentAddress` / `callerAgentAddress` can arrive as any JSON type
    // (number, array, object, null). Before this guard `.toLowerCase()`
    // would throw and the daemon turned a bad request into a 500.
    //
    // A-1 follow-up review: simply coercing non-strings to `undefined`
    // meant malformed input like `{ view: 'working-memory',
    // agentAddress: 123 }` silently fell through to the
    // `this.peerId` fallback below — so a caller could land in the
    // node-default WM namespace and get a 200 with real data.
    // Reject non-string `agentAddress` / `callerAgentAddress` up
    // front and let the daemon classify the resulting error as 400.
    if (opts.agentAddress !== undefined && typeof opts.agentAddress !== 'string') {
      throw new Error(
        `query: 'agentAddress' must be a string, got ${typeof opts.agentAddress}`,
      );
    }
    if (opts.callerAgentAddress !== undefined && typeof opts.callerAgentAddress !== 'string') {
      throw new Error(
        `query: 'callerAgentAddress' must be a string, got ${typeof opts.callerAgentAddress}`,
      );
    }
    const callerAgentAddressStr = opts.callerAgentAddress;

    if (
      opts.contextGraphId
      && targetsSharedMemory
      && !(await this.canUseSharedMemoryForContextGraph(opts.contextGraphId, {
        callerAgentAddress: callerAgentAddressStr,
      }))
    ) {
      this.log.info(ctx, `Shared memory query denied for unauthorized or unconfirmed context graph "${opts.contextGraphId}"`);
      return emptyQueryResultForKind(sparql);
    }

    if (opts.contextGraphId && !(await this.canReadContextGraph(opts.contextGraphId, {
      callerAgentAddress: callerAgentAddressStr,
    }))) {
      this.log.info(ctx, `Query denied for private context graph "${opts.contextGraphId}"`);
      // A-1 follow-up review: synthetic deny must match the SPARQL form
      // so ASK / CONSTRUCT / DESCRIBE clients get `false` / empty-quads
      // instead of a SELECT-shaped `{ bindings: [] }`.
      return emptyQueryResultForKind(sparql);
    }

    // A-1 canonicalization (Codex PR #242 iter-9 re-review): the
    // node's default agent has TWO identifiers that key the same WM
    // namespace — its EVM address (`this.defaultAgentAddress`) and
    // the legacy `this.peerId`. In-repo WM callers / docs still use
    // `peerId` as `agentAddress` (e.g. `ChatMemoryManager`,
    // `packages/cli/skills/dkg-node/SKILL.md`), and the engine
    // stores WM under
    // `did:dkg:context-graph:<cg>/assertion/<agentAddress>/`, so EVM
    // and peerId hash to DIFFERENT graphs. If the isolation check
    // compared raw strings, an agent-scoped token with
    // `callerAgentAddress=<defaultAgent.evm>` querying its own WM
    // with `agentAddress=<peerId>` (or the reverse) would get a
    // silent empty deny even though both sides are the same
    // identity. Canonicalize both sides: when the default agent is
    // known, fold its `peerId` alias onto its EVM address.
    const defaultEvmLc = this.defaultAgentAddress?.toLowerCase();
    const peerIdLc = this.peerId?.toLowerCase();
    const canonicaliseWmId = (addr: string | undefined): string | undefined => {
      if (!addr) return undefined;
      const lc = addr.toLowerCase();
      if (peerIdLc && lc === peerIdLc && defaultEvmLc) return defaultEvmLc;
      return lc;
    };

    // An authenticated (agent-bound) /api/query call could previously
    // OMIT `agentAddress` and fall through to the `this.peerId`
    // fallback at the engine call below, reading the node-default WM
    // namespace instead of the caller's own. Default an omitted
    // `agentAddress` to `callerAgentAddress` on working-memory reads
    // so an agent-bound caller cannot escape its own WM by just not
    // supplying the field.
    //
    // Legacy preservation (Codex iter-9 re-review): if the caller is
    // the node default agent, default to `this.peerId` instead of
    // the EVM address. Pre-existing WM data for the default agent
    // lives under the peerId-keyed namespace; defaulting to the EVM
    // form would strand that data. The isolation check below is
    // alias-aware (`canonicaliseWmId`), so both forms resolve to the
    // same canonical identity and still pass the caller===target
    // invariant.
    const callerIsDefaultAgent =
      !!callerAgentAddressStr
      && !!defaultEvmLc
      && callerAgentAddressStr.toLowerCase() === defaultEvmLc;
    const agentAddressStr =
      opts.agentAddress
      ?? (opts.view === 'working-memory' && callerAgentAddressStr
        ? (callerIsDefaultAgent && this.peerId ? this.peerId : callerAgentAddressStr)
        : undefined);
    if (
      opts.view === 'working-memory' &&
      callerAgentAddressStr &&
      agentAddressStr &&
      canonicaliseWmId(callerAgentAddressStr) !== canonicaliseWmId(agentAddressStr)
    ) {
      this.log.info(
        ctx,
        `WM query denied: caller=${callerAgentAddressStr} cannot read agentAddress=${agentAddressStr} — A-1 isolation`,
      );
      // A-1 follow-up review: preserve the SPARQL query-form shape on
      // denial so ASK clients see `{ bindings: [{ result: 'false' }] }`
      // and CONSTRUCT / DESCRIBE clients see `{ bindings: [], quads: [] }`.
      // Returning a SELECT-shaped `{ bindings: [] }` on every form leaks
      // the fact that access was denied (versus an empty match) via the
      // changed response shape.
      return emptyQueryResultForKind(sparql);
    }

    // When no context graph is specified, exclude private CGs the caller cannot
    // read to prevent data leakage via unscoped or FROM-less SPARQL.
    let excludeGraphPrefixes: string[] | undefined;
    if (!opts.contextGraphId) {
      excludeGraphPrefixes = await this.getDisallowedGraphPrefixes({
        callerAgentAddress: callerAgentAddressStr,
      });
      // Per spec Axiom 1 every shared query must be resolved within a CG.
      // Reject explicit GRAPH/FROM clauses that reference private CGs the
      // caller cannot read — post-filtering alone cannot prevent leaks via
      // aggregates (ASK, COUNT) or projections that omit graph/subject.
      if (excludeGraphPrefixes.length > 0 && this.sparqlReferencesPrivateGraphs(sparql, excludeGraphPrefixes)) {
        this.log.info(ctx, 'Query denied: SPARQL references private context graphs the caller cannot read');
        return emptyQueryResultForKind(sparql);
      }
    }

    const result = await this.queryEngine.query(sparql, {
      contextGraphId: opts.contextGraphId,
      excludeGraphPrefixes,
      graphSuffix: opts.graphSuffix,
      includeSharedMemory: opts.includeSharedMemory,
      includeContextGraphPartitions: opts.includeContextGraphPartitions,
      includePrivate: opts.includePrivate,
      view: opts.view,
      agentAddress: agentAddressStr ?? (opts.view === 'working-memory' ? this.peerId : undefined),
      verifiedGraph: opts.verifiedGraph,
      assertionName: opts.assertionName,
      subGraphName: opts.subGraphName,
      // PR #239 Codex iter-5: fall back to the deprecated underscore alias
      // here (and only here — we do not propagate both fields further) so
      // callers on the legacy shape still get the trust gate without
      // engines needing to know about both names.
      minTrust: opts.minTrust ?? opts._minTrust,
    });
    this.log.info(ctx, `Query returned ${result.bindings?.length ?? 0} bindings`);
    return result;
  }

  private isAgentAddressAllowed(agentAddress: string | undefined, agentGateAddresses: readonly string[]): boolean {
    if (!agentAddress) return false;
    const normalized = agentAddress.toLowerCase();
    return agentGateAddresses.some((agent) => agent.toLowerCase() === normalized);
  }

  public async canReadContextGraph(
    contextGraphId: string,
    opts: {
      callerAgentAddress?: string;
      allowSubscriptionFallback?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!(await this.isPrivateContextGraph(contextGraphId))) {
      return true;
    }

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(contextGraphId);
    const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);

    // Mixed legacy peer-id and V10 agent gates are conjunctive: a node must
    // be invited by peer id and also hold a local allowed agent identity.
    const agentGateAllowed = agentGateAddresses === null
      ? false
      : opts.callerAgentAddress
        ? this.isAgentAddressAllowed(opts.callerAgentAddress, agentGateAddresses)
        : this.hasLocalAgentInGate(agentGateAddresses);

    if (agentGateAddresses !== null && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId) && agentGateAllowed;
    }

    if (agentGateAddresses !== null) {
      return agentGateAllowed;
    }

    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);

    if ((!participants || participants.length === 0) && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId);
    }

    // No participant or peer list at all. Durable CG reads preserve the legacy
    // subscribed-node fallback, but SWM must fail closed here because SWM
    // GossipSub carries plaintext bytes.
    if (!participants || participants.length === 0) {
      if (opts.allowSubscriptionFallback === false) {
        return false;
      }
      return this.subscribedContextGraphs.has(contextGraphId)
        || (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    }

    if (
      opts.callerAgentAddress
      && participants.some((p) => p.toLowerCase() === opts.callerAgentAddress!.toLowerCase())
    ) {
      return true;
    }

    // Check if any local agent address is in the participants list
    const myAgentAddress = this.defaultAgentAddress;
    if (myAgentAddress && participants.some((p) => p.toLowerCase() === myAgentAddress.toLowerCase())) {
      return true;
    }

    // Check if the local identity ID is in the participants list
    let myIdentityId = 0n;
    try {
      myIdentityId = await this.chain.getIdentityId();
      if (myIdentityId > 0n && participants.includes(String(myIdentityId))) {
        return true;
      }
    } catch { /* identity lookup failed — continue to deny */ }

    // Legacy peer-ID allowlist: `inviteToContextGraph` writes `DKG_ALLOWED_PEER`
    // quads. Honor them for local reads so a peer-ID-invited node can query
    // the data it just synced.
    if (allowedPeers?.includes(this.peerId)) {
      return true;
    }

    // Edge nodes without an on-chain identity (identityId 0n) fall back to
    // subscription-based access — the subscription itself is an authorization
    // (the node was invited or created this CG).
    if (myIdentityId === 0n && opts.allowSubscriptionFallback !== false) {
      return this.subscribedContextGraphs.has(contextGraphId);
    }

    return false;
  }

  /**
   * Returns graph URI prefixes for private CGs the caller cannot read.
   * Used to exclude them from unscoped queries.
   */
  private async getDisallowedGraphPrefixes(opts: { callerAgentAddress?: string } = {}): Promise<string[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const result = await this.store.query(
      `SELECT ?cg WHERE {
        GRAPH <${ontologyGraph}> {
          ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];

    const prefixes: string[] = [];
    for (const row of result.bindings) {
      const cgUri = row['cg'];
      if (!cgUri) continue;
      // cgUri is like "did:dkg:context-graph:some-id" — extract the ID
      const match = cgUri.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
      if (!match) continue;
      const contextGraphId = match[1];
      if (await this.canReadContextGraph(contextGraphId, {
        callerAgentAddress: opts.callerAgentAddress,
      })) continue;
      // Exclude all named graphs under this CG (data, _meta, _shared_memory, etc.)
      prefixes.push(`did:dkg:context-graph:${contextGraphId}`);
    }
    return prefixes;
  }

  private sparqlReferencesPrivateGraphs(sparql: string, disallowedPrefixes: string[]): boolean {
    if (disallowedPrefixes.length === 0) return false;
    const upper = sparql.toUpperCase();
    if (!upper.includes('GRAPH') && !upper.includes('FROM')) return false;
    return disallowedPrefixes.some(prefix => sparql.includes(prefix));
  }

  /**
   * Send a cross-agent query to a remote peer via the /dkg/query/2.0.0 protocol.
   */
  async queryRemote(
    peerId: string,
    request: Omit<QueryRequest, 'operationId'>,
  ): Promise<QueryResponse> {
    const ctx = createOperationContext('query');
    const operationId = crypto.randomUUID();
    const fullRequest: QueryRequest = { ...request, operationId };

    this.log.info(ctx, `Remote query to ${peerId.slice(-8)} type=${request.lookupType}`);

    const payload = new TextEncoder().encode(JSON.stringify(fullRequest));
    // rc.9 PR-9: route through messenger.sendReliable so the query
    // gains sender-side idempotency + receiver-side dedup. SPARQL is
    // idempotent at the app layer so on RESPONSE_GONE (duplicate-
    // receive on a too-big-to-cache response) we transparently re-
    // issue with a fresh messageId — the substrate makes this safe.
    // queued returns are surfaced as a transport error: queryRemote
    // is synchronous-by-design (callers await results), not a fire-
    // and-forget enqueue.
    const responseBytes = await this.sendQueryReliable(peerId, payload);
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as QueryResponse;

    this.log.info(ctx, `Remote query response: status=${response.status} resultCount=${response.resultCount}`);
    return response;
  }

  /**
   * Send a query-remote payload via the Messenger substrate with
   * built-in RESPONSE_GONE retry. SPARQL queries are app-layer
   * idempotent — if the substrate replies with the RESPONSE_GONE
   * sentinel (the original response was too big to inline-cache and
   * we got a duplicate-receive), we re-issue with a fresh messageId
   * and try again. Capped at 2 attempts so a peer that always blows
   * the 256 KiB response cache surfaces as a hard error to the
   * caller instead of looping forever.
   *
   * rc.9 PR-9.
   */
  private async sendQueryReliable(
    peerId: string,
    payload: Uint8Array,
  ): Promise<Uint8Array> {
    const RESPONSE_GONE = 'RESPONSE_GONE';
    const MAX_ATTEMPTS = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const sendResult = await this.messenger.sendReliable(
        peerId,
        PROTOCOL_QUERY_REMOTE,
        payload,
      );
      if (!sendResult.delivered) {
        throw new Error(
          `query-remote send not synchronously deliverable (queued): ${sendResult.error}`,
        );
      }
      const respText = new TextDecoder().decode(sendResult.response);
      if (respText === RESPONSE_GONE) {
        // Original response was mark-only; re-issue with a fresh
        // messageId next loop iteration (sendReliable mints one
        // when opts.messageId is absent).
        lastErr = new Error('RESPONSE_GONE: original response too large to cache; retrying with fresh messageId');
        continue;
      }
      return sendResult.response;
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('query-remote exhausted RESPONSE_GONE retries');
  }

  /**
   * Look up a specific knowledge asset on a remote peer by UAL.
   */
  async lookupEntity(peerId: string, ual: string): Promise<QueryResponse> {
    return this.queryRemote(peerId, { lookupType: 'ENTITY_BY_UAL', ual });
  }

  /**
   * Find entities of a given RDF type on a remote peer's context graph.
   */
  async findEntitiesByType(
    peerId: string,
    contextGraphId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      contextGraphId: contextGraphId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's context graph.
   */
  async getEntityTriples(
    peerId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      contextGraphId: contextGraphId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(
    peerId: string,
    contextGraphId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      contextGraphId: contextGraphId,
      sparql,
      limit,
      timeout,
    });
  }

  subscribeToContextGraph(contextGraphId: string, options?: { trackSyncScope?: boolean; persist?: boolean; deferSharedMemoryGossipSubscribe?: boolean }): void {
    if (options?.trackSyncScope !== false) {
      this.trackSyncContextGraph(contextGraphId);
    }

    // SWM gossip subscribe runs `canReadContextGraph` against the local
    // `_meta` graph. On a fresh `join-approved` notification the curator
    // has just written the allowlist into ITS _meta, but the requesting
    // node hasn't synced that allowlist yet — so the very first SWM
    // gossip subscribe attempt fails with `local node is not authorized`,
    // emitting a misleading WARN. The real fix is to land the allowlist
    // first via `runImmediatePostApprovalSync`; once `_meta` syncs,
    // `refreshMetaSyncedFlags` re-queues the SWM gossip subscribe (line
    // 3738) and it succeeds silently. This option lets the join-approved
    // path opt out of the immediate SWM subscribe and rely on that
    // self-heal — see urn:dkg:finding:swm-gap-1-initial-sync-race.
    const deferSwmGossip = options?.deferSharedMemoryGossipSubscribe === true;

    // Idempotent: skip if gossip handlers already installed for this context graph.
    if (this.gossipRegistered.has(contextGraphId)) {
      if (!deferSwmGossip) {
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
      const existing = this.subscribedContextGraphs.get(contextGraphId);
      if (!existing?.subscribed) {
        this.setContextGraphSubscription(
          contextGraphId,
          { ...existing, subscribed: true, synced: existing?.synced ?? false },
          { persist: options?.persist },
        );
      }
      return;
    }
    this.gossipRegistered.add(contextGraphId);

    const publishTopic = contextGraphPublishTopic(contextGraphId);
    const appTopic = contextGraphAppTopic(contextGraphId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(appTopic);

    const existing = this.subscribedContextGraphs.get(contextGraphId);
    this.setContextGraphSubscription(
      contextGraphId,
      { ...existing, subscribed: true, synced: existing?.synced ?? false },
      { persist: options?.persist },
    );

    this.gossip.onMessage(publishTopic, async (_topic, data, from) => {
      const gph = this.getOrCreateGossipPublishHandler();
      await gph.handlePublishMessage(data, contextGraphId, undefined, from);
    });

    if (!deferSwmGossip) {
      this.queueSharedMemoryGossipSubscription(contextGraphId);
    }

    const updateTopic = contextGraphUpdateTopic(contextGraphId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const uh = this.getOrCreateUpdateHandler();
      await uh.handle(data, from);
    });

    const finalizationTopic = contextGraphFinalizationTopic(contextGraphId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data) => {
      const fh = this.getOrCreateFinalizationHandler();
      await fh.handleFinalizationMessage(data, contextGraphId);
    });
  }

  /**
   * Inverse of {@link subscribeToContextGraph}: drop the LIVE member
   * subscription (publish / app / update / finalization + member-mode SWM
   * gossip, and the sync scope) while preserving any `coreHosted` hosting
   * obligation. After this the node no longer receives the finalization
   * gossip fast-path, so a publish it misses can ONLY be recovered through
   * the chain-driven `coreHosted` reconcile sweep — which is exactly the
   * Phase D path. The persisted subscription row survives iff `coreHosted`
   * (see {@link persistContextGraphSubscription}), so the host-only state
   * (`subscribed=0, coreHosted=1`) is restart-safe.
   *
   * This is intentionally NOT a destructive teardown: it deletes no VM/SWM
   * data and leaves SWM host-mode hosting intact (re-evaluated below). Its
   * primary use is to manufacture a pure host-only core for validation on a
   * devnet where storage cores otherwise auto-subscribe to everything they
   * host, masking the host-only fill path.
   */
  unsubscribeFromContextGraph(contextGraphId: string): void {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    if (!existing) return;

    // Drop from the active sync scope so background sweeps no longer treat
    // this as a subscribed CG to keep current.
    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.delete(contextGraphId)) {
      this.config.syncContextGraphs = [...syncSet];
    }

    // Tear down the per-CG gossip topics. These four carry only the member
    // handlers installed by `subscribeToContextGraph`, so a topic-wide
    // `unsubscribe` is safe here (unlike the SWM topic, handled separately).
    if (this.gossipRegistered.has(contextGraphId)) {
      for (const topic of [
        contextGraphPublishTopic(contextGraphId),
        contextGraphAppTopic(contextGraphId),
        contextGraphUpdateTopic(contextGraphId),
        contextGraphFinalizationTopic(contextGraphId),
      ]) {
        try { this.gossip.unsubscribe(topic); } catch { /* best-effort */ }
      }
      this.gossipRegistered.delete(contextGraphId);
    }

    // Tear down member-mode SWM gossip. `gossip.unsubscribe` drops every
    // handler on the topic (incl. any host-mode listener), so we clear the
    // host-mode bookkeeping too and then let `reconcileSwmHostModeSubscription`
    // re-wire the host listener if hosting is still applicable (no-op on edges
    // and on cores with swmHostMode disabled).
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      try { this.gossip.unsubscribe(swmTopic); } catch { /* best-effort */ }
      this.sharedMemoryGossipRegistered.delete(contextGraphId);
      const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
      this.swmHostModeSubscribed.delete(hostKey);
      this.swmHostModeHandlers.delete(hostKey);
      this.enqueueHostModePersistence(contextGraphId, false);
    }

    // Flip the live-subscription flag off, keeping `coreHosted` (and every
    // other field) intact. Persisted: the row is kept iff `coreHosted`.
    this.setContextGraphSubscription(
      contextGraphId,
      { ...existing, subscribed: false },
      { persist: true },
    );

    void this.reconcileSwmHostModeSubscription(contextGraphId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `SWM host-mode re-eval after unsubscribe from "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.log.info(
      createOperationContext('system'),
      `Unsubscribed from "${contextGraphId}" (coreHosted=${existing.coreHosted === true}); live gossip dropped, chain reconcile path retained if hosting`,
    );
  }

  queueSharedMemoryGossipSubscription(contextGraphId: string): void {
    void this.reconcileSharedMemoryGossipSubscription(contextGraphId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `SWM gossip subscription check failed for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async reconcileSharedMemoryGossipSubscription(contextGraphId: string): Promise<void> {
    // OT-RFC-38 / LU-6 Phase B — subscribe on the wire-form (hash) topic.
    // Members compute the hash from their local cleartext id via
    // {@link gossipWireIdFor}; cores hosting CGs they never joined
    // already have the hash AS their local id (chain-event auto-
    // subscribe / discovery-beacon path), so `gossipWireIdFor` is the
    // identity for them.
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    const isRegistered = this.sharedMemoryGossipRegistered.has(contextGraphId);
    const ctx = createOperationContext('system');
    if (!(await this.canUseSharedMemoryForContextGraph(contextGraphId))) {
      if (isRegistered) {
        // `gossip.unsubscribe()` drops EVERY handler on the topic,
        // not just the member-mode one. If this core was already
        // hosting the curated SWM in HOST MODE (LU-6), losing
        // member authorisation here would also kill the host
        // listener, and `swmHostModeSubscribed` would still be set
        // — making `reconcileSwmHostModeSubscription()` early-
        // return on the next pass and stranding the hosting state
        // until restart (Codex PR #610 R1 comment 4).
        //
        // We work around the topic-wide unsubscribe by clearing
        // host-mode bookkeeping (handler ref + subscribed flag)
        // here so the immediate `reconcileSwmHostModeSubscription()`
        // call below will re-wire the host listener if host mode
        // is still applicable.
        //
        // Codex PR #620 follow-up: the in-memory deletes above are
        // not enough — the persisted `hostModeSubscribed=true` flag
        // would survive restart and the B3 startup-restore loop
        // (`initializeSwmHostModeStore`) would re-subscribe a CG
        // this node has just been told it's no longer authorized
        // for. Enqueue a persistence=false write here so the
        // `.meta` reflects the same teardown as the in-memory
        // maps. If the immediate `reconcileSwmHostModeSubscription`
        // below decides host mode IS still applicable, it'll
        // re-engage via `wireSwmHostModeHandler` → enqueue
        // persistence=true again. The per-CG queue
        // (`enqueueHostModePersistence`) serialises the pair so the
        // final on-disk state always matches the final in-memory
        // intent — no possible interleave where the "false" lands
        // after a later "true" and re-subscribes on next boot.
        this.gossip.unsubscribe(swmTopic);
        this.sharedMemoryGossipRegistered.delete(contextGraphId);
        // Host-mode maps are canonical-keyed (wire-form hash); delete
        // by canonical id so this cleanup hits the entry regardless
        // of which discovery path wired it. Without this, the
        // immediate `reconcileSwmHostModeSubscription()` call below
        // would see a stale entry and early-return.
        const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
        this.swmHostModeSubscribed.delete(hostKey);
        this.swmHostModeHandlers.delete(hostKey);
        this.enqueueHostModePersistence(contextGraphId, false);
        this.log.warn(ctx, `SWM gossip unsubscribed for "${contextGraphId}": local node is no longer authorized`);
      } else {
        this.log.warn(ctx, `SWM gossip subscription denied for "${contextGraphId}": local node is not authorized`);
      }
      // OT-RFC-38 LU-6: even if the local node is not a CG member,
      // a CORE node may still serve as a ciphertext host for the
      // curated SWM substrate. We delegate to the host-mode
      // reconciler — which is a no-op on edges and on cores when
      // the swmHostMode config is disabled.
      await this.reconcileSwmHostModeSubscription(contextGraphId);
      return;
    }

    if (isRegistered) return;

    // Codex PR #610 R3: if this core was previously hosting the
    // curated SWM in HOST MODE, member authorization now takes
    // over — apply-and-ack via the member handler replaces opaque
    // hosting. Surgically remove the host-mode handler (without
    // dropping every handler on the topic) so we don't double-
    // process every envelope (apply + opaque append).
    this.unwireSwmHostModeHandler(contextGraphId);

    this.sharedMemoryGossipRegistered.add(contextGraphId);
    this.gossip.subscribe(swmTopic);
    this.gossip.onMessage(swmTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateSharedMemoryHandler();
      const outcome = await wh.handle(data, from);
      // Emit SwmShareAck on gossip-applied shares so the
      // publisher's SwmAckQuorum can compute per-share delivery
      // quorum. PR-H bug 2 made this symmetric — `handleSwmUpdate`
      // emits one too on substrate-applied shares — so the
      // quorum sees the same ack signal regardless of which
      // transport delivered. A peer reachable via BOTH
      // transports may produce two acks (substrate bookkeeper
      // + this receiver ack); that's fine — `SwmAckQuorum.onAck`
      // dedups via `record.acked.has(fromPeerId)`.
      //
      // Best-effort throughout: missing metadata fields, failed
      // sendReliable, throws — all swallowed. The publisher's
      // watchdog will fire substrate top-up if the ack count
      // doesn't reach quorum, which makes the ack channel an
      // opportunistic fast-path rather than a correctness
      // requirement.
      if (!outcome.applied) return;
      this.maybeEmitSwmShareAck(outcome).catch(() => { /* swallowed; logged inside */ });
    });
  }

  /**
   * Receiver handler for `PROTOCOL_SWM_SHARE_ACK`. Extracted into
   * a named method (mirrors `handleSwmUpdate`'s shape) so the
   * spoof-rejection contract from PR-D codex follow-up #D2 can
   * be unit-tested in isolation without spinning up a real
   * Messenger registration. Always returns `new Uint8Array()`
   * at the wire level — senders don't read the response (acks
   * use fire-and-forget `sendToPeer` per #D1).
   */
  public async handleSwmShareAck(data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    try {
      const ack = decodeSwmShareAck(data);
      // rc.9 PR-D codex follow-up #D2: authoritative ack identity
      // is the libp2p-authenticated `fromPeerId`, NOT the
      // self-asserted `ack.ackPeerId` in the protobuf body.
      // Pre-D2 we trusted the body, which let any peer that had
      // learned a `shareOperationId` spoof acks on behalf of
      // other expected members — suppressing watchdog top-up
      // for those members and degrading delivery quorum
      // reliability. The body's `ackPeerId` is kept on the wire
      // for forward-compat with a possible future relayed-ack
      // path (where `fromPeerId` would be a relay node, not the
      // original receiver), but in the current direct-Messenger
      // world we reject any non-empty mismatch as either a
      // misconfiguration or a spoof attempt.
      if (ack.ackPeerId && ack.ackPeerId !== fromPeerId) {
        this.log.warn(
          createOperationContext('share', ack.shareOperationId),
          `SWM share ack body/transport peerId mismatch — body=${ack.ackPeerId} transport=${fromPeerId} — dropping (potential spoof)`,
        );
        return new Uint8Array();
      }
      this.getOrCreateSwmAckQuorum().onAck(ack.shareOperationId, fromPeerId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('share'),
        `SWM share ack decode failed from ${fromPeerId}: ${reason}`,
      );
    }
    return new Uint8Array();
  }

  /**
   * Test-only view onto {@link handleSwmShareAck} for the PR-D
   * codex follow-up #D2 regression. Production traffic invokes
   * the same handler via the `messenger.register()` callback
   * registered in {@link initialize}; tests need the same
   * arrow-function shape without having to intercept the
   * register call (which happens before the test can install
   * its messenger stub). Not part of the public API; method
   * exists purely to make the spoof-rejection contract testable.
   */
  async getOrCreateSwmShareAckHandlerForTests(): Promise<(data: Uint8Array, from: string) => Promise<Uint8Array>> {
    return (data, from) => this.handleSwmShareAck(data, from);
  }

  /**
   * Test-only inspector for SwmAckQuorum's tracked-record
   * snapshot, exposed so integration tests can assert on the
   * `acked` / `expectedMembers` after driving ack arrivals
   * through `handleSwmShareAck`. Returns `undefined` for
   * unknown shareOperationIds (matches the underlying
   * component's `inspect()` contract — once a record completes
   * quorum or expires, it's reaped). Not part of the public
   * API surface; the production caller talks to the quorum
   * directly via `getOrCreateSwmAckQuorum()`.
   */
  getSwmAckQuorumRecordSnapshotForTests(shareOperationId: string): {
    acked: readonly string[];
    expectedMembers: readonly string[];
    ackPct: number;
  } | undefined {
    return this.swmAckQuorum?.inspect(shareOperationId);
  }

  /**
   * Best-effort send of `PROTOCOL_SWM_SHARE_ACK` to the share's
   * publisher peer after a successful gossip-path apply.
   * Extracted into a named method so the receiver contract can
   * be unit-tested in isolation without spinning up a real
   * GossipSub subscription.
   *
   * Self-acks are filtered: if the publisher peerId equals our
   * own (we both published AND happened to receive our own
   * gossip back via the mesh — rare but possible), we skip the
   * send because the publisher-side track() already counts the
   * local apply via the substrate pre-acked set / never enters
   * the watchdog branch.
   */
  public async maybeEmitSwmShareAck(outcome: {
    applied: true;
    cgId?: string;
    shareOperationId?: string;
    publisherPeerId?: string;
  }): Promise<void> {
    const { shareOperationId, publisherPeerId } = outcome;
    if (!shareOperationId || !publisherPeerId) return;
    let selfPeerId: string;
    try {
      selfPeerId = this.peerId;
    } catch {
      return;
    }
    if (publisherPeerId === selfPeerId) return;

    const ackBytes = encodeSwmShareAck({ shareOperationId, ackPeerId: selfPeerId });
    // rc.9 PR-D codex follow-up #D1: use fire-and-forget
    // `sendToPeer` instead of durable `sendReliable`. Pre-D1
    // the ack went through the substrate outbox — but
    // PROTOCOL_SWM_SHARE_ACK is a new rc.9-PR-D-only protocol,
    // and during a rolling upgrade the publisher peer may not
    // have it registered yet. A `sendReliable` to an
    // unsupported protocol enqueues into the outbox and retries
    // forever on protocol negotiation, accumulating a permanent
    // queued row per received share. By contrast `sendToPeer`
    // just delegates to `ProtocolRouter.send`: one network
    // attempt, no envelope, no idempotency cache, no outbox row.
    // On any failure (peer offline, protocol unsupported,
    // stream reset) we WARN and drop — that's the right
    // semantic anyway since acks are pure observability: a
    // missed ack just means the watchdog will eventually fire
    // substrate top-up, which the receiver dedups via
    // `seenShareOps`. Losing an ack is recoverable; persisting
    // a doomed retry forever is not.
    try {
      await this.messenger.sendToPeer(publisherPeerId, PROTOCOL_SWM_SHARE_ACK, ackBytes, {
        timeoutMs: DKGAgent.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('share', shareOperationId),
        `SWM share ack to ${publisherPeerId} failed (best-effort, watchdog will retry the share if quorum slips): ${reason}`,
      );
    }
  }

  /**
   * Add a context graph to runtime sync scope so sync-on-connect includes it.
   * System context graphs are already included by default and are skipped here.
   */
  public trackSyncContextGraph(contextGraphId: string): void {
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
    if (systemContextGraphs.has(contextGraphId)) return;

    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.has(contextGraphId)) return;
    syncSet.add(contextGraphId);
    this.config.syncContextGraphs = [...syncSet];
  }

  private getOrCreateGossipPublishHandler(): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedContextGraphs,
        {
          contextGraphExists: (id) => this.contextGraphExists(id),
          // Gossip validation compares `approvedBy`/`revokedBy` against the
          // contextGraph owner. Those triples are emitted with `dkg:creator` (peer
          // DID) so peers validate against the same creator-scoped DID.
          // `dkg:curator` (wallet DID) is for local authorization only.
          getContextGraphOwner: (id) => this.getContextGraphCreator(id),
          subscribeToContextGraph: (id, options) => this.subscribeToContextGraph(id, options),
          hasConfirmedMetaState: (id) => this.hasConfirmedMetaState(id),
          persistContextGraphSubscription: (id) => this.persistContextGraphSubscriptionState(id),
        },
      );
    }
    return this.gossipPublishHandler;
  }

  getOrCreateSharedMemoryHandler(): InstanceType<typeof SharedMemoryHandler> {
    if (!this.sharedMemoryHandler) {
      this.sharedMemoryHandler = new SharedMemoryHandler(this.store, this.eventBus, {
        sharedMemoryOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
        localAgentAddresses: () => [...this.localAgents.keys()],
        // OT-RFC-38 / LU-6 Phase B: chain-backed agent-allowlist
        // fallback. Cores hosting curated CGs they are NOT members
        // of have no local meta for the allowlist — without this,
        // every host-mode envelope fails verification with "no
        // agent allowlist on context graph" and the LU-6 substrate
        // collapses for any CG the hosting core didn't itself
        // create or join. See `resolveOnChainParticipantAgents`.
        chainAgentGateOracle: (cgId: string) => this.resolveOnChainParticipantAgents(cgId),
        // OT-RFC-38 / LU-6 Phase B — final fallback when chain has no
        // answer yet. Looks up the curator EOA the local node pinned
        // from this CG's discovery beacon. Hits during the pre-reg
        // and chain-event-race windows where the chain oracle is cold
        // but a valid beacon has already verified the curator's
        // signature, so admitting envelopes signed by that EOA is
        // safe. See `resolveBeaconPinnedCuratorEoa`.
        beaconCuratorOracle: (cgId: string) => this.resolveBeaconPinnedCuratorEoa(cgId),
        workspaceRecipientPrivateKeys: () => this.getLocalWorkspaceRecipientPrivateKeys(),
        workspaceSenderKeyDecryptor: (message: SwmSenderKeyMessageMsg, contextGraphId: string, ctx: OperationContext) =>
          this.decryptWorkspacePayloadWithSenderKey(message, contextGraphId, ctx),
        publicSnapshotStore: this.publicSnapshotStore,
      });
    }
    return this.sharedMemoryHandler;
  }

  /**
   * Lazy single-instance CGMemberEnumerator. The enumerator owns
   * a 60s membership cache so a burst of N shares to the same CG
   * within the window pays one SPARQL query + one
   * `getSubscribers` call total, not N.
   *
   * Deps are bound here to:
   *  - `getContextGraphAllowedPeers` — the same accessor
   *    `authorizePrivateSyncRequest` uses; returns null for CGs
   *    with no `DKG_ALLOWED_PEER` allowlist triples (curated by
   *    peer-allowlist returns the array; agent-gated returns
   *    null, then `isPrivateContextGraph` discriminates).
   *  - `isPrivateContextGraph` — closes the agent-gated-CG
   *    misclassification hole (codex review on #571 bug #1): a CG
   *    private via `DKG_ALLOWED_AGENT` without `DKG_ALLOWED_PEER`
   *    falls into `source: 'none'` (fail closed) instead of
   *    falling through to live topic subscribers.
   *  - `getTopicSubscribers` — wrapping `GossipSubManager`'s
   *    PR-B-added subscriber-snapshot accessor (best-effort, may
   *    lag by one heartbeat interval; documented in
   *    GossipSubManager.getSubscribers).
   *  - `getSelfPeerId` — never fan out to ourselves; the local apply
   *    already happened in the caller of `publishWorkspaceGossip`.
   *    Passed as a thunk (not the resolved string) because
   *    `this.peerId` throws `DKGNode not started` before libp2p has
   *    booted — eagerly capturing it here would break pre-start
   *    `share()` callers (PR-C codex R8). The thunk lets any throw
   *    bubble out of `enumerate()`, where the R1 try/catch in
   *    `publishWorkspaceGossip` rescues into the gossip-only path.
   */
  /**
   * Liveness predicate for the SUBSTRATE TARGET subset of an
   * enumerated CG. Returns true iff `sendReliable` has a
   * realistic chance of putting bytes on the wire to this peer.
   *
   * **Reachability MUST match what `sendReliable` actually tries**
   * (codex RED #1 on #584). The router's send path consults
   * `libp2p.getConnections` (live) AND `libp2p.peerStore` (cached
   * addresses for dial). Filtering only on `getPeers()` would
   * silently drop legitimate substrate targets that we briefly
   * disconnected from but still have addresses for. We
   * OR-combine the two sources to mirror the send path:
   * connected OR peerStore-known.
   *
   * PeerId hygiene (codex RED #4 on #584 round 2):
   * `libp2p.peerStore.get` requires a `PeerId` object, NOT a
   * string. A type-cast call throws on the disconnected-but-
   * known path in the real libp2p API, which would make this
   * predicate return false for peers we DO have cached addresses
   * for — dropping legitimate substrate targets. We parse with
   * `peerIdFromString` first; on parse failure (malformed
   * gossipsub entry) the catch returns false (safe drop).
   *
   * Pre-start: if libp2p hasn't booted, `getPeers()` throws →
   * caught → return false → substrate target set is empty →
   * substrate fan-out is a no-op (gossip still runs). The
   * pre-start GossipSub subscriber list is normally empty anyway.
   *
   * Single source of truth: this method is consumed BOTH by the
   * CG enumerator (filters topic-subscribers to populate
   * `substrateEligibleMembers`) AND by `swmSubstrateTopUp` (re-
   * filters watchdog missingPeers so the top-up doesn't keep
   * blasting ghost peers that ackQuorum legitimately tracks but
   * substrate can't reach). PR-J round 2 introduces the second
   * use to close the watchdog leg of the same soak bug — without
   * it, the queued counter would inflate once per 30s tick
   * instead of once per share.
   */
  private async isPeerDialable(peerId: string): Promise<boolean> {
    try {
      // Test-stub fast path: short peer ids like '12D3KooWPeerA'
      // don't pass libp2p's base58 length check in
      // peerIdFromString. Preserve pre-PR-K
      // "connected ⇒ dialable" semantics for them so existing
      // integration tests that stub gossip subscribers with
      // these short ids keep working.
      const { peerIdFromString } = await import('@libp2p/peer-id');
      let pid: ReturnType<typeof peerIdFromString>;
      try {
        pid = peerIdFromString(peerId);
      } catch {
        return this.node.libp2p.getPeers().some((p) => p.toString() === peerId);
      }

      // PR-K filter tier 1: connectivity. Reject peers whose
      // ONLY live connections are *limited* Circuit Relay V2
      // reservations. Limited reservations cap data (~128 KiB)
      // and duration (~2 min) per stream; the aggressive
      // per-cycle traffic of SWM substrate fan-out exhausts
      // these caps almost immediately, after which every
      // `messenger.sendReliable` hits a stream-reset / aborted
      // error that `isRecoverableSendError` (correctly)
      // classifies as recoverable. The outbox queues + retries
      // forever, each retry eating fresh budget — a death
      // spiral the 2026-05-18 Miles<->Lex soak surfaced as
      // `swm-update: d=0 q=2031` after ~60 cycles, with both
      // peers behind NAT and connected only via limited relays.
      const conns = this.node.libp2p.getConnections(pid);
      if (conns.length > 0) {
        const hasNonLimited = conns.some((c) => !((c as unknown as { limits?: unknown }).limits));
        if (!hasNonLimited) return false;
      } else {
        // No live connection — fall back to peerStore-cached
        // addresses. A future dial may yield a non-limited
        // path; if it doesn't, the next isPeerDialable call
        // catches it via the connected branch above.
        const peerForAddrs = await this.node.libp2p.peerStore.get(pid);
        if ((peerForAddrs?.addresses?.length ?? 0) === 0) return false;
      }

      // PR-K filter tier 2: protocol support. The substrate
      // fan-out specifically uses `/dkg/10.0.1/swm-update`. rc8
      // beacon relays subscribe to gossip topics (they
      // participate in the mesh-forwarding to deliver shares)
      // but they don't register a handler for the rc9-only
      // `/dkg/10.0.1/swm-update` protocol — sendReliable to
      // them errors with `"Protocol selection failed - could
      // not negotiate /dkg/10.0.1/swm-update"`, which
      // `isRecoverableSendError` matches via the
      // `"could not negotiate"` substring and queues for
      // perpetual retry. (The classifier rule itself is
      // correct for transient connection-warmup negotiation
      // failures; pre-filtering at enumeration is the
      // surgical fix.)
      //
      // Surfaced by the PR-K verification soak (2026-05-18,
      // post-restart with PR-K tier 1 only): all 4 queued
      // sends in the first cycle were to Hetzner beacon
      // relays (12D3KooW...mkauaijsNrWw etc), each erroring
      // with "could not negotiate". The relays themselves
      // are direct TCP connections (NOT limited circuits) so
      // tier 1 doesn't catch them.
      try {
        const peer = await this.node.libp2p.peerStore.get(pid);
        const protos = peer?.protocols ?? [];
        if (!protos.includes(PROTOCOL_SWM_UPDATE)) return false;
      } catch {
        // peerStore.get can throw on cold-cache miss for a
        // peer we've just learned about via peer-exchange. Be
        // conservative: if we can't confirm protocol support,
        // skip substrate fan-out for them this round. The next
        // isPeerDialable call (after the next peerStore
        // identify exchange) will succeed if they speak it.
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  getOrCreateCGMemberEnumerator(): CGMemberEnumerator {
    if (!this.cgMemberEnumerator) {
      this.cgMemberEnumerator = createCGMemberEnumerator({
        getContextGraphAllowedPeers: (cgId) => this.getContextGraphAllowedPeers(cgId),
        isPrivateContextGraph: (cgId) => this.isPrivateContextGraph(cgId),
        getTopicSubscribers: (topic) => this.gossip.getSubscribers(topic),
        // OT-RFC-38 / LU-6 Phase B — substrate caller passes the local
        // cleartext id; resolver derives the wire-form topic for the
        // peer-subscriber probe so the substrate doesn't query the
        // wrong topic and conclude a CG has no gossip subscribers.
        topicForCG: (cgId) => contextGraphWorkspaceTopic(this.gossipWireIdFor(cgId)),
        getSelfPeerId: () => this.peerId,
        // PR-J liveness filter: marks the substrate target subset
        // (NOT `members`/`enumeratedMembers`) so the substrate
        // fan-out doesn't waste sends on peers we have no
        // addressing for. Bug fix for the 2026-05-18 Miles<->Lex
        // soak where 3-of-4 enumerated public-CG subscribers were
        // ghosts (peer-exchange residue) and every substrate send
        // queued forever.
        //
        // **Reachability MUST match what `sendReliable` actually
        // tries** (codex RED #1 on #584 round 1). The router's
        // send path consults libp2p.getConnections (live) AND
        // libp2p.peerStore (cached addresses for dial). Filtering
        // only on `getPeers()` would silently drop legitimate
        // substrate targets that we briefly disconnected from but
        // still have addresses for. We OR-combine the two sources
        // to mirror the send path: connected OR peerStore-known.
        //
        // PeerId hygiene (codex RED #4 on #584 round 2):
        // libp2p.peerStore.get requires a `PeerId` object, NOT a
        // string. The pre-fix cast threw on the disconnected-but-
        // known path (real libp2p) and silently returned `false`,
        // making the filter drop legitimate subscribers that
        // SHOULD have been dialable. Parse with `peerIdFromString`
        // first; on parse failure (malformed gossipsub entry)
        // fall through to the catch → false → safe drop.
        //
        // Pre-start: if libp2p hasn't booted, `getPeers()` throws
        // → caught → return false → substrate target subset
        // becomes empty for this CG → substrate fan-out is a
        // no-op (gossip leg still runs). The pre-start GossipSub
        // subscriber list is normally empty anyway since we
        // haven't joined the mesh yet, so this path is rare in
        // practice.
        isPeerDialable: (peerId) => this.isPeerDialable(peerId),
      });
    }
    return this.cgMemberEnumerator;
  }

  /**
   * Lazy single-instance SwmAckQuorum (rc.9 PR-D). Constructs on
   * first share through `publishWorkspaceGossip` and lives for
   * the agent's lifetime. The 5s tick is wired here too — kept
   * inside the lazy constructor so an agent that never shares
   * pays no timer overhead.
   *
   * `substrateTopUp` callback is implemented inline against
   * `messenger.sendReliable(PROTOCOL_SWM_UPDATE, ...)` so the
   * watchdog re-fires through the exact same protocol PR-C's
   * substrate fan-out uses — receivers (`handleSwmUpdate`) are
   * idempotent on (cgId, shareOperationId), so a top-up arriving
   * for a peer that already got the gossip-leg is dedup'd
   * server-side via `seenShareOps`. Top-up uses Promise.allSettled
   * (mirrors `executeSubstrateFanOut`) so one slow peer doesn't
   * tail-latency the rest. Failures get swallowed — the substrate's
   * own outbox handles retry.
   */
  /**
   * Watchdog-driven substrate top-up for SwmAckQuorum.
   * Extracted into a named method (mirrors PR-C's
   * `handleSwmUpdate` / PR-D's `handleSwmShareAck` shape) so
   * the per-outcome classification contract from rc.9 PR-D
   * codex follow-up #D6 can be unit-tested in isolation
   * without driving real-time watchdog ticks.
   *
   * Per-peer outcomes (classified via the SAME
   * `classifySendResult` the main fan-out uses):
   *   - `delivered` → call `swmAckQuorum.onAck` so the peer
   *     counts toward quorum. PROTOCOL_SWM_UPDATE does NOT
   *     emit `PROTOCOL_SWM_SHARE_ACK` (acks ride the gossip
   *     applier path only), so without this call a successful
   *     top-up never moves the peer into `acked` and the
   *     share stays `pending` until `deadlineHardMs` even
   *     after the actual delivery succeeded.
   *   - `retryable` (0x02 sentinel) → no-op; next watchdog
   *     tick fires another top-up, giving upstream state more
   *     time to converge.
   *   - `rejected` (0x01 sentinel) → no-op; receiver
   *     permanently rejected the share, retrying won't help.
   *     (Pre-PR-D receivers that fell back to the throw path
   *     instead of the sentinel surface this as `failed`
   *     here — also a no-op for the same reason.)
   *   - `queued` / `inFlight` / `failed` → no-op; the
   *     substrate outbox owns retry for these.
   */
  private async swmSubstrateTopUp({
    shareOperationId, cgId, payload, missingPeers,
  }: {
    shareOperationId: string;
    cgId: string;
    payload: Uint8Array;
    missingPeers: readonly string[];
  }): Promise<void> {
    const ctx = createOperationContext('share', shareOperationId);
    // PR-J round 2: ackQuorum's `expectedMembers` is now the FULL
    // enumerated set (gossip-eligible) per codex RED #3 on #584.
    // `missingPeers` therefore includes peers ackQuorum tracks but
    // substrate can't reach (ghost peer-exchange entries, or
    // gossip-only-reachable peers without peerStore addresses).
    // Re-apply the same dialability filter here so the watchdog
    // top-up doesn't keep blasting wire sends that will queue
    // forever — that would inflate the `swm.substrateFanout.queued`
    // counter once per 30s tick for each ghost, recreating the
    // soak bug at watchdog cadence instead of share cadence.
    //
    // Filtered-out peers remain in ackQuorum's expectedMembers and
    // get reaped via deadlineHardMs if they never ack (a metric
    // blip, not a wire-load regression — exactly the tradeoff
    // codex called out as "noise we can't distinguish from
    // legitimate churn" in the round-2 review).
    const dialabilityChecks = await Promise.all(missingPeers.map((p) => this.isPeerDialable(p)));
    const dialableMissingPeers = missingPeers.filter((_, idx) => dialabilityChecks[idx]);
    if (dialableMissingPeers.length === 0) {
      this.log.info(
        ctx,
        `SWM ack-quorum watchdog skipping substrate top-up for ${shareOperationId} (cg=${cgId}): no dialable peers among ${missingPeers.length} missing`,
      );
      return;
    }
    this.log.info(
      ctx,
      `SWM ack-quorum watchdog firing substrate top-up for ${shareOperationId} to ${dialableMissingPeers.length}/${missingPeers.length} dialable peer(s) (cg=${cgId})`,
    );
    // PR-H bug 1: route per-peer outcomes to the right ack-quorum
    // hook. Pre-PR-H ignored outcomes entirely except for
    // `delivered` → onAck; the watchdog couldn't fire again so
    // shares sat until `deadlineHardMs` (5 min) on transient
    // receiver errors.
    //
    // PR-H round 2 (codex feedback on #582):
    //   - `delivered` → onAck (terminal-success; counts toward
    //     quorum).
    //   - `rejected` (0x01 sentinel) / `failed` → dropPeer; the
    //     peer is permanently out of this share's recipient set.
    //     Round 1 just no-op'd on these, which (combined with
    //     rearmWatchdog rebuilding `missingPeers` from
    //     `expectedMembers \ acked`) re-sent permanently-bad
    //     payloads to the same rejected peer on every subsequent
    //     watchdog tick. Dropping shrinks both the top-up target
    //     set AND the quorum denominator, so a CG where 1/3
    //     peers permanently rejects can still hit quorum on the
    //     remaining 2 acks instead of waiting out
    //     `deadlineHardMs`.
    //   - `retryable` (0x02 sentinel) / `queued` / `inFlight` →
    //     count toward `rearmCount`. `queued`/`inFlight` was a
    //     round-1 gap: the substrate outbox owns wire retry for
    //     those outcomes, but the outbox doesn't notify back
    //     into the ack-quorum when its eventual retry hits the
    //     receiver. The watchdog firing again at next interval
    //     is the loosely-coupled signal — if the outbox
    //     succeeded AND the receiver ack'd via gossip, quorum
    //     already grew via `onAck` from the SWM_SHARE_ACK
    //     receiver and the next watchdog will see the record
    //     already completed (no-op). If still missing, the next
    //     top-up cycle gives both the outbox and the receiver
    //     another chance, bounded by `deadlineHardMs`. Open
    //     follow-up: full outbox→quorum wiring (markDelivered
    //     observer surfacing response sentinels back to the
    //     publisher) would tighten this further; out of scope
    //     for this PR — see PR #582 comments / follow-up issue.
    let rearmCount = 0;
    await Promise.allSettled(dialableMissingPeers.map(async (peerId: string) => {
      try {
        const sendResult = await this.messenger.sendReliable(peerId, PROTOCOL_SWM_UPDATE, payload, {
          messageId: `swm-topup-${shareOperationId}-${peerId}`,
          timeoutMs: DKGAgent.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS,
        });
        const classified = classifySendResult(peerId, sendResult);
        switch (classified.outcome) {
          case 'delivered':
            this.swmAckQuorum?.onAck(shareOperationId, peerId);
            break;
          case 'rejected':
          case 'failed':
            this.swmAckQuorum?.dropPeer(shareOperationId, peerId);
            break;
          case 'retryable':
          case 'queued':
          case 'inFlight':
            rearmCount += 1;
            break;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `SWM top-up to ${peerId} failed: ${reason}`);
      }
    }));
    if (rearmCount > 0) {
      this.log.info(
        ctx,
        `SWM top-up saw ${rearmCount} non-terminal outcome(s) — re-arming watchdog`,
      );
      this.swmAckQuorum?.rearmWatchdog(shareOperationId);
    }
  }

  /**
   * Test-only view onto {@link swmSubstrateTopUp} for the
   * PR-D codex follow-up #D6 regression. Bypasses the
   * watchdog's setInterval so tests can pin the per-outcome
   * classification → onAck wiring without real-time flake.
   */
  async invokeSwmSubstrateTopUpForTests(args: {
    shareOperationId: string;
    cgId: string;
    payload: Uint8Array;
    missingPeers: readonly string[];
  }): Promise<void> {
    return this.swmSubstrateTopUp(args);
  }

  getOrCreateSwmAckQuorum(): SwmAckQuorum {
    if (!this.swmAckQuorum) {
      this.swmAckQuorum = createSwmAckQuorum({
        substrateTopUp: (args) => this.swmSubstrateTopUp(args),
        observers: {
          onQuorumCompleted: (e: {
            shareOperationId: string; cgId: string; ackedCount: number; expectedCount: number; ackPct: number;
          }) => {
            this.log.debug(
              createOperationContext('share', e.shareOperationId),
              `SWM share quorum reached cg=${e.cgId} acked=${e.ackedCount}/${e.expectedCount} (${(e.ackPct * 100).toFixed(1)}%)`,
            );
          },
          onWatchdogFired: (e: {
            shareOperationId: string; cgId: string; missingCount: number; expectedCount: number;
          }) => {
            this.log.warn(
              createOperationContext('share', e.shareOperationId),
              `SWM share watchdog fired cg=${e.cgId} missing=${e.missingCount}/${e.expectedCount}`,
            );
          },
          onDeadlineExpired: (e: {
            shareOperationId: string; cgId: string; ackedCount: number; expectedCount: number; ackPct: number;
          }) => {
            this.log.warn(
              createOperationContext('share', e.shareOperationId),
              `SWM share deadline expired cg=${e.cgId} acked=${e.ackedCount}/${e.expectedCount} (${(e.ackPct * 100).toFixed(1)}%) — offline peers will recover via runSyncOnConnect`,
            );
          },
        },
      });
      this.swmAckQuorumTimer = setInterval(() => {
        try {
          this.swmAckQuorum?.tick();
        } catch (err) {
          // Defensive — tick() should not throw, but if some
          // future observer/callback path breaks the contract we'd
          // rather drop one tick than crash the daemon's tick loop.
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(createOperationContext('system'), `SWM ack-quorum tick failed: ${reason}`);
        }
      }, DKGAgent.SWM_ACK_QUORUM_TICK_MS);
      const t = this.swmAckQuorumTimer as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
    return this.swmAckQuorum;
  }

  /**
   * {@link FanOutBookkeeper} implementation backed by the four
   * per-cgId outcome maps + the overflow buckets. Mirrors the
   * Codex PR #570 R5/R8 shape from `recordSwmGossipPublishFailure`:
   * once the per-cgId map crosses
   * `SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS`, the cgId with the
   * GLOBAL smallest TOTAL count (summed across all four outcome
   * maps) is evicted into the appropriate overflow bucket, so the
   * grand total stays accurate and the hot cgIds stay visible.
   *
   * Returned as a single object literal (not a class) so the
   * tier-switch in `publishWorkspaceGossip` can pass it inline
   * to `executeSubstrateFanOut` without extra plumbing.
   */
  substrateFanoutBookkeeper(): FanOutBookkeeper {
    return {
      recordOutcome: (cgId: string, record: FanOutPeerRecord) => {
        this.recordSwmSubstrateFanoutOutcome(cgId, record);
      },
    };
  }

  /**
   * Increment the per-(cgId, outcome) substrate counter and apply
   * the overflow-cap eviction policy. Returns the post-increment
   * count for the caller's WARN log on `failed` outcomes (parity
   * with `recordSwmGossipPublishFailure`'s R12-fix shape).
   */
  private recordSwmSubstrateFanoutOutcome(cgId: string, record: FanOutPeerRecord): void {
    const targetMap = this.substrateFanoutMapFor(record.outcome);
    targetMap.set(cgId, (targetMap.get(cgId) ?? 0) + 1);
    this.maybeEvictSubstrateFanoutCgId(cgId);
  }

  private substrateFanoutMapFor(outcome: FanOutPeerRecord['outcome']): Map<string, number> {
    switch (outcome) {
      case 'delivered': return this.swmSubstrateFanoutDelivered;
      case 'rejected':  return this.swmSubstrateFanoutRejected;
      case 'retryable': return this.swmSubstrateFanoutRetryable;
      case 'queued':    return this.swmSubstrateFanoutQueued;
      case 'inFlight':  return this.swmSubstrateFanoutInFlight;
      case 'failed':    return this.swmSubstrateFanoutFailed;
    }
  }

  private substrateFanoutTotalForCg(cgId: string): number {
    return (this.swmSubstrateFanoutDelivered.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutRejected.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutRetryable.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutQueued.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutInFlight.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutFailed.get(cgId) ?? 0);
  }

  /**
   * If the per-cgId tracking set is at or above
   * `SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS`, find the cgId with
   * the smallest TOTAL count (summed across all four outcome
   * maps), drain its four per-outcome counts into the overflow
   * buckets, and delete it from the four maps. Setting the
   * sticky `swmSubstrateFanoutTruncated` flag tells operators
   * the per-cgId breakdown on /api/slo is partial.
   *
   * Eviction key = TOTAL across outcomes (not any single map),
   * because the operator-facing definition of "hot cgId" is "lots
   * of substrate activity", regardless of how it broke down. A
   * cgId with 100 delivers is hotter than a cgId with 5 failed,
   * even though `failed` is the more alarming outcome.
   */
  private maybeEvictSubstrateFanoutCgId(_justBumped: string): void {
    // Use any of the five maps to count distinct tracked cgIds —
    // they're populated together via `substrateFanoutTotalForCg`.
    const distinctCgIds = new Set<string>([
      ...this.swmSubstrateFanoutDelivered.keys(),
      ...this.swmSubstrateFanoutRejected.keys(),
      ...this.swmSubstrateFanoutRetryable.keys(),
      ...this.swmSubstrateFanoutQueued.keys(),
      ...this.swmSubstrateFanoutInFlight.keys(),
      ...this.swmSubstrateFanoutFailed.keys(),
    ]);
    if (distinctCgIds.size <= DKGAgent.SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS) return;

    let smallestCg: string | null = null;
    let smallestTotal = Infinity;
    for (const cg of distinctCgIds) {
      const total = this.substrateFanoutTotalForCg(cg);
      if (total < smallestTotal) {
        smallestTotal = total;
        smallestCg = cg;
      }
    }
    if (smallestCg === null) return;

    this.swmSubstrateFanoutOverflow.delivered += this.swmSubstrateFanoutDelivered.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.rejected  += this.swmSubstrateFanoutRejected.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.retryable += this.swmSubstrateFanoutRetryable.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.queued    += this.swmSubstrateFanoutQueued.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.inFlight  += this.swmSubstrateFanoutInFlight.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.failed    += this.swmSubstrateFanoutFailed.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutDelivered.delete(smallestCg);
    this.swmSubstrateFanoutRejected.delete(smallestCg);
    this.swmSubstrateFanoutRetryable.delete(smallestCg);
    this.swmSubstrateFanoutQueued.delete(smallestCg);
    this.swmSubstrateFanoutInFlight.delete(smallestCg);
    this.swmSubstrateFanoutFailed.delete(smallestCg);
    this.swmSubstrateFanoutTruncated = true;
  }

  /**
   * Snapshot of the substrate fan-out counters for /api/slo.
   * Same surface shape as `getSwmGossipStats()` / `getSwmHandlerStats()`
   * — pure read, safe to call from a fresh daemon (returns
   * pristine zeroes when no shares have fanned out yet). Pre-
   * serializing into `Record<string, number>` happens via
   * `Object.fromEntries` consistent with the existing /api/slo
   * shape.
   */
  /**
   * Test/observability helper (rc.9 PR-G codex follow-up #G2).
   * Resolves once every detached substrate fan-out spawned by
   * `publishWorkspaceGossip` has settled (counters updated,
   * INFO log emitted). Production code DOES NOT need to call
   * this — the whole point of the G2 detach is that share()
   * returns without waiting on the substrate side. Used by
   * integration tests that assert on substrate counters after
   * a `share()` call, and by the soak script's shutdown flush
   * so in-flight outbox writes don't get lost across process
   * boundaries.
   *
   * Returns a snapshot of the in-flight set at call time, so a
   * fan-out enqueued AFTER this call returns will not be awaited.
   * Callers that need full drain should loop until
   * `inFlightSubstrateFanOutCount() === 0`.
   */
  async awaitInFlightSubstrateFanOuts(): Promise<void> {
    await Promise.allSettled([...this.inFlightSubstrateFanOuts]);
  }

  /** Sibling of {@link awaitInFlightSubstrateFanOuts} — gauge for diagnostic / drain-loop use. */
  inFlightSubstrateFanOutCount(): number {
    return this.inFlightSubstrateFanOuts.size;
  }

  getSwmSubstrateFanoutStats(): {
    delivered: Record<string, number>;
    rejected: Record<string, number>;
    retryable: Record<string, number>;
    queued: Record<string, number>;
    inFlight: Record<string, number>;
    failed: Record<string, number>;
    overflow: { delivered: number; rejected: number; retryable: number; queued: number; inFlight: number; failed: number };
    truncated: boolean;
  } {
    return {
      delivered: Object.fromEntries(this.swmSubstrateFanoutDelivered),
      rejected: Object.fromEntries(this.swmSubstrateFanoutRejected),
      retryable: Object.fromEntries(this.swmSubstrateFanoutRetryable),
      queued: Object.fromEntries(this.swmSubstrateFanoutQueued),
      inFlight: Object.fromEntries(this.swmSubstrateFanoutInFlight),
      failed: Object.fromEntries(this.swmSubstrateFanoutFailed),
      overflow: {
        delivered: this.swmSubstrateFanoutOverflow.delivered,
        rejected: this.swmSubstrateFanoutOverflow.rejected,
        retryable: this.swmSubstrateFanoutOverflow.retryable,
        queued: this.swmSubstrateFanoutOverflow.queued,
        inFlight: this.swmSubstrateFanoutOverflow.inFlight,
        failed: this.swmSubstrateFanoutOverflow.failed,
      },
      truncated: this.swmSubstrateFanoutTruncated,
    };
  }

  /**
   * Snapshot of the SwmAckQuorum counters for /api/slo (rc.9
   * PR-D). Returns pristine zeroes when the quorum tracker hasn't
   * been lazy-constructed yet (no shares have been published, or
   * none of them met the tracking preconditions in
   * `publishWorkspaceGossip`). Safe to call from a fresh daemon.
   *
   * Counter semantics (cumulative since process start, except
   * `pending` which is an instantaneous gauge):
   *   - tracked          — every successful `track()` call
   *   - completed        — records that reached quorumThreshold
   *   - watchdogFired    — records where the watchdog fired
   *                        substrate top-up (at most once per
   *                        record)
   *   - deadlineExpired  — records reaped at deadlineHardMs
   *                        without reaching quorum
   *   - pending          — currently tracked (not yet completed
   *                        or expired)
   *
   * A healthy soak surfaces: `completed >> watchdogFired >>
   * deadlineExpired`. A spike in `deadlineExpired` is the
   * operator alarm — those peers will recover via
   * `runSyncOnConnect` but the share's per-recipient delivery
   * window blew past the 5min budget.
   */
  getSwmAckQuorumStats(): {
    tracked: number;
    completed: number;
    watchdogFired: number;
    deadlineExpired: number;
    pending: number;
  } {
    if (!this.swmAckQuorum) {
      return { tracked: 0, completed: 0, watchdogFired: 0, deadlineExpired: 0, pending: 0 };
    }
    return this.swmAckQuorum.stats();
  }

  private updateHandler?: UpdateHandler;

  private getOrCreateUpdateHandler(): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchContextGraphs: this.publisher.knownBatchContextGraphs,
        // GH #842: let the receiver promote applied updates into the per-cgId
        // partition the RS prover reads, so updated KAs are provable on all
        // nodes, not just the publisher.
        resolveOnChainCgId: (cgName: string) => this.getContextGraphOnChainId(cgName),
      });
    }
    return this.updateHandler;
  }

  getOrCreateFinalizationHandler(): FinalizationHandler {
    if (!this.finalizationHandler) {
      this.finalizationHandler = new FinalizationHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.eventBus,
        // Defensive: when a peer's finalization gossip omits
        // `targetContextGraphId` (pre-cd68fa689 publisher in the mesh),
        // resolve the on-chain id locally so per-cgId promotion still
        // fires and the RS prover sees the KC.
        (cgName: string) => this.getContextGraphOnChainId(cgName),
      );
    }
    return this.finalizationHandler;
  }

  /**
   * Create a context graph. All CGs start as free, P2P collaborative spaces.
   * No blockchain transaction is required. On-chain registration is a separate
   * explicit step via {@link registerContextGraph}.
   *
   * The `private` flag still works for truly local-only CGs (no gossip, no sync).
   * For curated CGs, provide `allowedPeers` to restrict gossip writes to listed peers.
   */
  async signJoinRequest(
    contextGraphId: string,
    agentAddress?: string,
  ): Promise<SignedAgentDelegation> {
    const addr = agentAddress ?? this.defaultAgentAddress;
    if (!addr) throw new Error('No agent address available');

    const agent = this.localAgents.get(addr);
    if (!agent?.privateKey) {
      throw new Error(`No private key for agent ${addr} — self-sovereign agents must sign externally`);
    }

    // Bind to BOTH delegatee shapes when available so the agent's
    // approval survives rotation of either key. The libp2p peer-id is
    // always available; the operational key is available when the chain
    // adapter advertises one (typical V10 nodes do).
    const delegateePeerId = this.peerId;
    let delegateeOpKey: string | undefined;
    try {
      delegateeOpKey = await inferAdapterPublisherAddress(this.chain);
    } catch {
      // Best-effort — delegateePeerId alone is sufficient.
    }

    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + JOIN_DELEGATION_VALIDITY_MS;

    const signed = await signAgentDelegation({
      agentAddress: addr,
      scope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: agent.privateKey,
    });
    // Remember our intent so multi-agent post-approval sync binds to
    // the right agent before `_meta` catches up. Last-write-wins is
    // intentional: a node that re-signs with a different agent has
    // changed its intent for this CG.
    this.localApprovedAgentByCG.set(contextGraphId, addr.toLowerCase());
    return signed;
  }

  /**
   * Verify a signed join-request delegation. Re-uses the generic
   * `verifyAgentDelegation` primitive and pins the scope to this CG.
   * Throws on any failure.
   */
  verifyJoinRequest(contextGraphId: string, delegation: SignedAgentDelegation): SignedAgentDelegation {
    verifyAgentDelegation(delegation, { expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId) });
    return delegation;
  }

  /**
   * Store a pending join request — the agent's signed delegation — in
   * the CG's `_meta` graph. The curator can later approve or reject.
   *
   * Persists the FULL delegation (agentAddress, scope, issuedAtMs,
   * expiresAtMs, delegateePeerId, delegateeOpKey, signature) so that
   * approval can re-verify against the same digest, and so that the
   * approved delegatee identifiers can be promoted into the CG's
   * allowlist via `inviteAgentToContextGraph` without round-tripping
   * the joiner.
   */
  async storePendingJoinRequest(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName?: string,
  ): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${delegation.agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: requestUri });

    // Escape every user-controllable literal. `contextGraphId`, `delegation.scope`,
    // and `agentName` flow from joiner input and can contain `"` or `\`, which
    // would produce invalid N-Quads and fail the insert (or open a SPARQL
    // injection surface). Other fields are validated upstream:
    //   - `agentAddress` and `signature` are 0x-hex (verifyAgentDelegation
    //     recovers an EVM address, so non-hex throws before we get here)
    //   - `issuedAtMs` / `expiresAtMs` are numbers serialised by JS
    //   - `delegateePeerId` / `delegateeOpKey` are protocol-shaped identifiers.
    const quads: Quad[] = [
      { subject: requestUri, predicate: RDF_TYPE, object: `${DKG}JoinRequest`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}agentAddress`, object: `"${delegation.agentAddress}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}contextGraphId`, object: `"${escapeSparqlLiteral(contextGraphId)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}signature`, object: `"${delegation.signature}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestTimestamp`, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestStatus`, object: `"pending"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}delegationScope`, object: `"${escapeSparqlLiteral(delegation.scope)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
    ];
    if (delegation.expiresAtMs && delegation.expiresAtMs > 0) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${delegation.expiresAtMs}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateePeerId) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER, object: `"${delegation.delegateePeerId}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateeOpKey) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY, object: `"${delegation.delegateeOpKey.toLowerCase()}"`, graph: cgMetaGraph });
    }
    if (agentName) {
      quads.push({ subject: requestUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(agentName)}"`, graph: cgMetaGraph });
    }
    await this.store.insert(quads);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: delegation.agentAddress,
      role: 'requester',
      status: 'pending',
      source: 'join-request',
      ...(agentName ? { displayName: agentName } : {}),
      metadata: { timestamp: delegation.issuedAtMs },
    });
    const ctx = createOperationContext('system');
    this.log.info(ctx, `Stored pending join request from ${delegation.agentAddress} for "${contextGraphId}"`);
    // Emit JOIN_REQUEST_RECEIVED here (single source of truth) so the daemon's
    // lifecycle.ts hook turns it into a SQLite notification + SSE broadcast
    // for the curator's UI bell. Previously this emit lived only on the P2P
    // handler in `setupNetworkHandlers`, so a join request that reached the
    // curator via the HTTP `request-join` route's `isCurator` branch (e.g.
    // when joiner and curator are the same node, or when a relay/bridge
    // re-posts the request locally) silently stored without surfacing in
    // notifications. Centralising the emit here means every successful
    // store — regardless of inbound path — produces a notification.
    this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
      contextGraphId,
      agentAddress: delegation.agentAddress,
      agentName,
    });
  }

  /**
   * Reload a stored join-request delegation in its full
   * `SignedAgentDelegation` shape so it can be re-verified at approval
   * time and its delegatee identifiers promoted into the CG allowlist.
   */
  async loadPendingJoinDelegation(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<SignedAgentDelegation | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    // Pin to `requestStatus = "pending"` so a previously-rejected (or
    // already-approved) request is not re-loaded and re-approved by
    // mistake — the join-request URI persists across status transitions
    // (only `requestStatus` flips), so without this filter
    // `approveJoinRequest` could resurrect a rejection.
    const result = await this.store.query(
      `SELECT ?sig ?ts ?scope ?expires ?peer ?opkey WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}signature> ?sig ;
                          <${DKG}requestTimestamp> ?ts ;
                          <${DKG}requestStatus> "pending" .
          OPTIONAL { <${requestUri}> <${DKG}delegationScope> ?scope }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expires }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER}> ?peer }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY}> ?opkey }
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    const row = result.bindings[0];
    const signature = strip(row['sig']);
    const issuedAtMs = parseInt(strip(row['ts']), 10) || 0;
    const expires = row['expires'] ? parseInt(strip(row['expires']), 10) || 0 : 0;
    const scope = row['scope'] ? strip(row['scope']) : joinDelegationScope(this.chain.deploymentId, contextGraphId);
    const delegateePeerId = row['peer'] ? strip(row['peer']) : undefined;
    const delegateeOpKey = row['opkey'] ? strip(row['opkey']) : undefined;
    if (!signature || !issuedAtMs) return null;
    if (!delegateePeerId && !delegateeOpKey) {
      // Legacy pending row from before the delegation rework — has
      // signature + timestamp but no delegatee identifiers, so the
      // new verifier would reject it with a generic "at least one
      // delegatee identifier is required". Throw a curator-readable
      // error with a migration hint instead.
      throw new Error(
        `Pending join request from ${agentAddress} predates the V10 delegation rework ` +
        `(missing delegatee identifiers). Reject this request and ask the joiner to re-submit; ` +
        `the upgrade is a clean break in the join-request wire format.`,
      );
    }
    return {
      agentAddress,
      scope,
      issuedAtMs,
      ...(expires ? { expiresAtMs: expires } : {}),
      ...(delegateePeerId ? { delegateePeerId } : {}),
      ...(delegateeOpKey ? { delegateeOpKey } : {}),
      signature,
    };
  }

  /**
   * List pending join requests for a context graph.
   */
  async listPendingJoinRequests(
    contextGraphId: string,
  ): Promise<Array<{ agentAddress: string; name?: string; signature: string; timestamp: number; status: string }>> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?addr ?name ?sig ?ts ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}agentAddress> ?addr ;
               <${DKG}signature> ?sig ;
               <${DKG}requestTimestamp> ?ts ;
               <${DKG}requestStatus> ?status .
          OPTIONAL { ?req <https://schema.org/name> ?name }
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    return result.bindings.map((row) => ({
      agentAddress: strip(row['addr']),
      name: row['name'] ? strip(row['name']) : undefined,
      signature: strip(row['sig']),
      timestamp: parseInt(strip(row['ts']), 10) || 0,
      status: strip(row['status']),
    })).filter((r) => r.status === 'pending');
  }

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    const delegation = await this.loadPendingJoinDelegation(contextGraphId, agentAddress);
    if (!delegation) {
      throw new Error(`No pending join request found from ${agentAddress}`);
    }
    // Re-verify the signed delegation against the CURRENT clock —
    // approval is an authorisation event so the delegation's
    // expiry must still be in force. If the curator took longer than
    // the joiner's `expiresAtMs` to review, the joiner has to re-sign
    // (their UI will surface the now-expired pending request and
    // prompt them); silently promoting an expired delegation into the
    // sync allowlist would defeat the whole point of binding an expiry
    // into the signed payload. The standard `JOIN_DELEGATION_VALIDITY_MS`
    // is 1 year so this is a non-issue in practice.
    verifyAgentDelegation(delegation, {
      expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
    });

    await this.inviteAgentToContextGraph(contextGraphId, agentAddress, callerAgentAddress, delegation);

    // Mark request as approved
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"approved"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the approved agent so their node
   * automatically retries the subscription.
   *
   * Delivers the message ONLY to the requester's peer, resolved via the
   * local agent registry. The earlier implementation broadcast to every
   * connected peer and relied on each recipient's handler to filter by
   * `agentAddress`. That leaked membership information for curated
   * context graphs: every peer on the P2P network learned that
   * `agentAddress` had just been invited to `contextGraphId`, which is
   * exactly the metadata a curated CG is supposed to hide.
   *
   * If the requester isn't in the local registry we fall back to a
   * best-effort dial through their relay address when available. We do
   * NOT broadcast in any case — the invitee will re-learn on their next
   * subscribe attempt if the direct notification fails.
   */
  public async notifyJoinApproval(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    if (result.delivered) {
      return;
    }
    // rc.9 PR-10: the substrate outbox already holds the queued send
    // (deliverPrivateJoinNotification → messenger.sendReliable enqueues
    // on failure). All we do here is log the transport failure for
    // operator visibility — the substrate's periodic tick + on-connect
    // flush will drive the retry to eventual delivery without our help.
    const ctx = createOperationContext('system');
    this.log.warn(
      ctx,
      `join-approval for "${contextGraphId}" → ${agentAddress} not delivered now ` +
        `(error=${result.error ?? 'unknown'}). Curator-local state is correct; ` +
        `substrate outbox holds the queued send and will retry on its backoff ` +
        `ladder + on the invitee's next reconnect.`,
    );
  }

  /**
   * Re-fire the `join-approved` P2P notification for a previously-approved
   * agent. Idempotent and safe to call multiple times; only the most recent
   * delivery state matters.
   *
   * Used by:
   *   * The substrate's periodic outbox tick + on-connect flush —
   *     both transparent to this call (rc.9 PR-10).
   *   * The operator-facing route `POST /api/context-graph/{id}/redeliver-approval`,
   *     which lets an operator (or peer agent via the chat MCP) re-poke
   *     the curator when the automated retry isn't fast enough.
   *
   * Returns delivery details so the caller can surface them in HTTP
   * responses / MCP tool output. Throws on caller errors (no approval row,
   * malformed agent address) so the route handler can return a 4xx.
   */
  async redeliverJoinApproval(
    contextGraphId: string,
    agentAddress: string,
    _callerAgentAddress?: string,
  ): Promise<{
    delivered: boolean;
    peerId: string | null;
    attempts: number;
    error: string | null;
  }> {
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }
    const status = await this.getJoinRequestStatus(contextGraphId, agentAddress);
    if (status !== 'approved') {
      // We deliberately don't accept `pending` here. A pending request
      // means the curator hasn't actually approved — re-firing a
      // join-approved notification in that state would be a protocol
      // violation. The caller should go through approveJoinRequest.
      throw new Error(
        `Cannot redeliver join-approval for "${contextGraphId}" → ${agentAddress}: ` +
          `request status is "${status ?? 'none'}", expected "approved". ` +
          `Approve the request first (or have the joiner re-submit if there is no record).`,
      );
    }
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    // rc.9 PR-10: attempts counter is no longer tracked at the agent
    // layer (substrate outbox owns retry bookkeeping per messageId).
    // Operators interested in retry depth can read it from the
    // substrate diagnostic surface that PR-12 adds. Until then we
    // surface a flat attempts=1 for delivered / 0 for queued so the
    // operator UI keeps rendering without code changes; the
    // delivered/error pair is the source of truth.
    if (result.delivered) {
      return {
        delivered: true,
        peerId: result.peerId,
        attempts: 1,
        error: null,
      };
    }
    return {
      delivered: false,
      peerId: result.peerId,
      attempts: 0,
      error: result.error,
    };
  }

  /**
   * Read the `requestStatus` of a join request. Returns `'pending' |
   * 'approved' | 'rejected'` or `null` if no row exists. Used by
   * `redeliverJoinApproval` to validate the operator-driven re-fire
   * path; not exported as a public method to avoid leaking the raw
   * status string into other code paths (the dedicated `loadPending…`
   * / `redeliver…` helpers are the supported API).
   */
  private async getJoinRequestStatus(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<'pending' | 'approved' | 'rejected' | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}requestStatus> ?status .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const raw = result.bindings[0]['status'];
    if (typeof raw !== 'string') return null;
    const stripped = raw.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '');
    if (stripped === 'pending' || stripped === 'approved' || stripped === 'rejected') {
      return stripped;
    }
    return null;
  }

  /**
   * Snapshot of pending approval retries. Surfaced via the daemon for
   * operator-facing diagnostics ("how many approvals are stuck on
   * transport, and how long since the first failure?").
   *
   * rc.9 PR-10: stubbed to return [] until PR-12 rebuilds the
   * operator diagnostic surface on top of the substrate outbox.
   * The substrate is now driving retries durably and transparently;
   * operators who need raw state can inspect the
   * `protocol_outbox` SQLite table directly in the interim.
   */
  listPendingJoinApprovalRetries(): JoinApprovalRetryEntry[] {
    return [];
  }

  /**
   * Periodic tick: walk the retry queue and fire `redeliverJoinApproval`
   * for every entry whose `nextAttemptAt` has passed. Also evicts
   * entries past their max age (24h since first failure by default).
   * Failures re-enqueue with longer backoffs; successes clear the entry.
   * Errors thrown by `redeliverJoinApproval` (e.g. the row went away
   * because the curator manually cleaned it up) are caught and the
   * entry is dropped to prevent the tick from spinning on a permanently
   * unrecoverable target.
   */
  // rc.9 PR-10: processJoinApprovalRetryQueueTick +
  // processJoinApprovalRetryQueueOnConnect deleted. The substrate's
  // Messenger.processOutboxTick + Messenger.processOutboxOnConnect
  // cover /dkg/10.0.1/join-request automatically (same as chat in
  // PR-3), so the two dedicated processors are obsolete. Operator
  // re-fire route POST /api/context-graph/{id}/redeliver-approval is
  // unchanged — it still calls redeliverJoinApproval which now
  // simply re-issues the substrate send.

  /**
   * Re-attempt delivery of a single chat outbox entry. Centralised so
   * the periodic tick + the connection:open opportunistic flush share
   * one code path. Returns the entry's current state so the caller can
   * decide what to log.
   *
   * Goes through `messageHandler.sendChat` directly (bypassing
   * `DKGAgent.sendChat`) so a successful retry doesn't recursively
   * re-enqueue or re-mint a fresh `messageId` — the outbox owns the
   * messageId for the lifetime of the entry.
   */
  /**
   * "Reverse-path peerStore enrichment" — when an inbound circuit-relay
   * connection from peer P via relay R opens, echo the inbound circuit
   * back as an outbound multiaddr for P (`<R>/p2p-circuit/p2p/<P>`)
   * and merge it into the local peerStore.
   *
   * The Miles↔Lex May 2026 6h soak postmortem identified the "Window D"
   * class: an inbound circuit connection from P was open and live, but
   * every `libp2p.dialProtocol(P, ...)` retry on our side failed with
   * "The dial request has no valid addresses for peer" for several
   * minutes. Daemon logs showed 31 `connection:open` events from P
   * (all inbound, all via R) + 20 opportunistic-flush attempts, all
   * failing dialProtocol — and then the moment ONE outbound connection
   * succeeded (which populated peerStore from outbound identify), the
   * very next opportunistic-flush delivered the queued message.
   *
   * The clean fix would be inside libp2p (`dialProtocol` should reuse
   * an existing open connection of any direction — see PR 5 in the
   * postmortem follow-up plan), but until that lands, populating
   * peerStore from the inbound circuit's address gives the dialer
   * something to find on the very next attempt.
   *
   * Public so a unit test can exercise it directly without standing up
   * a full libp2p network (the listener that calls it is registered
   * inside the giant `start()` method and is not easily mockable
   * end-to-end).
   *
   * Guarantees:
   * - Direct connections are a no-op (nothing to enrich — the dialer
   *   already has the address it used to open the connection).
   * - Outbound connections are a no-op (peerStore was already
   *   populated to make the dial; re-merging the same address is
   *   harmless but pointless).
   * - Throws are swallowed by the caller's `.catch()` — the
   *   `connection:open` listener must never propagate exceptions.
   * - Merging an address libp2p already knows about is a no-op
   *   (`peerStore.merge` dedupes internally).
   *
   * Trade-off (referenced from `docs/archive/UPSTREAM_ISSUE_DRAFT.md`):
   * `peerStore.merge` can wake the connection manager to dial direct,
   * which has been observed to disrupt streams mid-negotiation. We're
   * NOT in mid-negotiation here (the call runs from
   * `connection:open`, not from inside `newStream`), and the address
   * we're merging IS the same relay path that the inbound connection
   * already uses — so the worst case is the CM redundantly dialing
   * out through R, which is exactly what we want.
   */
  async enrichPeerStoreFromInboundCircuit(connection: {
    direction: 'inbound' | 'outbound';
    remoteAddr?: { toString(): string };
    remotePeer: { toString(): string };
  }): Promise<void> {
    if (connection.direction !== 'inbound') return;
    const remoteStr = connection.remoteAddr?.toString();
    if (!remoteStr) return;
    const circIdx = remoteStr.indexOf('/p2p-circuit');
    if (circIdx < 0) return;

    const remotePeer = connection.remotePeer.toString();
    if (remotePeer === this.node.libp2p.peerId.toString()) return;

    // Reverse-path multiaddr: take the relay prefix up to (but not
    // including) the `/p2p-circuit` segment, append the canonical
    // `/p2p-circuit/p2p/<P>` suffix. Works whether the inbound
    // remoteAddr ends at `/p2p-circuit` (the typical listener-side
    // shape) OR already includes a trailing `/p2p/<self>` (defensive
    // — older libp2p versions and some test transports surface the
    // explicit-destination shape). Slicing on the FIRST occurrence
    // of `/p2p-circuit` is correct either way.
    const relayPrefix = remoteStr.slice(0, circIdx);
    const reverseAddrStr = `${relayPrefix}/p2p-circuit/p2p/${remotePeer}`;

    const { peerIdFromString } = await import('@libp2p/peer-id');
    const { multiaddr } = await import('@multiformats/multiaddr');
    const pid = peerIdFromString(remotePeer);
    const reverseAddr = multiaddr(reverseAddrStr);
    await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [reverseAddr] });
  }

  /**
   * Reject a pending join request.
   */
  async rejectJoinRequest(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    // SECURITY (G1): reject is a curator-only ACL decision. Previously this
    // method had NO owner check while `approveJoinRequest` was gated (via
    // `inviteAgentToContextGraph` → `assertCallerIsOwner`), so any local-token
    // caller could reject a pending request — and the route only ran the
    // write preflight (CG-exists/locally-writable), not a curator check.
    // Mirror the approve path: assert the caller is the CG owner/curator
    // BEFORE mutating state or notifying the joiner. Throws "Only the context
    // graph curator can …" (403 at the route) for a non-curator.
    await this.assertContextGraphOwner(contextGraphId, callerAgentAddress, 'manage join requests');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"rejected"`,
      graph: cgMetaGraph,
    }]);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: agentAddress,
      role: 'requester',
      status: 'removed',
      source: 'join-rejected',
    });

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Rejected join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so their UI can flip from the stale
    // "Join request sent, awaiting approval" state to a clear denied
    // state. Non-fatal: if the invitee is unreachable they'll just
    // re-learn on their next subscribe attempt.
    this.notifyJoinRejection(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of rejection: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the rejected agent. Same privacy model
   * as `notifyJoinApproval` — delivered only to the rejectee's peer,
   * never broadcast. See that method's doc comment for rationale.
   */
  private async notifyJoinRejection(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-rejected',
      contextGraphId,
      agentAddress,
    });
    // Discard the result object — rejection deliveries don't enter the
    // retry queue. The semantics are intentionally weaker than approval:
    // if the rejection notification is lost the joiner observes silence,
    // which they'll already treat as "still pending" and either re-poll
    // or eventually time out. That's a much milder failure than a lost
    // approval (which leaves a sync-blocked invitee with no recovery path).
    await this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-rejection');
  }

  /**
   * Resolve the target agent's peer ID and send the payload only to that
   * peer. Never broadcasts — leaking a curated CG's membership to every
   * peer on the network is a real privacy violation, and dropping the
   * notification is a far milder failure (the invitee relearns on next
   * subscribe).
   *
   * Two resolution sources, in order:
   *
   *   1. `joinRequestOriginPeers` — the peer that actually delivered the
   *      original join request over P2P. Set by the handler at register
   *      time and persists for the curator's process lifetime. This
   *      avoids a regression from the old broadcast implementation: the
   *      requester may reach us via P2P before their agent profile is
   *      indexed locally, so relying on `findAgents()` alone would drop
   *      every approval/rejection until registry replication catches up.
   *   2. `discovery.findAgents()` fallback for the case where the
   *      curator restarted between receiving the request and acting on
   *      it (and thus lost the in-memory peer mapping).
   *
   * @returns void (logged success/failure; callers treat this as
   *          fire-and-forget)
   */
  private async deliverPrivateJoinNotification(
    contextGraphId: string,
    agentAddress: string,
    payload: string,
    label: 'join-approval' | 'join-rejection',
  ): Promise<{ delivered: boolean; peerId: string | null; error: string | null }> {
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const addrLower = agentAddress.toLowerCase();

    let targetPeerId: string | null = null;

    // Preferred source: the peer that actually delivered the join
    // request. This is always correct for the common flow and doesn't
    // depend on registry replication timing.
    const originKey = `${contextGraphId}::${addrLower}`;
    const rememberedPeerId = this.joinRequestOriginPeers.get(originKey);
    if (rememberedPeerId) {
      targetPeerId = rememberedPeerId;
    }

    // Always consult the registry when we either had no remembered peer
    // OR we have one but no live connection to it right now. This fixes
    // two related regressions:
    //
    //   * If the requester disconnected between submitting the request
    //     and the curator acting on it, with only the remembered-peer
    //     path we'd have no relay address to redial and the
    //     notification would be silently dropped even though the
    //     registry knows exactly how to reach them.
    //   * If the requester reconnected with a brand-new peer ID (e.g.
    //     ephemeral peer IDs, node restart on a volatile host), the
    //     remembered ID is now stale. Sending to a dead peer ID just
    //     times out; the registry's current peer ID is authoritative.
    //
    // So when the remembered peer isn't connected, we REPLACE it with
    // the registry's current peer ID (not just supplement it with a
    // relay hint), which is what Codex N25 asks for. Registry lookup is
    // cheap (local graph query).
    const rememberedIsConnected = rememberedPeerId
      ? this.node.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === rememberedPeerId)
      : false;
    if (!targetPeerId || !rememberedIsConnected) {
      try {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === addrLower);
        if (match) {
          // Take the registry's peer ID whenever we don't have a live
          // connection to the remembered one — it may be fresher.
          targetPeerId = match.peerId;
        }
      } catch {
        // Registry unavailable — we'll just skip delivery below if we
        // also have no live connection to the remembered peer.
      }
    }

    if (!targetPeerId) {
      const errMsg = `no origin peer remembered and agent not in local registry`;
      this.log.warn(
        ctx,
        `Cannot deliver ${label} for "${contextGraphId}" to ${agentAddress} — ${errMsg}. ` +
          `Dropping notification (invitee will re-learn on next subscribe).`,
      );
      return { delivered: false, peerId: null, error: errMsg };
    }

    if (targetPeerId === this.peerId) {
      this.log.info(ctx, `Skipping ${label} to ${agentAddress}: target is this node`);
      // Self-loopback "delivery" is treated as success — there is no peer to
      // retry against and the local state is authoritative anyway.
      return { delivered: true, peerId: targetPeerId, error: null };
    }

    try {
      // rc.9 PR-10: send via the Universal Messenger substrate. If
      // the substrate can't deliver synchronously it enqueues into
      // the SQLite outbox and retries in the background — this
      // replaces the deleted in-memory JoinApprovalRetryQueue. Note
      // queued counts as "not delivered now" so the caller can log
      // the failure; the substrate keeps trying behind the scenes.
      const sendResult = await this.messenger.sendReliable(
        targetPeerId,
        PROTOCOL_JOIN_REQUEST,
        payloadBytes,
        { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
      );
      if (!sendResult.delivered) {
        this.log.warn(
          ctx,
          `${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}) ` +
          `queued in substrate outbox: ${sendResult.error}. ` +
          `Substrate will retry on its own backoff ladder + on the invitee's next reconnect.`,
        );
        return { delivered: false, peerId: targetPeerId, error: sendResult.error };
      }
      this.log.info(ctx, `Delivered ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId})`);
      // The join request is finalised now — forget the origin peer so
      // the map doesn't grow unbounded over the curator's lifetime.
      this.joinRequestOriginPeers.delete(originKey);
      return { delivered: true, peerId: targetPeerId, error: null };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        ctx,
        `Could not deliver ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}): ${errMsg}`,
      );
      return { delivered: false, peerId: targetPeerId, error: errMsg };
    }
  }

  /**
   * Forward a signed join request to the curator via P2P.
   *
   * Two-tier delivery:
   *   1. Targeted send to `curatorPeerId` first (if the V10 invite carried
   *      one — the common case). On success returns immediately, avoiding
   *      a fan-out to dozens of unrelated peers.
   *   2. Fallback broadcast in PARALLEL to every other connected peer via
   *      `Promise.allSettled`. This bounds total wall-clock time to one
   *      per-peer timeout (~5s) regardless of peer count, and lets the
   *      request still find its curator when the targeted dial fails or
   *      no curator peer id is known (legacy invites).
   *
   * The earlier sequential-await loop scaled as O(connected-peers ×
   * per-peer-timeout). On a real testnet node connected to 30+ peers the
   * worst-case wait was ~2.5 minutes per click; observed 2-3 min in the
   * field. Targeted-first collapses the common case to one round-trip,
   * and parallel broadcast caps the fallback at the timeout.
   *
   * Every peer that returns `{ok: true}` (whether via targeted or
   * broadcast path) is recorded in `joinRequestAcceptedBy` so the
   * matching `join-approved` / `join-rejected` notification can be
   * authenticated against them later (see that field's doc comment).
   *
   * Returns the number of peers that accepted the request.
   */
  async forwardJoinRequest(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName: string | undefined,
    curatorPeerId: string,
  ): Promise<{ delivered: number; errors: string[]; alreadyMember?: boolean }> {
    if (!curatorPeerId) {
      // Required: V10 invites carry the curator's libp2p peer-id
      // (`<cgId>\n<peerId>`). Without it we can't authenticate the
      // returning `join-approved` / `join-rejected` notification —
      // caching arbitrary broadcast acceptors as trusted decision
      // senders is a security hole (any peer that ack'd the broadcast
      // could later forge a decision message). Fail fast at the entry
      // point with a clear error so the UI can surface it to the user.
      throw new Error(
        `forwardJoinRequest requires curatorPeerId. ` +
        `The invite code must include the curator's peer id (V10 format: "<cgId>\\n<peerId>"). ` +
        `Ask the curator to share an updated invite code.`,
      );
    }
    const payload = JSON.stringify({ contextGraphId, delegation, agentName });
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const errors: string[] = [];
    const agentAddress = delegation.agentAddress;
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;

    const recordAcceptedBy = (remotePeerId: string): void => {
      let set = this.joinRequestAcceptedBy.get(acceptedKey);
      if (!set) {
        set = new Set<string>();
        this.joinRequestAcceptedBy.set(acceptedKey, set);
      }
      set.add(remotePeerId);
    };

    // Track whether the targeted send to `curatorPeerId` SUCCEEDED.
    // Two reasons matter for the broadcast fallback:
    //  - if it succeeded, curator is excluded from broadcast targets
    //    (no point re-sending), and we record it as the trusted
    //    decision sender.
    //  - if it failed (timeout, transient connection drop, response
    //    other than `ok`), curator is INCLUDED in the broadcast so a
    //    second chance over a fresh stream still finds them. The
    //    earlier behaviour skipped curator unconditionally — a single
    //    transient error then meant the request never reached them.
    let curatorTargetedSuccess = false;
    if (curatorPeerId !== this.peerId) {
      try {
        // rc.9 PR-10: substrate send. queued surfaces as a throw
        // (matches the legacy sendToPeer ergonomics so the existing
        // catch path with broadcast fallback still kicks in).
        const sendResult = await this.messenger.sendReliable(
          curatorPeerId,
          PROTOCOL_JOIN_REQUEST,
          payloadBytes,
          { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
        );
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        const responseBytes = sendResult.response;
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        if (response.ok) {
          // Only the explicit invite-supplied curator is recorded as a
          // trusted decision sender — see `isTrustedJoinDecisionSender`
          // for why we won't trust arbitrary broadcast acceptors.
          recordAcceptedBy(curatorPeerId);
          curatorTargetedSuccess = true;
          const alreadyMember = !!response.alreadyMember;
          this.log.info(
            ctx,
            `Forwarded join request for "${contextGraphId}" from ${agentAddress}: 1 curator(s) received (direct${alreadyMember ? ', already-member' : ''})`,
          );
          return { delivered: 1, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
        }
        // Curator was reachable but rejected the request. Log + record
        // the reason so the joiner can see WHY (e.g. "unknown CG"
        // implies the cgId in the invite text is wrong).
        const rejectReason = response.error ?? 'unknown';
        this.log.warn(
          ctx,
          `Targeted join-request to curator ${curatorPeerId.slice(-8)} returned non-ok: ${rejectReason}`,
        );
        if (response.error && response.error !== 'unknown CG') {
          errors.push(`${curatorPeerId.slice(-8)}: ${response.error}`);
        } else if (response.error === 'unknown CG') {
          // Surface "unknown CG" too — silent-filter was hiding the
          // most common invite-text-mismatch failure mode.
          errors.push(`${curatorPeerId.slice(-8)}: unknown CG`);
        }
        // The curator gave us an authoritative answer — no point
        // broadcasting the signed delegation to non-curator peers
        // (PROTOCOL_JOIN_REQUEST handler at dkg-agent.ts:1788 returns
        // `not curator` and does not relay; broadcasting just leaks the
        // delegation payload to unrelated peers without any chance of
        // delivery). Return the rejection now.
        return { delivered: 0, errors };
      } catch (dialErr) {
        // Targeted dial failed — fall through to broadcast WITH curator
        // re-included as a target.
        const msg = dialErr instanceof Error ? dialErr.message : String(dialErr);
        this.log.warn(
          ctx,
          `Targeted join-request dial to curator ${curatorPeerId.slice(-8)} failed: ${msg}`,
        );
        errors.push(`${curatorPeerId.slice(-8)}: dial failed (${msg})`);
      }
    }

    // Reaching here means either (a) `curatorPeerId` was unset (legacy
    // multiaddr invite — broadcast is the only delivery option), or (b)
    // the targeted curator dial threw a transport error and broadcast
    // re-includes curatorPeerId in the cohort as a second chance over a
    // fresh stream. Non-curator peers that receive PROTOCOL_JOIN_REQUEST
    // for a CG they don't curate respond `{ ok: false, error: 'not
    // curator' }` and don't relay (see handler at dkg-agent.ts:1788),
    // so a broader "drop V10 broadcast entirely" cleanup is tracked as
    // a follow-up rather than landed here.
    const peers = this.node.libp2p.getPeers();
    const broadcastTargets = peers
      .map((p) => p.toString())
      .filter((id) => id !== this.peerId && (!curatorTargetedSuccess || id !== curatorPeerId));
    const results = await Promise.allSettled(
      broadcastTargets.map(async (remotePeerId) => {
        // rc.9 PR-10: substrate send. Broadcast queued = treat as
        // failure for this peer (the cohort is parallel — losing one
        // peer is fine, the others may succeed).
        const sendResult = await this.messenger.sendReliable(
          remotePeerId,
          PROTOCOL_JOIN_REQUEST,
          payloadBytes,
          { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
        );
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        const response = JSON.parse(new TextDecoder().decode(sendResult.response));
        return { remotePeerId, response };
      }),
    );
    let delivered = 0;
    let alreadyMember = false;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { remotePeerId, response } = r.value;
      if (response.ok) {
        delivered++;
        // SECURITY: do NOT cache broadcast acceptors as trusted
        // decision senders. Any peer can ack `{ ok: true }` (e.g.
        // because they speak the protocol) — caching them here would
        // let a non-curator peer subsequently forge a join-approved
        // notification and have it accepted (see
        // `isTrustedJoinDecisionSender`). Trust is granted only to
        // the explicit `curatorPeerId` from the invite (above) or
        // to the recorded curator triple in `_meta` (the fallback
        // inside `isTrustedJoinDecisionSender`).
        //
        // The matched curator inside the broadcast cohort can still
        // deliver the decision: the joiner will accept it via the
        // `_meta` curator-triple path once that triple lands locally
        // (curator metadata is gossiped along with the CG itself).
        if (remotePeerId === curatorPeerId) {
          recordAcceptedBy(remotePeerId);
          if (response.alreadyMember) alreadyMember = true;
        }
      } else if (response.error !== 'unknown CG') {
        errors.push(`${remotePeerId.slice(-8)}: ${response.error}`);
      }
    }

    this.log.info(
      ctx,
      `Forwarded join request for "${contextGraphId}" from ${agentAddress}: ${delivered} curator(s) received (broadcast over ${broadcastTargets.length} peer(s)${alreadyMember ? ', already-member' : ''})`,
    );
    return { delivered, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
  }

  /**
   * Check whether a context graph has been registered on-chain.
   */
  async isContextGraphRegistered(contextGraphId: string): Promise<boolean> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered';
  }

  /**
   * OT-RFC-38 / LU-6 Phase B (Codex PR #610 round-2 #5) — cheap
   * preflight for the deferred-registration auto-register-then-
   * publish flow. Returns true iff this agent has at least one
   * locally-owned entity staged in shared memory for the given CG.
   *
   * Used by `memory.ts` to short-circuit BEFORE spending gas on
   * `registerContextGraph` when the publish would have failed anyway
   * (e.g. SWM empty because the agent never wrote, or the user
   * cleared SWM after staging). Pre-fix, the flow registered first
   * and then surfaced a 500 from the publish leg — wasting the
   * registration gas on a publish that couldn't succeed.
   *
   * Note: this only catches the "no local writes" case. Invalid
   * `selection.rootEntities` (referencing entities never staged)
   * still fails inside `publishFromSharedMemory` after register —
   * the cheap preflight here doesn't materialise the selection.
   */
  hasPendingSharedMemoryWrites(contextGraphId: string): boolean {
    const owned = this.workspaceOwnedEntities.get(contextGraphId);
    return owned !== undefined && owned.size > 0;
  }

  async getContextGraphOnChainId(contextGraphId: string): Promise<string | null> {
    const subscribed = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (subscribed) return subscribed;

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const value = result.bindings[0]?.['id'];
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  }

  /**
   * Issue #872 — best-effort read of the on-chain
   * `(accessPolicy, publishPolicy)` enum pair for a CG. Sources, in
   * order:
   *
   *   1. {@link onChainAccessPolicyCache} / {@link onChainPublishPolicyCache} —
   *      populated eagerly by the `ContextGraphCreated` chain-event
   *      handler. The keys are the on-chain numeric ids; if the caller
   *      passed a cleartext local id, we re-key via
   *      {@link subscribedContextGraphs} or {@link getContextGraphOnChainId}.
   *
   *   2. Local `_meta` / ontology triple store for `accessPolicy`
   *      only. The CG creator also persists `dkg:publishPolicy` in
   *      `_meta` at create time, but that triple is not updated by
   *      `updatePublishPolicy`, so it is never used as an
   *      authorization-positive publish-policy answer here.
   *
   *   3. Direct chain RPC (Codex round-3 fix): for registered CGs
   *      where the cache leaves `publishPolicy` undefined/stale, or
   *      where steps 1 and 2 still leave `accessPolicy` undefined,
   *      query the contract directly via
   *      `chain.getContextGraphAccessPolicy` /
   *      `chain.getContextGraphPublishPolicy`. The result populates
   *      the in-memory cache so subsequent calls don't re-query.
   *
   * Steps 2 and 3 are GATED on {@link isContextGraphRegistered}
   * (Codex round-2 fix): unregistered locally-created CGs reflect
   * create-time *intent* via local triples, not an on-chain
   * commitment, and the chain itself has no record. Treating local
   * source as authoritative pre-registration would bypass the
   * owner-guard on a CG the curator hasn't actually committed to.
   *
   * Returns `{}` (both fields `undefined`) when neither source has an
   * answer. Callers MUST treat `undefined` fields as unknown — fail
   * closed for policy-gated decisions rather than assuming a
   * permissive default. Failures in the chain RPC fallback (RPC
   * unavailable, contract not deployed, transient errors) are logged
   * and the field is left undefined.
   */
  async getContextGraphOnChainPolicy(contextGraphId: string): Promise<{
    accessPolicy?: number;
    publishPolicy?: number;
  }> {
    let accessPolicy = this.onChainAccessPolicyCache.get(contextGraphId);
    // Codex review on #872 — `publishPolicy` is mutable on-chain
    // (`PublishPolicyUpdated`) but the cache is only seeded by
    // `ContextGraphCreated`. Treat entries older than
    // `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` as stale so the chain-RPC
    // fallback below re-verifies before the caller relaxes the
    // import-artifact owner guard. The accessPolicy cache is left
    // untouched here: it's also used by SWM gossip authorization paths
    // (lines ~1779, ~8403, ~10073) where stale-permissive cannot
    // escalate privilege (gossip decrypt is gated by sender-key
    // issuance) and stale-restrictive only causes a transient deny.
    const isPublishPolicyCacheFresh = (key: string): boolean => {
      const fetchedAt = this.onChainPublishPolicyCacheUpdatedAt.get(key);
      if (fetchedAt === undefined) return false;
      return Date.now() - fetchedAt <= ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS;
    };
    let publishPolicy = isPublishPolicyCacheFresh(contextGraphId)
      ? this.onChainPublishPolicyCache.get(contextGraphId)
      : undefined;
    // Track the resolved numeric on-chain id so we can both look it
    // up in the cache (round-2) and use it as the chain-RPC fallback
    // key (round-3). Lazily resolved — creators may pass the
    // numeric id directly in which case no extra SPARQL is needed.
    let onChainId: string | undefined;

    if (accessPolicy === undefined || publishPolicy === undefined) {
      onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
        ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
        ?? undefined;
      if (onChainId && onChainId !== contextGraphId) {
        if (accessPolicy === undefined) accessPolicy = this.onChainAccessPolicyCache.get(onChainId);
        if (publishPolicy === undefined && isPublishPolicyCacheFresh(onChainId)) {
          publishPolicy = this.onChainPublishPolicyCache.get(onChainId);
        }
      }
    }

    // Codex review (round 2, finding B): the local access-policy
    // fallback below reads triples that `createContextGraph` writes
    // synchronously — BEFORE
    // `registerContextGraph` confirms the CG on-chain. For a CG
    // that's still in the local-only `unregistered` state, those
    // triples reflect the creator's *intent*, not an on-chain
    // commitment. Treating them as authoritative would let the read
    // relaxation kick in for a CG the curator hasn't actually
    // committed to making public, bypassing the owner guard.
    //
    // Codex review (round 6, line 15487 — 2026-06-01): the prior gate
    // only consulted `dkg:registrationStatus = "registered"`, which
    // `registerContextGraph` writes ON THE CREATOR'S NODE only. Non-
    // creator peers bootstrap CG metadata via `ensureContextGraphLocally`
    // with status="unregistered" and never flip it. After a daemon
    // restart the chain-event cache loses its in-memory entries, the
    // status check still returns false, this gate fails closed, and
    // cross-agent reads on legitimately public+open CGs regress to
    // 403 for non-creators.
    //
    // Accept any of these as proof of an on-chain commitment:
    //   - `dkg:registrationStatus = "registered"` (creator path), OR
    //   - a non-zero numeric `onChainId` already resolved from
    //     subscribed state or local meta (replicator path — the
    //     on-chain id is only ever known if the chain assigned it).
    //
    // An unregistered locally-created CG has neither, so the gate
    // still fails closed for it.
    if (accessPolicy === undefined || publishPolicy === undefined) {
      const registeredViaStatus = await this.isContextGraphRegistered(contextGraphId).catch(() => false);
      let registeredViaOnChainId = false;
      if (!registeredViaStatus) {
        if (onChainId === undefined) {
          onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
            ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
            ?? undefined;
        }
        if (onChainId) {
          try {
            registeredViaOnChainId = BigInt(onChainId) > 0n;
          } catch {
            registeredViaOnChainId = false;
          }
        }
      }
      if (!registeredViaStatus && !registeredViaOnChainId) {
        return {
          ...(accessPolicy === 0 || accessPolicy === 1 ? { accessPolicy } : {}),
          ...(publishPolicy === 0 || publishPolicy === 1 ? { publishPolicy } : {}),
        };
      }
    }

    if (accessPolicy === undefined) {
      const stored = await this.readLocalAccessPolicyEnum(contextGraphId).catch(() => undefined);
      if (stored !== undefined) accessPolicy = stored;
    }

    // Codex review (round 3): non-creator peers never receive the
    // `dkg:publishPolicy` triple — it's only written to local
    // `_meta` on the creator's node. They observe the chain event
    // at subscribe time which populates the in-memory caches above,
    // but those caches are lost on daemon restart. Without a
    // durable replicated source, `publishPolicy` permanently
    // disappears for non-creator peers once the chain poller's
    // replay window rolls past the create block — which makes
    // `isPublicOpenContextGraph()` return false and cross-agent
    // `/import-artifact/*` reads regress to 403 on legitimately
    // public + open CGs.
    //
    // Fall back to a direct chain RPC for the missing fields. The
    // fallback is gated on `registered === true` above so an
    // unregistered local-only CG cannot poison the answer; the
    // chain itself is the authoritative source. Failures (RPC
    // unavailable, contract not deployed, transient errors) leave
    // the field undefined and the daemon route falls back to the
    // strict guard — fail-closed.
    if (
      (accessPolicy === undefined || publishPolicy === undefined)
      && this.chain
    ) {
      if (onChainId === undefined) {
        onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
          ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
          ?? undefined;
      }
      let numericId: bigint | undefined;
      if (onChainId) {
        try {
          const parsed = BigInt(onChainId);
          if (parsed > 0n) numericId = parsed;
        } catch {
          numericId = undefined;
        }
      }
      if (numericId !== undefined) {
        const rpcCtx = createOperationContext('resolve');
        // Round-4 fix: bound each chain-RPC call so an unreachable
        // RPC stack (every endpoint returning 429 / hanging on
        // connect) cannot block the caller past the daemon-ready
        // budget. The fallback is an optimisation — failing fast
        // and returning undefined is correct (fail-closed via the
        // strict guard at the route layer). 2.5s is tight enough
        // to stay well under the 45s daemon-ready budget even when
        // both fallbacks fire back-to-back, while still allowing a
        // single slow eth_call hop to succeed under normal load.
        const CHAIN_RPC_FALLBACK_TIMEOUT_MS = 2_500;
        const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T | typeof TIMEOUT_SENTINEL> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
            timer = setTimeout(() => {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.${label}(${onChainId}) timed out after ${CHAIN_RPC_FALLBACK_TIMEOUT_MS}ms — treating as UNKNOWN (fail-closed)`,
              );
              resolve(TIMEOUT_SENTINEL);
            }, CHAIN_RPC_FALLBACK_TIMEOUT_MS);
            // Allow node to exit even if the chain promise never
            // settles (test scenario: dead RPC + fake daemon).
            timer.unref?.();
          });
          return Promise.race([
            p.finally(() => { if (timer) clearTimeout(timer); }),
            timeout,
          ]);
        };
        if (publishPolicy === undefined) {
          const getPublishPolicy = this.chain.getContextGraphPublishPolicy;
          if (typeof getPublishPolicy === 'function') {
            try {
              const result = await withTimeout(
                getPublishPolicy.call(this.chain, numericId),
                'getContextGraphPublishPolicy',
              );
              if (result !== TIMEOUT_SENTINEL) {
                const pp = result?.publishPolicy;
                if (pp === 0 || pp === 1) {
                  publishPolicy = pp;
                  this.onChainPublishPolicyCache.set(onChainId!, pp);
                  this.onChainPublishPolicyCacheUpdatedAt.set(onChainId!, Date.now());
                }
              }
            } catch (err) {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.getContextGraphPublishPolicy(${onChainId}) failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        if (accessPolicy === undefined) {
          const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
          if (typeof getAccessPolicy === 'function') {
            try {
              const ap = await withTimeout(
                getAccessPolicy.call(this.chain, numericId),
                'getContextGraphAccessPolicy',
              );
              if (ap !== TIMEOUT_SENTINEL && (ap === 0 || ap === 1)) {
                accessPolicy = ap;
                this.onChainAccessPolicyCache.set(onChainId!, ap);
              }
            } catch (err) {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.getContextGraphAccessPolicy(${onChainId}) failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }

    return {
      ...(accessPolicy === 0 || accessPolicy === 1 ? { accessPolicy } : {}),
      ...(publishPolicy === 0 || publishPolicy === 1 ? { publishPolicy } : {}),
    };
  }

  /**
   * Issue #872 — read the persisted `dkg:accessPolicy` literal from
   * the ontology graph (open CGs) or `_meta` (curated CGs) and map it
   * back to the on-chain enum (`"public"` → `0`, `"private"` → `1`).
   * Returns `undefined` when no triple is present locally. Used by
   * {@link getContextGraphOnChainPolicy} as a fallback after the
   * chain-event cache miss.
   */
  private async readLocalAccessPolicyEnum(contextGraphId: string): Promise<number | undefined> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return undefined;
    }
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy } }
        UNION
        { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy } }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    const raw = result.bindings[0]?.['policy'];
    if (typeof raw !== 'string') return undefined;
    const stripped = raw.replace(/^"|"$/g, '');
    if (stripped === 'public') return 0;
    if (stripped === 'private') return 1;
    return undefined;
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — read create-time `publishPolicy` and
   * `publishAuthorityAccountId` persisted by `createContextGraph`.
   * Returns `{}` when neither is set, mirroring the existing
   * "register-time-only knobs are undefined" behaviour for legacy CGs
   * created before this PR landed.
   *
   * Consumed by the deferred-registration auto-register call in the
   * VM-publish daemon route (`memory.ts`) to preserve the user's
   * create-time choice instead of silently falling back to the
   * access-policy-derived default. Codex PR #610 fd5b31f1 follow-up.
   */
  async getStoredContextGraphRegistrationOptions(contextGraphId: string): Promise<{
    publishPolicy?: number;
    publishAuthorityAccountId?: bigint;
  }> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?pp ?paa WHERE { GRAPH <${cgMetaGraph}> {
        OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PUBLISH_POLICY}> ?pp }
        OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PUBLISH_AUTHORITY_ACCOUNT_ID}> ?paa }
      } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return {};
    const row = result.bindings[0] ?? {};
    const out: { publishPolicy?: number; publishAuthorityAccountId?: bigint } = {};
    const rawPp = row['pp'];
    if (typeof rawPp === 'string') {
      const stripped = rawPp.replace(/^"|"$/g, '');
      const n = Number(stripped);
      if (n === 0 || n === 1) out.publishPolicy = n;
    }
    const rawPaa = row['paa'];
    if (typeof rawPaa === 'string') {
      const stripped = rawPaa.replace(/^"|"$/g, '');
      try {
        const v = BigInt(stripped);
        if (v > 0n) out.publishAuthorityAccountId = v;
      } catch { /* not a valid bigint literal — skip */ }
    }
    return out;
  }

  /**
   * Get the peer allowlist for a context graph (if curated).
   * Returns null if no allowlist is set (open CG).
   */
  async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.replace(/^"|"$/g, ''));
  }

  // ── Sub-Graph Management ───────────────────────────────────────────────

  /**
   * Create a named sub-graph within a context graph.
   * Registers it in the CG's `_meta` graph and creates the named graph in storage.
   * Sub-graphs use convention-based URI partitioning — no on-chain enforcement in V10.0.
   *
   * V10.0 replication behavior:
   * - Registration triples are stored locally by the admin. Peers also auto-register
   *   sub-graphs on gossip publish, SWM write, and finalization replay paths:
   *   `gossip-publish-handler.ts`, `workspace-handler.ts`, and
   *   `finalization-handler.ts` call `ensureSubGraph()` and backfill the full
   *   `_meta` registration when it is missing.
   * - Because `subGraphName` is carried on the wire (in the workspace publish request
   *   and the N-Quads' named-graph field), replicated data is routed into the correct
   *   sub-graph named graph on receiving nodes — not into the root data graph.
   * - On-chain contracts are unaware of sub-graphs; enforcement remains convention-based.
   */
  async createSubGraph(contextGraphId: string, subGraphName: string, opts?: {
    description?: string;
    authorizedWriters?: string[];
  }): Promise<{ uri: string }> {
    const { validateSubGraphName, contextGraphSubGraphUri: sgUri } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) throw new Error(`Context graph "${contextGraphId}" does not exist`);

    const gm = new GraphManager(this.store);
    const uri = sgUri(contextGraphId, subGraphName);

    // Idempotency: check if already registered before inserting
    const existing = await this.listSubGraphs(contextGraphId);
    if (existing.some(sg => sg.name === subGraphName)) {
      this.log.info(
        createOperationContext('system'),
        `Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" → ${uri}`,
      );
      return { uri };
    }

    const { generateSubGraphRegistration } = await import('@origintrail-official/dkg-publisher');
    const registrationQuads = generateSubGraphRegistration({
      contextGraphId,
      subGraphName,
      createdBy: this.peerId,
      authorizedWriters: opts?.authorizedWriters,
      description: opts?.description,
      timestamp: new Date(),
    });

    await gm.ensureSubGraph(contextGraphId, subGraphName);
    await this.store.insert(registrationQuads);

    this.log.info(
      createOperationContext('system'),
      `Created sub-graph "${subGraphName}" in context graph "${contextGraphId}" → ${uri}`,
    );
    return { uri };
  }

  /**
   * List registered sub-graphs for a context graph.
   * Queries the CG's `_meta` graph for `dkg:SubGraph` registrations.
   */
  async listSubGraphs(contextGraphId: string): Promise<Array<{
    uri: string;
    name: string;
    createdBy: string;
    createdAt?: string;
    description?: string;
  }>> {
    const { subGraphDiscoverySparql } = await import('@origintrail-official/dkg-publisher');
    const sparql = subGraphDiscoverySparql(contextGraphId);
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];
    return result.bindings.map(row => ({
      uri: row['subGraph'] ?? '',
      name: stripLiteral(row['name'] ?? ''),
      createdBy: row['createdBy'] ?? '',
      createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
      description: row['description'] ? stripLiteral(row['description']) : undefined,
    }));
  }

  /**
   * Remove a sub-graph registration from `_meta` and drop its named graphs.
   * Does NOT delete on-chain data — this is a local bookkeeping operation.
   */
  async removeSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    const { validateSubGraphName } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const gm = new GraphManager(this.store);

    const { subGraphDeregistrationSparql } = await import('@origintrail-official/dkg-publisher');
    try {
      await this.store.query(subGraphDeregistrationSparql(contextGraphId, subGraphName));
    } catch {
      // SPARQL DELETE WHERE may not be supported — delete quads manually
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
      await this.store.deleteByPattern({ graph: metaGraph, subject: subGraphUri });
    }

    const dataUri = gm.subGraphUri(contextGraphId, subGraphName);
    const metaUri = gm.subGraphMetaUri(contextGraphId, subGraphName);
    const privateUri = gm.subGraphPrivateUri(contextGraphId, subGraphName);
    const swmUri = gm.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaUri = gm.sharedMemoryMetaUri(contextGraphId, subGraphName);
    for (const uri of [dataUri, metaUri, privateUri, swmUri, swmMetaUri]) {
      try { await this.store.dropGraph(uri); } catch { /* graph may not exist */ }
    }

    // Drop assertion graphs under the sub-graph prefix
    const sgPrefix = `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`;
    const allGraphs = await this.store.listGraphs();
    for (const g of allGraphs) {
      if (g.startsWith(sgPrefix)) {
        try { await this.store.dropGraph(g); } catch { /* graph may not exist */ }
      }
    }

    // Clear SWM ownership cache for this sub-graph
    const ownershipKey = `${contextGraphId}\0${subGraphName}`;
    this.publisher.clearSubGraphOwnership(ownershipKey);

    this.log.info(
      createOperationContext('system'),
      `Removed sub-graph "${subGraphName}" from context graph "${contextGraphId}"`,
    );
  }

  /**
   * Idempotent "ensure" variant of createContextGraph for boot-time defaults.
   * If the context graph already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples. No on-chain registration
   * — use {@link registerContextGraph} for that.
   *
   * For curated CGs (detected by access policy in existing triples, or by the
   * caller passing `curated: true`), definition triples are written to the CG's
   * own `_meta` graph — never to ONTOLOGY — so they don't leak to the network.
   */
  async ensureContextGraphLocal(opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      // Bootstrap is a subscriber path: do NOT mint or backfill ownership
      // here. Creator/curator are stamped by `createContextGraph` (explicit
      // create) and `registerContextGraph` (explicit on-chain mint). When
      // every node backfilled itself on boot the `_meta` graph accumulated
      // one curator triple per node and `getContextGraphOwner`'s
      // `LIMIT 1` made ownership nondeterministic — any subscriber could
      // win the unordered query and look like the curator.
      this.subscribeToContextGraph(opts.id);
      this.setContextGraphSubscription(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        metaSynced: true,
        onChainId: this.subscribedContextGraphs.get(opts.id)?.onChainId,
      });
      return;
    }

    const gm = new GraphManager(this.store);
    const contextGraphUri = contextGraphDataGraphUri(opts.id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    // Curated CGs write definition triples to _meta so they stay invisible
    // to other nodes that sync ONTOLOGY. Open CGs go to ONTOLOGY for
    // network-wide discovery.
    const defGraph = opts.curated ? cgMetaGraph : ontologyGraph;

    // No creator/curator triples here — bootstrap is a subscriber-style
    // path. Ownership is established only when a node explicitly calls
    // `createContextGraph` (UI flow) or `registerContextGraph` (on-chain
    // mint), which both stamp the calling node. Stamping every booting
    // node would let `getContextGraphOwner` ("LIMIT 1" over `dkg:curator`)
    // resolve to an arbitrary subscriber and create a registration race
    // where node B mints a second V10 CG before node A's `onChainId`
    // propagates.
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${opts.curated ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // _meta triples: only registration status. `dkg:curator` is written
    // by `registerContextGraph` (or `createContextGraph` for the UI
    // create path) so exactly one node owns the graph locally.
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
    );

    if (opts.description) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    await this.store.insert(quads);
    await gm.ensureContextGraph(opts.id);

    this.subscribeToContextGraph(opts.id);
    this.setContextGraphSubscription(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    this.log.info(ctx, `Ensured context graph "${opts.id}" locally (${opts.curated ? 'curated' : 'open'})`);
  }

  private async resolveEndorsementTrustTargets(
    contextGraphId: string,
    targetUalOrRoot: string,
  ): Promise<string[]> {
    assertSafeIri(targetUalOrRoot);
    const dataGraph = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    const target = `<${targetUalOrRoot}>`;
    const namespaces = ['http://dkg.io/ontology/', 'https://dkg.network/ontology#'];
    const existsPatterns = [
      `GRAPH <${dataGraph}> { ${target} ?p ?o } BIND(${target} AS ?hit)`,
      `GRAPH <${metaGraph}> { ${target} ?p ?o } BIND(${target} AS ?hit)`,
      ...namespaces.flatMap((ns) => [
        `GRAPH <${metaGraph}> { ?ka <${ns}rootEntity> ${target} } BIND(${target} AS ?hit)`,
        `GRAPH <${metaGraph}> { ?ka <${ns}partOf> ${target} } BIND(?ka AS ?hit)`,
      ]),
    ];

    const exists = await this.store.query(
      `SELECT ?hit WHERE { ${existsPatterns.map((p) => `{ ${p} }`).join(' UNION ')} } LIMIT 1`,
    );
    if (exists.type !== 'bindings' || exists.bindings.length === 0) {
      throw new Error(
        `Endorsement target ${targetUalOrRoot} was not found in context graph ${contextGraphId}`,
      );
    }

    const rootPatterns = namespaces.flatMap((ns) => [
      `GRAPH <${metaGraph}> { ${target} <${ns}rootEntity> ?root . }`,
      `GRAPH <${metaGraph}> { ?ka <${ns}partOf> ${target} ; <${ns}rootEntity> ?root . }`,
    ]);
    const roots = await this.store.query(
      `SELECT DISTINCT ?root WHERE { ${rootPatterns.map((p) => `{ ${p} }`).join(' UNION ')} }`,
    );
    const rootEntities = roots.type === 'bindings'
      ? (roots.bindings as Record<string, string>[]).map((row) => row.root).filter(Boolean)
      : [];
    return rootEntities.length > 0 ? rootEntities : [targetUalOrRoot];
  }

  private async stampTrustLevel(
    graph: string,
    subjects: Iterable<string>,
    level: TrustLevel,
  ): Promise<void> {
    const quads = buildTrustLevelQuads(subjects, level, graph) as Quad[];
    for (const quad of quads) {
      await this.store.deleteByPattern({
        graph: quad.graph,
        subject: quad.subject,
        predicate: TRUST_LEVEL_PREDICATE,
      });
    }
    if (quads.length > 0) {
      await this.store.insert(quads);
    }
  }

  private async getSubjectsForRoots(graph: string, roots: Iterable<string>): Promise<string[]> {
    const safeGraph = assertSafeIri(graph);
    const rootEntities = [...new Set([...roots].filter(Boolean))];
    if (rootEntities.length === 0) return [];
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${sparqlString(e)} || STRSTARTS(STR(?s), ${sparqlString(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${safeGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    const subjects = new Set(rootEntities);
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        if (row.s) subjects.add(row.s);
      }
    }
    return [...subjects];
  }

  // ── ENDORSE ─���────────────────────────────────────────────────────────

  /**
   * Endorse a published Knowledge Asset. Publishes a `dkg:endorses` triple
   * to the Context Graph's data graph. Endorsements ride regular PUBLISH
   * batches — no separate chain transaction required.
   */
  async endorse(opts: {
    contextGraphId: string;
    knowledgeAssetUal: string;
    agentAddress?: string;
  }): Promise<PublishResult> {
    const { buildEndorsementQuads } = await import('./endorse.js');
    // A-12: spec §03 / §22 require the endorser DID to be the
    // Ethereum-address form. Passing a libp2p peer id here produced
    // a `did:dkg:agent:${peerId}` URI (12D3KooW-prefixed in practice),
    // which is non-spec. Prefer the per-call agentAddress, then the
    // node's default agent address, then fall back to the peer id
    // only if no EVM identity is known (kept for backward
    // compatibility with test harnesses; runtime always has a
    // defaultAgentAddress after auto-registration).
    //
    // A-12 review: normalise the address casing through
    // `canonicalAgentDidSubject` so the endorsement DID converges
    // with the profile DID for the same wallet (checksum vs
    // lowercase inputs previously produced two distinct RDF
    // subjects). Callers must also verify the address is owned by
    // this node before calling — /api/endorse does that via the
    // bearer token; see packages/cli/src/daemon.ts.
    const raw = opts.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const endorser = canonicalAgentDidSubject(raw);
    const trustTargets = await this.resolveEndorsementTrustTargets(
      opts.contextGraphId,
      opts.knowledgeAssetUal,
    );
    const quads = buildEndorsementQuads(
      endorser,
      opts.knowledgeAssetUal,
      opts.contextGraphId,
    );
    const result = await this.publish(opts.contextGraphId, quads);
    if (result.status === 'confirmed') {
      const dataGraph = contextGraphDataGraphUri(opts.contextGraphId);
      await this.stampTrustLevel(
        dataGraph,
        await this.getSubjectsForRoots(dataGraph, trustTargets),
        TrustLevel.Endorsed,
      );
    }
    return result;
  }

  // ── VERIFY ────────────────────────────────────────────────────────

  /**
   * Propose verification for a published batch: collect M-of-N approvals,
   * anchor on-chain, and promote triples to Verified Memory.
   */
  async verify(opts: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: bigint;
    requiredSignatures?: number;
    timeoutMs?: number;
  }): Promise<{
    txHash?: string;
    blockNumber?: number;
    verifiedMemoryId: string;
    signers: string[];
    status: 'verified' | 'partial' | 'no_quorum';
    trustLevel: TrustLevel;
  }> {
    const ctx = createOperationContext('verify');

    // 1. Look up batch merkle root from local metadata (use typed literal for batchId)
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(opts.contextGraphId));
    const dkgNamespaces = ['http://dkg.io/ontology/', 'https://dkg.network/ontology#'];
    // Try typed literal first, fallback to untyped for backward compat.
    let batchBindings: Record<string, string>[] | null = null;
    for (const ns of dkgNamespaces) {
      for (const literal of [`"${opts.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${opts.batchId}"`]) {
        const r = await this.store.query(
          `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <${ns}merkleRoot> ?root . ?kc <${ns}batchId> ${literal} } } LIMIT 1`,
        );
        if (r.type === 'bindings' && r.bindings.length > 0) {
          batchBindings = r.bindings as Record<string, string>[];
          break;
        }
      }
      if (batchBindings) break;
    }
    if (!batchBindings) {
      throw new Error(`Batch ${opts.batchId} not found in context graph ${opts.contextGraphId}`);
    }
    const rootHex = batchBindings[0]['root'];
    const merkleRootValue = /^"([^"]+)"/.exec(rootHex)?.[1] ?? rootHex;
    const merkleRoot = ethers.getBytes(
      merkleRootValue.startsWith('0x') ? merkleRootValue : `0x${merkleRootValue}`,
    );

    // 2. Look up context graph on-chain config
    const onChainId = await this.getContextGraphOnChainId(opts.contextGraphId);
    const contextGraphIdOnChain = onChainId ? BigInt(onChainId) : null;
    if (!contextGraphIdOnChain) {
      throw new Error(`Context graph ${opts.contextGraphId} not found on-chain`);
    }

    // 3. Determine ACK quorum.
    // LU-2: per SPEC_CG_MEMORY_MODEL there is no per-CG `requiredSignatures`
    // — every CG uses the system parameter
    // `parametersStorage.minimumRequiredSignatures()`. An explicit caller
    // override (`opts.requiredSignatures`) wins for advisory/test paths
    // (e.g. `/api/verify?requiredSignatures=...`); otherwise we read the
    // system param off-chain via the adapter accessor.
    //
    // FAIL-CLOSED (Codex PR #595 round-3): `chain.verify()` only calls
    // `registerKnowledgeAsset()` — it does NOT submit the collected
    // signatures on-chain. This local quorum check is therefore the
    // *only* enforcement gate. If the chain adapter can't tell us the
    // system minimum (RPC outage, missing method, invalid value), we
    // must NOT silently downgrade to quorum=1 — that's fail-open. We
    // throw with an actionable error pointing the caller at the
    // explicit override knob instead.
    let requiredSignatures = opts.requiredSignatures ?? 0;
    if (requiredSignatures === 0) {
      if (typeof this.chain.getMinimumRequiredSignatures !== 'function') {
        throw new Error(
          'Cannot determine ACK quorum for verify: chain adapter does not implement `getMinimumRequiredSignatures()`. ' +
          'Pass `opts.requiredSignatures` explicitly (advisory paths only) or use a chain adapter that supports the system-parameter lookup.',
        );
      }
      let sysMin: number;
      try {
        sysMin = await this.chain.getMinimumRequiredSignatures();
      } catch (err: any) {
        throw new Error(
          `Cannot determine ACK quorum for verify: getMinimumRequiredSignatures() failed (${err?.message ?? err}). ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter connection.`,
        );
      }
      if (!Number.isInteger(sysMin) || sysMin < 1) {
        throw new Error(
          `Cannot determine ACK quorum for verify: getMinimumRequiredSignatures() returned invalid value ${sysMin} (must be a positive integer). ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter.`,
        );
      }
      requiredSignatures = sysMin;
    }

    // 4. Sign the verify digest as proposer
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (!signerKey) throw new Error('No signer key available for verify');

    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(signerKey);
    const proposerSig = signingKey.sign(prefixedHash);
    const proposerAddress = ethers.computeAddress(signingKey.publicKey);

    // 5. Collect M-of-N approvals
    // SPEC_CG_MEMORY_MODEL §4.3: sharding-table membership is the only
    // authoritative gate for who can ACK a VM publish. Adapters that
    // don't implement the membership probe are a misconfiguration here
    // (real EVM and the in-tree mock both implement it). Cache decisions
    // per batch to avoid hammering the RPC for repeated approvers.
    if (typeof this.chain.isShardingTableMember !== 'function') {
      throw new Error(
        'verify: chain adapter does not implement `isShardingTableMember()`. ' +
        'Cannot enforce SPEC_CG_MEMORY_MODEL §4.3 sharding-table ACK eligibility — refusing fail-open.',
      );
    }
    const shardingMembershipCache = new Map<string, boolean>();
    const probeShardingTableMembership = async (identityId: bigint): Promise<boolean> => {
      if (identityId <= 0n) return false;
      const key = identityId.toString();
      const cached = shardingMembershipCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const ok = await this.chain.isShardingTableMember!(identityId);
        shardingMembershipCache.set(key, ok);
        return ok;
      } catch (err: any) {
        this.log.warn(
          ctx,
          `[verify] isShardingTableMember(${identityId}) probe failed (${err?.message ?? err}); ` +
          `dropping that signer's approval as fail-closed`,
        );
        shardingMembershipCache.set(key, false);
        return false;
      }
    };

    // Proposer eligibility computed BEFORE collect() so VerifyCollector
    // can require the full `requiredSignatures` remote ACKs (instead of
    // `requiredSignatures - 1`) when the proposer can't self-count.
    // Edge nodes have identityId=0 and aren't in the sharding table, so
    // they always need every ACK to come from a member peer.
    const proposerEligible =
      this.identityId > 0n && await probeShardingTableMembership(this.identityId);

    const collector = new VerifyCollector({
      // rc.9 PR-11: route through messenger.sendReliable so
      // /dkg/10.0.1/verify-proposal gets envelope wrap + sender-side
      // idempotency. App-level fan-out via VerifyCollector is
      // unchanged; queued is treated as a per-peer failure (caller
      // moves on to the next peer; substrate keeps the queued entry
      // in the outbox for diagnostics).
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const sendResult = await this.messenger.sendReliable(peerId, protocol, data);
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        return sendResult.response;
      },
      // Codex PR #608: previously fanned out to ALL connected libp2p
      // peers, which broadcast `rootEntities` (subject URIs of the
      // batch) on EVERY verify proposal — a privacy regression for
      // invite-only CGs where those URIs are part of the curated
      // payload. The fix is two-tier:
      //   1. Curated CGs (peer-allowlist OR agent-gated): only fan out
      //      to peers in `cgMemberEnumerator.enumerate(cg).members`,
      //      which mirrors the same authority the SWM data-plane uses.
      //      For agent-gated CGs without a peer allowlist, that returns
      //      `{ source: 'none', members: [] }` (fail-closed) — verify
      //      then has no remote recipients and `allowPartial: true` lets
      //      the proposer collect its own self-attestation as the only
      //      vote, which is correct: only members can verify a curated
      //      batch's plaintext root anyway.
      //   2. Public CGs: fall back to the gossip-eligible member set
      //      (live topic subscribers), which still narrows the broadcast
      //      versus "every connected libp2p peer".
      // Downstream `probeShardingTableMembership` continues to filter
      // approvals by sharding-table membership before they count toward
      // quorum, so this only changes WHO RECEIVES the proposal, not
      // who can vote.
      getParticipantPeers: async (contextGraphId: string) => {
        try {
          const enumeration = await this.getOrCreateCGMemberEnumerator().enumerate(contextGraphId);
          return enumeration.members.filter((id) => id !== this.peerId);
        } catch (err) {
          // Degrade gracefully: if enumeration fails (e.g. SPARQL
          // backend hiccup) we don't want to silently broadcast to
          // every connected peer (the leak we just plugged). Log and
          // return empty so `allowPartial: true` lets the proposer
          // proceed with just its self-attestation rather than
          // leaking via a fail-open fallback.
          this.log.warn(
            ctx,
            `[verify] CG-member enumeration failed for ${contextGraphId} — broadcasting to no remote peers ` +
            `(prevents fail-open leak of rootEntities). Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      },
      log: (msg: string) => this.log.info(ctx, msg),
    });

    const entities = await this.getRootEntities(opts.contextGraphId, opts.batchId);

    const result = await collector.collect({
      contextGraphId: opts.contextGraphId,
      contextGraphIdOnChain,
      verifiedMemoryId: (() => {
        try { return BigInt(opts.verifiedMemoryId); }
        catch { throw new Error(`verifiedMemoryId must be a numeric string, got: "${opts.verifiedMemoryId}"`); }
      })(),
      batchId: opts.batchId,
      merkleRoot,
      entities,
      proposerSignature: { r: ethers.getBytes(proposerSig.r), vs: ethers.getBytes(proposerSig.yParityAndS) },
      requiredSignatures,
      proposerCountsTowardQuorum: proposerEligible,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min default; VerifyCollector also enforces this as its max.
      allowPartial: true,
    });

    // 6. Resolve identity IDs for each approver before on-chain submission.
    const resolvedSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [];
    const resolvedSignerAddresses: string[] = [];
    if (proposerEligible) {
      resolvedSignatures.push({
        identityId: this.identityId,
        r: ethers.getBytes(proposerSig.r),
        vs: ethers.getBytes(proposerSig.yParityAndS),
      });
      resolvedSignerAddresses.push(proposerAddress);
    }
    for (const a of result.approvals) {
      let id = a.identityId || await this.resolveVerifyApprovalIdentityId(a.approverAddress);
      if (!id || id === 0n) continue;
      if (!(await probeShardingTableMembership(id))) continue;
      resolvedSignatures.push({ identityId: id, r: a.signatureR, vs: a.signatureVS });
      resolvedSignerAddresses.push(a.approverAddress);
    }
    if (!result.quorumReached || resolvedSignatures.length < requiredSignatures) {
      // Trust degradation: any remote sharding-table-eligible ACK we
      // collected (i.e. any signer past the proposer slot) lifts the
      // batch to PartiallyVerified; otherwise it's self-attested.
      const remoteCount = resolvedSignatures.length - (proposerEligible ? 1 : 0);
      const trustLevel = remoteCount > 0
        ? TrustLevel.PartiallyVerified
        : TrustLevel.SelfAttested;
      const status = remoteCount > 0 ? 'partial' : 'no_quorum';
      await this.stampBatchTrustLevel(
        opts.contextGraphId,
        opts.batchId,
        contextGraphDataGraphUri(opts.contextGraphId),
        trustLevel,
      );
      this.log.info(
        ctx,
        `Verify batch ${opts.batchId} did not reach quorum ` +
          `(${resolvedSignatures.length}/${requiredSignatures} sharding-table-eligible signers, ` +
          `${remoteCount}/${result.requiredRemoteApprovals} remote approvals) — ` +
          `stamped trustLevel=${trustLevel} without chain tx`,
      );
      return {
        verifiedMemoryId: opts.verifiedMemoryId,
        signers: resolvedSignerAddresses,
        status,
        trustLevel,
      };
    }

    // 7. Submit on-chain only after quorum. Partial writes above are
    // metadata-only and deliberately do not claim a transaction hash.
    let txResult: { hash: string; blockNumber: number };
    const existingContextGraphId = typeof this.chain.getKAContextGraphId === 'function'
      ? await this.chain.getKAContextGraphId(opts.batchId).catch(() => 0n)
      : 0n;
    if (existingContextGraphId === contextGraphIdOnChain) {
      const provenance = await this.getBatchChainProvenance(opts.contextGraphId, opts.batchId);
      if (!provenance) {
        throw new Error(`Batch ${opts.batchId} is already registered on-chain but local chain provenance is missing`);
      }
      txResult = provenance;
      this.log.info(
        ctx,
        `Verify batch ${opts.batchId} already registered on-chain for context graph ${contextGraphIdOnChain}; ` +
          `using publish tx ${txResult.hash.slice(0, 16)}... for ConsensusVerified metadata`,
      );
    } else {
      if (typeof this.chain.verify !== 'function') {
        throw new Error('Chain adapter does not support verify');
      }
      txResult = await this.chain.verify({
        contextGraphId: contextGraphIdOnChain,
        batchId: opts.batchId,
        merkleRoot,
        signerSignatures: resolvedSignatures,
      });
    }

    // 8. Promote triples to Verified Memory (only include signers actually sent on-chain)
    await this.promoteToVerifiedMemory(
      opts.contextGraphId,
      opts.verifiedMemoryId,
      opts.batchId,
      txResult.hash,
      txResult.blockNumber,
      resolvedSignerAddresses,
    );

    this.log.info(ctx, `Verified batch ${opts.batchId} → _verified_memory/${opts.verifiedMemoryId} (tx=${txResult.hash.slice(0, 16)}...)`);

    return {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber,
      verifiedMemoryId: opts.verifiedMemoryId,
      signers: resolvedSignerAddresses,
      status: 'verified',
      trustLevel: TrustLevel.ConsensusVerified,
    };
  }

  private async resolveVerifyApprovalIdentityId(approverAddress: string): Promise<bigint> {
    // Post-SPEC_CG_MEMORY_MODEL: identity resolution is whatever the
    // chain adapter exposes via `getIdentityIdForAddress`. The legacy
    // candidate-set probe against per-CG `participantIdentityId`
    // triples was a pre-LU2 affordance and has been removed (Codex
    // PR #595 round-5: stop using legacy roster as a verify filter).
    // Modern responders that want to be counted MUST stamp their
    // identityId in the VerifyApproval payload.
    if (typeof (this.chain as any).getIdentityIdForAddress !== 'function') {
      return 0n;
    }
    try {
      const id = await (this.chain as any).getIdentityIdForAddress(approverAddress);
      return id ? BigInt(id) : 0n;
    } catch {
      return 0n;
    }
  }

  private async promoteToVerifiedMemory(
    contextGraphId: string,
    verifiedMemoryId: string,
    batchId: bigint,
    txHash: string,
    blockNumber: number,
    signers: string[],
  ): Promise<void> {
    // Query only the triples belonging to this batch via root entities in _meta
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    if (rootEntities.length === 0) {
      this.log.warn(createOperationContext('verify'), `No root entities found for batch ${batchId} — skipping VM promotion`);
      return;
    }
    const dataGraph = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
    // Query root entities AND their skolemized children (subjects starting
    // with the root entity URI, e.g. <root>/.well-known/genid/...).
    // We use FILTER with STRSTARTS to capture the full closure instead of
    // an exact VALUES match, which would miss child/blank-node subjects.
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${sparqlString(e)} || STRSTARTS(STR(?s), ${sparqlString(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    if (result.type !== 'bindings') return;

    const vmGraph = assertSafeIri(contextGraphVerifiedMemoryUri(contextGraphId, verifiedMemoryId));
    const vmQuads: Quad[] = (result.bindings as Record<string, string>[])
      .filter(row => !isTrustLevelQuad({ predicate: row.p }))
      .map(row => ({
        subject: row['s'],
        predicate: row['p'],
        object: row['o'],
        graph: vmGraph,
      }));
    if (vmQuads.length > 0) {
      await this.store.insert(vmQuads);
    }
    await this.stampTrustLevel(
      vmGraph,
      [...new Set(vmQuads.map((q) => q.subject))],
      TrustLevel.ConsensusVerified,
    );

    // Write verification metadata
    const vmMetaGraph = contextGraphVerifiedMemoryMetaUri(contextGraphId, verifiedMemoryId);
    const metaQuads = buildVerificationMetadata({
      contextGraphId,
      verifiedMemoryId,
      batchId,
      txHash,
      blockNumber,
      signers,
      verifiedAt: new Date(),
      graph: vmMetaGraph,
    });
    await this.store.insert(metaQuads);
  }

  private async stampBatchTrustLevel(
    contextGraphId: string,
    batchId: bigint,
    graph: string,
    level: TrustLevel,
  ): Promise<void> {
    const subjects = await this.getBatchSubjects(contextGraphId, batchId);
    await this.stampTrustLevel(graph, subjects, level);
  }

  private async getBatchSubjects(contextGraphId: string, batchId: bigint): Promise<string[]> {
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    return this.getSubjectsForRoots(contextGraphDataGraphUri(contextGraphId), rootEntities);
  }

  private async getRootEntities(contextGraphId: string, batchId: bigint): Promise<string[]> {
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    // Try typed literal first, fallback to untyped for backward compat
    for (const ns of ['http://dkg.io/ontology/', 'https://dkg.network/ontology#']) {
      for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
        const result = await this.store.query(
          `SELECT ?entity WHERE {
            GRAPH <${metaGraph}> {
              {
                ?ka <${ns}rootEntity> ?entity .
                ?ka <${ns}batchId> ${literal} .
              }
              UNION
              {
                ?ka <${ns}rootEntity> ?entity ;
                    <${ns}partOf> ?kc .
                ?kc <${ns}batchId> ${literal} .
              }
            }
          }`,
        );
        if (result.type === 'bindings' && result.bindings.length > 0) {
          return (result.bindings as Record<string, string>[]).map(r => r['entity']).filter(Boolean);
        }
      }
    }
    return [];
  }

  private async getBatchChainProvenance(
    contextGraphId: string,
    batchId: bigint,
  ): Promise<{ hash: string; blockNumber: number } | null> {
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    for (const ns of ['http://dkg.io/ontology/', 'https://dkg.network/ontology#']) {
      for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
        const result = await this.store.query(
          `SELECT ?tx ?block WHERE {
            GRAPH <${metaGraph}> {
              ?kc <${ns}batchId> ${literal} .
              ?kc <${ns}transactionHash> ?tx .
              OPTIONAL { ?kc <${ns}blockNumber> ?block }
            }
          } LIMIT 1`,
        );
        if (result.type !== 'bindings' || result.bindings.length === 0) continue;
        const row = result.bindings[0] as Record<string, string>;
        const hash = /^"([^"]+)"/.exec(row.tx ?? '')?.[1] ?? row.tx;
        if (!hash) continue;
        const rawBlock = /^"([^"]+)"/.exec(row.block ?? '')?.[1] ?? row.block;
        const blockNumber = rawBlock ? Number(rawBlock) : 0;
        return {
          hash,
          blockNumber: Number.isFinite(blockNumber) ? blockNumber : 0,
        };
      }
    }
    return null;
  }

  // ── CCL ──────────────────────────────────────────────────────────────

  async publishCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.contextGraphId))) {
      throw new Error(`Context Graph "${opts.contextGraphId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ contextGraphId: opts.contextGraphId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.contextGraphId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for contextGraph "${opts.contextGraphId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) throw new Error(`CCL policy not found: ${opts.policyUri}`);
    if (record.contextGraphId !== opts.contextGraphId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to contextGraph "${record.contextGraphId}", not "${opts.contextGraphId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    // Emit the public `dkg:creator` peer DID as the binding owner: it's the
    // handle remote peers resolve via ONTOLOGY gossip, so gossip-publish-handler
    // will accept the approval. `_meta`-only `dkg:curator` (wallet DID) is
    // used for local authorization via `assertContextGraphOwner` above.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      policyName: record.name,
      creator: ownerDid,
      graph: ontologyGraph,
      approvedAt,
      contextType: effectiveContextType,
    });

    quads.push(
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('approved'), graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: ownerDid, graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(approvedAt), graph: ontologyGraph },
    );

    await this.store.insert(quads);
    await this.publishOntologyQuads(bindingUri, quads);
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for contextGraph "${opts.contextGraphId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);

    const target = await this.getActiveCclPolicyBinding({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new Error(`No active CCL policy binding found for ${opts.policyUri} in contextGraph "${opts.contextGraphId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`);
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    // See note in approveCclPolicy — use `dkg:creator` (peer DID) for the
    // public binding metadata so it round-trips through ONTOLOGY gossip.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: ownerDid,
      graph: ontologyGraph,
      revokedAt,
      contextGraphUri: `did:dkg:context-graph:${opts.contextGraphId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for contextGraph "${opts.contextGraphId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?contextGraph ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                  <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                  <${DKG_ONTOLOGY.DKG_POLICY_VERSION}> ?version ;
                  <${DKG_ONTOLOGY.DKG_POLICY_HASH}> ?hash ;
                  <${DKG_ONTOLOGY.DKG_POLICY_LANGUAGE}> ?language ;
                  <${DKG_ONTOLOGY.DKG_POLICY_FORMAT}> ?format ;
                  <${DKG_ONTOLOGY.DKG_POLICY_STATUS}> ?status .
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${bodyClause}
          ${filterBlock}
        }
      }
      ORDER BY ?name ?version
    `);

    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const contextGraphUri = row['contextGraph'];
        const contextGraphId = contextGraphUri.startsWith('did:dkg:context-graph:') ? contextGraphUri.slice('did:dkg:context-graph:'.length) : contextGraphUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${contextGraphId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.contextGraphId === contextGraphId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          contextGraphId,
          name,
          version: stripLiteral(row['version']),
          hash: stripLiteral(row['hash']),
          language: stripLiteral(row['language']),
          format: stripLiteral(row['format']),
          status: this.deriveCclPolicyStatus(row['policy'], stripLiteral(row['status']), bindings, latestByScope),
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          approvedBy: row['approvedBy'],
          approvedAt: row['approvedAt'] ? stripLiteral(row['approvedAt']) : undefined,
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          body: row['body'] ? stripLiteral(row['body']) : undefined,
          isActiveDefault: defaultActive?.policyUri === row['policy'],
          activeContexts,
        };

        const current = records.get(row['policy']);
        if (!current || (current.status !== 'approved' && nextRecord.status === 'approved')) {
          records.set(row['policy'], nextRecord);
        }
      }
    }

    return Array.from(records.values())
      .filter(record => !opts.status || record.status === opts.status)
      .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }

  async resolveCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(opts: {
    contextGraphId: string;
    snapshotId?: string;
    view?: string;
    scopeUal?: string;
    policyName?: string;
    contextType?: string;
  }): Promise<{
    facts: CclFactTuple[];
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'snapshot-resolved';
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: CclFactResolutionMode;
    result: CclEvaluationResult;
  }> {
    const policy = await this.resolveCclPolicy({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy?.body) {
      throw new Error(`No approved policy found for ${opts.contextGraphId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          contextGraphId: opts.contextGraphId,
          snapshotId: opts.snapshotId,
          view: opts.view,
          scopeUal: opts.scopeUal,
          policyName: policy.name,
          contextType: opts.contextType ?? policy.contextType,
        });
    const evaluator = new CclEvaluator(parsed, factInput.facts);
    const result = evaluator.run();

    return {
      policy: {
        policyUri: policy.policyUri,
        contextGraphId: policy.contextGraphId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        contextGraphId: opts.contextGraphId,
        contextType: opts.contextType,
        view: opts.view,
        snapshotId: opts.snapshotId,
        scopeUal: opts.scopeUal,
      },
      factSetHash: factInput.factSetHash,
      factQueryHash: factInput.factQueryHash,
      factResolverVersion: factInput.factResolverVersion,
      factResolutionMode: factInput.factResolutionMode,
      result,
    };
  }

  async evaluateAndPublishCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    evaluationUri: string;
    publish: PublishResult;
    evaluation: {
      policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        contextGraphId: string;
        contextType?: string;
        view?: string;
        snapshotId?: string;
        scopeUal?: string;
      };
      factSetHash: string;
      factQueryHash: string;
      factResolverVersion: string;
      factResolutionMode: CclFactResolutionMode;
      result: CclEvaluationResult;
    };
  }> {
    const evaluation = await this.evaluateCclPolicy(opts);
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: evaluation.policy.policyUri,
      factSetHash: evaluation.factSetHash,
      factQueryHash: evaluation.factQueryHash,
      factResolverVersion: evaluation.factResolverVersion,
      factResolutionMode: evaluation.factResolutionMode,
      result: evaluation.result,
      evaluatedAt: new Date().toISOString(),
      view: evaluation.context.view,
      snapshotId: evaluation.context.snapshotId,
      scopeUal: evaluation.context.scopeUal,
      contextType: evaluation.context.contextType,
    }, graph);
    const publish = await this.publish(opts.contextGraphId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const filters: string[] = [];
    if (opts.policyUri) filters.push(`?policy = <${opts.policyUri}>`);
    if (opts.snapshotId) filters.push(`?snapshotId = ${sparqlString(opts.snapshotId)}`);
    if (opts.view) filters.push(`?view = ${sparqlString(opts.view)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    if (opts.resultKind) filters.push(`?kind = ${sparqlString(opts.resultKind)}`);
    if (opts.resultName) filters.push(`?resultName = ${sparqlString(opts.resultName)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';

    const result = await this.store.query(`
      SELECT ?evaluation ?policy ?factSetHash ?factQueryHash ?factResolverVersion ?factResolutionMode ?createdAt ?view ?snapshotId ?scopeUal ?contextType ?entry ?kind ?resultName ?arg ?argIndex ?argValue WHERE {
        GRAPH <${graph}> {
          ?evaluation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_EVALUATION}> ;
                      <${DKG_ONTOLOGY.DKG_EVALUATED_POLICY}> ?policy ;
                      <${DKG_ONTOLOGY.DKG_FACT_SET_HASH}> ?factSetHash .
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_QUERY_HASH}> ?factQueryHash }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION}> ?factResolverVersion }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE}> ?factResolutionMode }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?createdAt }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          OPTIONAL {
            ?evaluation <${DKG_ONTOLOGY.DKG_HAS_RESULT}> ?entry .
            ?entry <${DKG_ONTOLOGY.DKG_RESULT_KIND}> ?kind ;
                   <${DKG_ONTOLOGY.DKG_RESULT_NAME}> ?resultName .
            OPTIONAL {
              ?entry <${DKG_ONTOLOGY.DKG_HAS_RESULT_ARG}> ?arg .
              ?arg <${DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX}> ?argIndex ;
                   <${DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE}> ?argValue .
            }
          }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?createdAt) ?evaluation ?kind ?resultName ?argIndex
    `);

    if (result.type !== 'bindings') return [];
    const records = new Map<string, CclPublishedEvaluationRecord>();
    const entryArgs = new Map<string, Map<number, unknown>>();
    for (const row of result.bindings as Record<string, string>[]) {
      const evaluationUri = row['evaluation'];
      let record = records.get(evaluationUri);
      if (!record) {
        record = {
          evaluationUri,
          policyUri: row['policy'],
          factSetHash: stripLiteral(row['factSetHash']),
          factQueryHash: row['factQueryHash'] ? stripLiteral(row['factQueryHash']) : undefined,
          factResolverVersion: row['factResolverVersion'] ? stripLiteral(row['factResolverVersion']) : undefined,
          factResolutionMode: row['factResolutionMode'] ? stripLiteral(row['factResolutionMode']) as CclFactResolutionMode : undefined,
          createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
          view: row['view'] ? stripLiteral(row['view']) : undefined,
          snapshotId: row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined,
          scopeUal: row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          results: [],
        };
        records.set(evaluationUri, record);
      }

      if (row['entry']) {
        const entryUri = row['entry'];
        let existing = record.results.find(resultEntry => resultEntry.entryUri === entryUri);
        if (!existing) {
          existing = {
            entryUri,
            kind: stripLiteral(row['kind']) as 'derived' | 'decision',
            name: stripLiteral(row['resultName']),
            tuple: [],
          };
          record.results.push(existing);
        }

        if (row['arg'] && row['argIndex'] && row['argValue']) {
          let args = entryArgs.get(entryUri);
          if (!args) {
            args = new Map<number, unknown>();
            entryArgs.set(entryUri, args);
          }
          args.set(Number(stripLiteral(row['argIndex'])), JSON.parse(stripLiteral(row['argValue'])));
        }
      }
    }

    for (const record of records.values()) {
      for (const resultEntry of record.results) {
        const args = entryArgs.get(resultEntry.entryUri);
        if (args && args.size > 0) {
          resultEntry.tuple = [...args.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
        }
      }
    }

    return Array.from(records.values());
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

  private async getCclPolicyByUri(policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
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

  private async assertContextGraphPolicyOwner(contextGraphId: string, callerAgentAddress?: string): Promise<void> {
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

  private async listCclPolicyBindings(opts: {
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

  private selectLatestNonRevokedBindings(bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
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

  private resolveCclPolicyBinding(
    latestByScope: Map<string, PolicyApprovalBinding>,
    contextGraphId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${contextGraphId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${contextGraphId}|${name}|`)
      ?? null;
  }

  private async getActiveCclPolicyBinding(opts: {
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

  private deriveCclPolicyStatus(
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

  private async publishOntologyQuads(ual: string, quads: Quad[]): Promise<void> {
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


export interface DKGAgent extends ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods {}
applyMixins(DKGAgent, [ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods]);
