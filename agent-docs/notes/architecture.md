# Architecture Notes

## Overview

This file records durable architecture knowledge discovered during work in this repository.

## Current Focus

- Issue 1309 concerns DKG agent publish flows, specifically how local context graph IDs and on-chain context graph IDs are passed into LU-5/LU-11 encryption policy resolution.

## Components

- `packages/agent/src/dkg-agent-publish.ts`
  - `_publish`, `update`, and `publishFromSharedMemory` resolve publisher target ids and feed encryption policy helpers.
  - `_resolveCuratedChainKeyContext` owns curated/public policy selection and sender-key bootstrap.
  - `_resolveEncryptInlinePayload` implements LU-5 inline AEAD wrapping.
  - `_resolveEncryptInlineChunked` implements LU-11 chunked encryption.
- `packages/cli/src/daemon/lifecycle.ts`
  - `resolveDaemonPublishEncryption` bridges async publish options to the agent encryption helpers.
- `packages/publisher/src/dkg-publisher.ts`
  - Publisher-level SWM remap handling already distinguishes explicit remap target (`publishContextGraphId`) from ACK/tx target (`onChainContextGraphId`).

## Publish Policy Architecture

Policy resolution now separates two concepts:

- Explicit policy target: caller/remap intent that may require raw on-chain target policy probing and fail-closed mismatch checks.
- AEAD binding context graph id: associated-data id for encrypted payloads/chunks; it must never drive plaintext/encrypted policy selection.

Derived same-CG on-chain ids use the source CG for policy and the numeric on-chain id for AEAD binding. Explicit or unverified numeric targets keep the existing raw-slot fail-closed behavior.
