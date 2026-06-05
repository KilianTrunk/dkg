export {
  DashboardDB,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  type SqliteProtocolOutboxStoreOptions,
  // Notifications-pane redesign (V16): activity-digest primitives shared
  // with the daemon's `assertion_activity` emitters + scoped read path.
  ACTIVITY_DIGEST_WINDOW_MS,
  ASSERTION_ACTIVITY_TYPE,
  buildActivityDigestKey,
  parseActivityDigestKey,
} from './db.js';
export type {
  DashboardDBOptions,
  MetricSnapshotRow,
  OperationRow,
  OperationPhaseRow,
  OperationStatsSummary,
  OperationStatsBucket,
  SpendingSummary,
  SpendingPeriod,
  ChatMessageRow,
  LogRow,
  QueryHistoryRow,
  SavedQueryRow,
  ContextGraphSubscriptionRow,
  ContextGraphMemberPrincipalType,
  ContextGraphMemberStatus,
  ContextGraphMemberRow,
  NotificationRow,
  AssertionActivityKind,
} from './db.js';
export {
  analyzeGuardianEvent,
  buildEndorsementQuads,
  buildFalsePositiveQuads,
  GUARDIAN_FALSE_POSITIVE_TYPE_IRI,
  GUARDIAN_DISPUTES_PRED,
  GUARDIAN_DISPUTE_REPORTER_PRED,
  buildFixPrompt,
  buildPrivateAuditQuads,
  buildPublicDependencyQuads,
  buildPublicEscalationThreatQuads,
  buildPublicInjectionThreatQuads,
  componentsFromFindings,
  detectDependencyInstalls,
  ecosystemForOsv,
  GUARDIAN_ARG_SHAPE_PRED,
  GUARDIAN_CURATED_PRED,
  GUARDIAN_DEP_THREAT_TYPE_IRI,
  GUARDIAN_ENDORSEMENT_TYPE_IRI,
  GUARDIAN_ENDORSER_PRED,
  GUARDIAN_ENDORSES_PRED,
  GUARDIAN_ESCALATION_THREAT_TYPE_IRI,
  GUARDIAN_IDENTIFIER_PRED,
  GUARDIAN_INJECTION_THREAT_TYPE_IRI,
  GUARDIAN_ONTOLOGY,
  GUARDIAN_OWASP_CATEGORY_PRED,
  GUARDIAN_PATTERN_PRED,
  GUARDIAN_PUBLIC_THREAT_GRAPH_ID,
  GUARDIAN_SEVERITY_PRED,
  GUARDIAN_THREAT_TYPE_IRI,
  GUARDIAN_TOOL_NAME_PRED,
  guardianDependencyIntelId,
  maxSeverity,
  normalizeGuardianEvent,
  normalizeSeverity,
  redactGuardianData,
  sanitizeText,
  stableHash,
  threatIdentifierFor,
  threatUriFor,
} from './guardian.js';
export type {
  GuardianDependencyComponent,
  GuardianDependencyIntelRecord,
  GuardianEventInput,
  GuardianEventRecord,
  GuardianEventType,
  GuardianFindingRecord,
  GuardianFindingType,
  GuardianGraphSyncRecord,
  GuardianSeverity,
  GuardianSourceAgent,
  GuardianSummary,
} from './guardian.js';

export { StructuredLogger } from './structured-logger.js';
export { OperationTracker } from './operation-tracker.js';
export { MetricsCollector } from './metrics-collector.js';
export type { MetricsSource } from './metrics-collector.js';
export { handleNodeUIRequest } from './api.js';
export { scopeNotifications } from './notifications-scope.js';
export type {
  NotifWire,
  ScopedNotificationsResult,
  NotificationScopeContext,
} from './notifications-scope.js';
export type { LlmSettingsCallbacks, TelemetrySettingsCallbacks } from './api.js';
export { LogPushWorker } from './gelf-push-worker.js';
export type { LogPushWorkerOptions } from './gelf-push-worker.js';
export { ChatMemoryManager } from './chat-memory.js';
export type {
  MemoryToolContext,
  MemoryStats,
  MemoryEntity,
  SessionPublicationStatus,
  SessionPublishResult,
  SessionGraphDeltaWatermark,
  SessionGraphDeltaResult,
} from './chat-memory.js';
export { LlmClient, LlmRequestError } from './llm/client.js';
export { resolveCapabilities } from './llm/capability-resolver.js';
export type { LlmConfig, LlmChatRequest, LlmChatMessage, LlmStreamEvent, LlmCompletionResult, LlmCapabilities } from './llm/types.js';
export { initTelemetry, recordGauge, setOperationSpan, isTelemetryConfigured } from './telemetry.js';
export type { TelemetryConfig } from './telemetry.js';
