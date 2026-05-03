import type { DkgDaemonClient } from './dkg-client.js';

export interface DkgPublisherQuadInput {
  subject: unknown;
  predicate: unknown;
  object: unknown;
  graph?: unknown;
}

export interface DkgPublisherQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export type DkgPublisherClient = Pick<
  DkgDaemonClient,
  | 'createAssertion'
  | 'writeAssertion'
  | 'promoteAssertion'
  | 'discardAssertion'
  | 'share'
  | 'publish'
  | 'publishSharedMemory'
>;

export interface LocalWorkspaceCreateRequest {
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
}

export interface LocalWorkspaceWriteRequest {
  contextGraphId: string;
  assertionName: string;
  quads: DkgPublisherQuadInput[];
  subGraphName?: string;
  /**
   * Defaults to true so generic plugin callers can use a single write method
   * for the common create-then-write WM flow. Existing OpenClaw assertion
   * tools pass false because they expose create and write as separate steps.
   */
  createIfMissing?: boolean;
}

export interface LocalWorkspacePromoteRequest {
  contextGraphId: string;
  assertionName: string;
  rootEntities?: string[];
  subGraphName?: string;
}

export interface LocalWorkspaceDiscardRequest {
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
}

export interface SharedMemoryWriteRequest {
  contextGraphId: string;
  quads: DkgPublisherQuadInput[];
  localOnly?: boolean;
  subGraphName?: string;
}

export interface VerifiedMemoryPublishRequest {
  contextGraphId: string;
  quads: DkgPublisherQuadInput[];
  privateQuads?: DkgPublisherQuadInput[];
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
}

export interface SharedMemoryPublishRequest {
  contextGraphId: string;
  rootEntities?: string[];
  clearAfter?: boolean;
  subGraphName?: string;
}

export class DkgPublisherFacade {
  constructor(private readonly client: DkgPublisherClient) {}

  async createLocalWorkspace(
    request: LocalWorkspaceCreateRequest,
  ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> {
    return this.client.createAssertion(request.contextGraphId, request.assertionName, {
      subGraphName: request.subGraphName,
    });
  }

  async writeLocalWorkspace(request: LocalWorkspaceWriteRequest): Promise<{ written: number }> {
    if (request.createIfMissing !== false) {
      await this.createLocalWorkspace(request);
    }

    return this.client.writeAssertion(
      request.contextGraphId,
      request.assertionName,
      normalizeDkgPublisherQuads(request.quads),
      { subGraphName: request.subGraphName },
    );
  }

  async promoteLocalWorkspace(
    request: LocalWorkspacePromoteRequest,
  ): ReturnType<DkgPublisherClient['promoteAssertion']> {
    return this.client.promoteAssertion(request.contextGraphId, request.assertionName, {
      entities: request.rootEntities,
      subGraphName: request.subGraphName,
    });
  }

  async discardLocalWorkspace(
    request: LocalWorkspaceDiscardRequest,
  ): ReturnType<DkgPublisherClient['discardAssertion']> {
    return this.client.discardAssertion(request.contextGraphId, request.assertionName, {
      subGraphName: request.subGraphName,
    });
  }

  async writeSharedMemory(request: SharedMemoryWriteRequest): Promise<{ shareOperationId: string }> {
    return this.client.share(
      request.contextGraphId,
      normalizeDkgPublisherQuads(request.quads),
      {
        localOnly: request.localOnly,
        subGraphName: request.subGraphName,
      },
    );
  }

  async publishVerifiedMemory(request: VerifiedMemoryPublishRequest): ReturnType<DkgPublisherClient['publish']> {
    return this.client.publish(
      request.contextGraphId,
      normalizeDkgPublisherQuads(request.quads),
      request.privateQuads ? normalizeDkgPublisherQuads(request.privateQuads) : undefined,
      {
        accessPolicy: request.accessPolicy,
        allowedPeers: request.allowedPeers,
      },
    );
  }

  async publishSharedMemory(
    request: SharedMemoryPublishRequest,
  ): ReturnType<DkgPublisherClient['publishSharedMemory']> {
    return this.client.publishSharedMemory(request.contextGraphId, {
      rootEntities: request.rootEntities,
      clearAfter: request.clearAfter,
      subGraphName: request.subGraphName,
    });
  }
}

export function createDkgPublisher(client: DkgPublisherClient): DkgPublisherFacade {
  return new DkgPublisherFacade(client);
}

export function normalizeDkgPublisherQuads(quads: DkgPublisherQuadInput[]): DkgPublisherQuad[] {
  return quads.map((q) => ({
    subject: String(q.subject ?? ''),
    predicate: String(q.predicate ?? ''),
    object: normalizeDkgPublisherObject(q.object),
    graph: q.graph ? String(q.graph) : '',
  }));
}

export function normalizeDkgPublisherObject(value: unknown): string {
  const raw = String(value ?? '');
  if (isDkgRdfTerm(raw)) return raw;
  return `"${escapeDkgRdfLiteral(raw)}"`;
}

export function isDkgRdfTerm(value: string): boolean {
  return (
    /^(?:https?:\/\/|urn:|did:)/i.test(value) ||
    value.startsWith('_:') ||
    value.startsWith('"')
  );
}

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Returns only the escaped body; callers wrap it in quotes.
 */
export function escapeDkgRdfLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\x08/g, '\\b');
}

export { DkgPublisherFacade as GenericDkgPublisher, DkgPublisherFacade as DkgPublisherAbstraction };
