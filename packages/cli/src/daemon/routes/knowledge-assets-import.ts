// daemon/routes/knowledge-assets-import.ts
//
// Collection-level import-artifact + semantic-enrichment routes for the
// GitHub-shaped Knowledge Asset HTTP surface. These are keyed by
// `assertionUri` in the body (no `:name` path segment) and mirror the
// legacy `/api/assertion/*` routes byte-for-byte:
//
//   POST /api/knowledge-assets/import-artifact/resolve
//        ↔ POST /api/assertion/import-artifact/resolve
//   POST /api/knowledge-assets/import-artifact/read-markdown
//        ↔ POST /api/assertion/import-artifact/read-markdown
//   POST /api/knowledge-assets/semantic-enrichment/write
//        ↔ POST /api/assertion/semantic-enrichment/write
//
// The handlers are ports of the corresponding blocks in
// `daemon/routes/assertion.ts`: identical validation, owner-guard,
// error mapping, response shape, and side-effects. Each reads + parses
// its own body. The shared logic lives in `./shared-assertion-helpers.js`.

import { randomUUID } from "node:crypto";
import { contextGraphAssertionUri } from "@origintrail-official/dkg-core";
import type { RequestContext } from "./context.js";
import {
  jsonResponse,
  readBody,
  safeParseJson,
  SMALL_BODY_BYTES,
  resolveRequiredWriteContextGraphId,
} from "../http-utils.js";
import {
  ImportArtifactRouteError,
  resolveImportedArtifact,
  handleImportArtifactRouteError,
  normalizeSemanticQuads,
  buildSemanticEnrichmentProvenanceQuads,
  normalizeGeneratedAt,
  normalizeGeneratedBy,
  normalizeMarkdownReadLimit,
} from "./shared-assertion-helpers.js";

// POST /api/knowledge-assets/import-artifact/resolve
// Resolve a completed deterministic import artifact from graph metadata.
export async function handleKaImportArtifactResolve(ctx: RequestContext): Promise<void> {
  const { req, res, requestAgentAddress } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const artifact = await resolveImportedArtifact(ctx, parsed as Record<string, unknown>, {
      requestAgentAddress,
      message: 'Import artifact metadata can only be read from imported assertions owned by the requesting agent',
      // Issue #872 — this is a read; opt into the public + open
      // policy relaxation. The write route below does NOT set this.
      relaxOnPublicOpenCg: true,
    });
    return jsonResponse(res, 200, { artifact });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/import-artifact/read-markdown
// Read only the Markdown blob tied to a completed imported assertion.
export async function handleKaImportArtifactReadMarkdown(ctx: RequestContext): Promise<void> {
  const { req, res, requestAgentAddress, fileStore } = ctx;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const artifact = await resolveImportedArtifact(ctx, parsed as Record<string, unknown>, {
      requestAgentAddress,
      message: 'Import artifact Markdown can only be read from imported assertions owned by the requesting agent',
      // Issue #872 — read path; opt into the public + open relaxation.
      relaxOnPublicOpenCg: true,
    });
    const maxBytes = normalizeMarkdownReadLimit((parsed as Record<string, unknown>).maxBytes);
    if (!artifact.markdownHash) {
      return jsonResponse(res, 409, {
        error: 'Import artifact does not have a readable Markdown source',
        artifact,
      });
    }
    const bytes = await fileStore.get(artifact.markdownHash);
    if (!bytes) {
      // Issue #872 — when the owner guard was relaxed (public + open
      // CG, cross-agent request), the missing bytes are the
      // expected outcome: peers replicate the SWM triples for the
      // assertion but the source-artifact bytes are NOT gossipped
      // yet. Surface that explicitly so callers can decide whether
      // to retry against the origin agent instead of treating this
      // as local corruption.
      //
      // DEFERRED FOLLOW-UP: gossip the imported-artifact bytes to
      // peers replicating a public + open CG, so cross-agent reads
      // can complete locally without an out-of-band fetch. Tracked
      // in the PR body for #872.
      const message = artifact.ownerGuardRelaxed
        ? 'Markdown source bytes are not replicated locally on this peer; the assertion graph triples synced but the source artifact bytes were not. Fetch from the origin agent (assertionAgentAddress).'
        : 'Markdown content is not present in the file store';
      return jsonResponse(res, 404, {
        error: message,
        artifact,
      });
    }
    if (bytes.length > maxBytes) {
      return jsonResponse(res, 413, {
        error: `Markdown content exceeds maxBytes (${maxBytes})`,
        artifact,
        bytes: bytes.length,
      });
    }
    return jsonResponse(res, 200, {
      artifact,
      markdownHash: artifact.markdownHash,
      contentType: 'text/markdown',
      bytes: bytes.length,
      markdown: bytes.toString('utf8'),
    });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}

// POST /api/knowledge-assets/semantic-enrichment/write
// Write model-derived semantic triples into the completed imported assertion with provenance.
export async function handleKaSemanticEnrichmentWrite(ctx: RequestContext): Promise<void> {
  const { req, res, agent, requestToken, requestAgentAddress, emitMemoryGraphChanged } = ctx;
  // Mirror the legacy assertion-route preflight: resolve the caller agent
  // from the bearer token so `resolveRequiredWriteContextGraphId` validates
  // the write CG against the caller's known graphs before any mutation.
  const writePreflightCallerAgentAddress = requestToken
    ? agent.resolveAgentByToken(requestToken)
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };
  const body = await readBody(req);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  try {
    const record = { ...(parsed as Record<string, unknown>) };
    if (
      record.name !== undefined ||
      record.semanticAssertionName !== undefined ||
      record.semantic_assertion_name !== undefined
    ) {
      throw new ImportArtifactRouteError(
        400,
        'Semantic enrichment is written into the source import assertion; target assertion names are not supported',
      );
    }
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      record.contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    record.contextGraphId = resolvedContextGraphId;
    const artifact = await resolveImportedArtifact(ctx, record, {
      requestAgentAddress,
      message: 'Semantic enrichment can only modify imported assertions owned by the requesting agent',
    });
    const semanticQuads = normalizeSemanticQuads(record.semanticQuads);
    const generatedAt = normalizeGeneratedAt(record.generatedAt);
    const generationMethod = typeof record.generationMethod === 'string' && record.generationMethod.trim()
      ? record.generationMethod.trim()
      : 'agent-semantic-enrichment';
    const generatedBy = normalizeGeneratedBy(record.agentIdentity, requestAgentAddress);
    const enrichmentUri = `urn:dkg:semantic-enrichment:${randomUUID()}`;
    const provenanceQuads = buildSemanticEnrichmentProvenanceQuads({
      enrichmentUri,
      source: artifact,
      generatedBy,
      generatedAt,
      generationMethod,
      semanticQuads,
    });
    const quads = [...semanticQuads, ...provenanceQuads];
    const targetAssertionUri = contextGraphAssertionUri(
      artifact.contextGraphId,
      artifact.assertionAgentAddress,
      artifact.assertionName,
      artifact.subGraphName,
    );
    if (targetAssertionUri !== artifact.assertionUri) {
      throw new ImportArtifactRouteError(409, 'Resolved import artifact target does not match assertionUri');
    }
    await agent.publisher.assertionWrite(
      artifact.contextGraphId,
      artifact.assertionName,
      artifact.assertionAgentAddress,
      quads,
      artifact.subGraphName,
    );
    emitMemoryGraphChanged?.({
      contextGraphId: artifact.contextGraphId,
      layers: ["wm"],
      subGraphName: artifact.subGraphName,
      operation: "semantic_enrichment_written",
      source: "api",
      counts: { triples: quads.length },
    });
    return jsonResponse(res, 200, {
      assertionUri: artifact.assertionUri,
      assertionName: artifact.assertionName,
      contextGraphId: artifact.contextGraphId,
      ...(artifact.subGraphName ? { subGraphName: artifact.subGraphName } : {}),
      sourceAssertionUri: artifact.assertionUri,
      sourceFileHash: artifact.fileHash,
      markdownHash: artifact.markdownHash,
      markdownForm: artifact.markdownForm,
      enrichmentUri,
      written: quads.length,
      semanticTripleCount: semanticQuads.length,
      provenanceTripleCount: provenanceQuads.length,
      promoted: false,
      published: false,
      artifact,
    });
  } catch (err) {
    if (handleImportArtifactRouteError(res, err)) return;
    throw err;
  }
}
