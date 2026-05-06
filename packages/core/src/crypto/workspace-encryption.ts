import { webcrypto } from 'node:crypto';
import {
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  computeEncryptedWorkspaceAAD,
  type EncryptedWorkspaceAADFields,
  type EncryptedWorkspacePayloadMsg,
} from '../proto/encrypted-workspace.js';

export const WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE = 'dkg.workspace.recipient-encryption-key.v1';
export const WORKSPACE_ENCRYPTION_KEY_BYTES = 32;
export const WORKSPACE_ENCRYPTION_NONCE_BYTES = 12;

export interface WorkspaceRecipientEncryptionKey {
  purpose: typeof WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE;
  recipientId: string;
  recipientKeyId: string;
  keyBytes: Uint8Array;
}

export interface EncryptWorkspacePayloadInput extends Omit<EncryptedWorkspaceAADFields, 'version' | 'type'> {
  plaintext: Uint8Array;
  recipients: readonly WorkspaceRecipientEncryptionKey[];
  randomBytes?: (length: number) => Uint8Array;
}

export interface DecryptedWorkspacePayload {
  plaintext: Uint8Array;
  recipientId: string;
  recipientKeyId: string;
}

type WorkspaceEncryptionMetadata = Required<Pick<
  EncryptedWorkspaceAADFields,
  | 'version'
  | 'type'
  | 'contextGraphId'
  | 'senderIdentity'
  | 'operationId'
  | 'workspaceOperationId'
  | 'timestampMs'
  | 'subGraphName'
>>;

export function generateWorkspaceRecipientEncryptionKey(
  recipientId: string,
  recipientKeyId: string,
): WorkspaceRecipientEncryptionKey {
  assertNonEmpty('recipientId', recipientId);
  assertNonEmpty('recipientKeyId', recipientKeyId);
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    recipientId,
    recipientKeyId,
    keyBytes: secureRandomBytes(WORKSPACE_ENCRYPTION_KEY_BYTES),
  };
}

export async function encryptWorkspacePayload(
  input: EncryptWorkspacePayloadInput,
): Promise<EncryptedWorkspacePayloadMsg> {
  assertSupportedEncryptOverrides(input);
  const metadata = workspaceMetadata(input);
  const aad = computeEncryptedWorkspaceAAD(metadata);

  if (input.recipients.length === 0) {
    throw new Error('At least one recipient encryption key is required');
  }

  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const contentKey = checkedRandomBytes(WORKSPACE_ENCRYPTION_KEY_BYTES, randomBytes);
  const payloadNonce = checkedRandomBytes(WORKSPACE_ENCRYPTION_NONCE_BYTES, randomBytes);
  const ciphertext = await aesGcmEncrypt(contentKey, input.plaintext, payloadNonce, aad);
  const recipients = [];

  for (const recipient of input.recipients) {
    validateRecipientEncryptionKey(recipient);
    const nonce = checkedRandomBytes(WORKSPACE_ENCRYPTION_NONCE_BYTES, randomBytes);
    recipients.push({
      recipientId: recipient.recipientId,
      recipientKeyId: recipient.recipientKeyId,
      algorithm: ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
      nonce,
      encryptedKey: await aesGcmEncrypt(
        recipient.keyBytes,
        contentKey,
        nonce,
        computeRecipientKeyAAD(metadata, recipient.recipientId, recipient.recipientKeyId),
      ),
    });
  }

  return {
    ...metadata,
    cipherAlgorithm: ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
    nonce: payloadNonce,
    ciphertext,
    recipients,
  };
}

export async function decryptWorkspacePayload(
  envelope: EncryptedWorkspacePayloadMsg,
  recipientKeys: readonly WorkspaceRecipientEncryptionKey[],
): Promise<DecryptedWorkspacePayload> {
  assertSupportedEncryptedWorkspaceEnvelope(envelope);
  const metadata = workspaceMetadata(envelope);
  const aad = computeEncryptedWorkspaceAAD(metadata);

  for (const recipientKey of recipientKeys) {
    validateRecipientEncryptionKey(recipientKey);
    for (const slot of envelope.recipients) {
      if (
        slot.recipientId !== recipientKey.recipientId ||
        slot.recipientKeyId !== recipientKey.recipientKeyId
      ) {
        continue;
      }

      let contentKey: Uint8Array;
      try {
        contentKey = await aesGcmDecrypt(
          recipientKey.keyBytes,
          slot.encryptedKey,
          slot.nonce,
          computeRecipientKeyAAD(metadata, slot.recipientId, slot.recipientKeyId),
        );
      } catch {
        continue;
      }

      return {
        recipientId: slot.recipientId,
        recipientKeyId: slot.recipientKeyId,
        plaintext: await aesGcmDecrypt(contentKey, envelope.ciphertext, envelope.nonce, aad),
      };
    }
  }

  throw new Error('No matching recipient encryption key could decrypt workspace payload');
}

export function assertSupportedEncryptedWorkspaceEnvelope(envelope: EncryptedWorkspacePayloadMsg): void {
  if (envelope.version !== ENCRYPTED_WORKSPACE_ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted workspace envelope version: ${envelope.version}`);
  }
  if (envelope.type !== ENCRYPTED_WORKSPACE_ENVELOPE_TYPE) {
    throw new Error(`Unsupported encrypted workspace envelope type: ${envelope.type}`);
  }
  if (envelope.cipherAlgorithm !== ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM) {
    throw new Error(`Unsupported encrypted workspace cipher algorithm: ${envelope.cipherAlgorithm}`);
  }
  if (envelope.nonce.length !== WORKSPACE_ENCRYPTION_NONCE_BYTES) {
    throw new Error('Encrypted workspace payload nonce must be 12 bytes');
  }
  if (envelope.recipients.length === 0) {
    throw new Error('Encrypted workspace envelope must include at least one recipient key slot');
  }

  for (const slot of envelope.recipients) {
    assertNonEmpty('recipientId', slot.recipientId);
    assertNonEmpty('recipientKeyId', slot.recipientKeyId);
    if (slot.algorithm !== ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM) {
      throw new Error(`Unsupported encrypted workspace key wrap algorithm: ${slot.algorithm}`);
    }
    if (slot.nonce.length !== WORKSPACE_ENCRYPTION_NONCE_BYTES) {
      throw new Error('Encrypted workspace recipient key slot nonce must be 12 bytes');
    }
    if (slot.encryptedKey.length === 0) {
      throw new Error('Encrypted workspace recipient key slot is empty');
    }
  }
}

function validateRecipientEncryptionKey(key: WorkspaceRecipientEncryptionKey): void {
  if (key.purpose !== WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE) {
    throw new Error('Expected a dedicated workspace recipient encryption key');
  }
  assertNonEmpty('recipientId', key.recipientId);
  assertNonEmpty('recipientKeyId', key.recipientKeyId);
  if (key.keyBytes.length !== WORKSPACE_ENCRYPTION_KEY_BYTES) {
    throw new Error('Workspace recipient encryption key must be 32 bytes');
  }
}

function assertSupportedEncryptOverrides(fields: object): void {
  const maybeOverrides = fields as { version?: unknown; type?: unknown };
  if (
    maybeOverrides.version !== undefined &&
    maybeOverrides.version !== ENCRYPTED_WORKSPACE_ENVELOPE_VERSION
  ) {
    throw new Error(`Unsupported encrypted workspace envelope version: ${String(maybeOverrides.version)}`);
  }
  if (
    maybeOverrides.type !== undefined &&
    maybeOverrides.type !== ENCRYPTED_WORKSPACE_ENVELOPE_TYPE
  ) {
    throw new Error(`Unsupported encrypted workspace envelope type: ${String(maybeOverrides.type)}`);
  }
}

function workspaceMetadata(
  fields: Omit<EncryptedWorkspaceAADFields, 'version' | 'type'>,
): WorkspaceEncryptionMetadata {
  assertNonEmpty('contextGraphId', fields.contextGraphId);
  assertNonEmpty('senderIdentity', fields.senderIdentity);
  assertNonEmpty('operationId', fields.operationId);
  assertNonEmpty('workspaceOperationId', fields.workspaceOperationId);
  return {
    version: ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
    type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
    contextGraphId: fields.contextGraphId,
    senderIdentity: fields.senderIdentity,
    operationId: fields.operationId,
    workspaceOperationId: fields.workspaceOperationId,
    timestampMs: fields.timestampMs,
    subGraphName: fields.subGraphName ?? '',
  };
}

function computeRecipientKeyAAD(
  metadata: WorkspaceEncryptionMetadata,
  recipientId: string,
  recipientKeyId: string,
): Uint8Array {
  return concatBytes([
    computeEncryptedWorkspaceAAD(metadata),
    framedString('recipientId'),
    framedString(recipientId),
    framedString('recipientKeyId'),
    framedString(recipientKeyId),
  ]);
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['encrypt']);
  return new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      plaintext,
    ),
  );
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes, ['decrypt']);
  return new Uint8Array(
    await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}

async function importAesGcmKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.length !== WORKSPACE_ENCRYPTION_KEY_BYTES) {
    throw new Error('AES-GCM workspace key material must be 32 bytes');
  }
  return webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, usages);
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
}

function checkedRandomBytes(length: number, randomBytes: (length: number) => Uint8Array): Uint8Array {
  const bytes = randomBytes(length);
  if (bytes.length !== length) {
    throw new Error(`randomBytes returned ${bytes.length} bytes, expected ${length}`);
  }
  return new Uint8Array(bytes);
}

function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
}

const textEncoder = new TextEncoder();

function uint32Be(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  return buf;
}

function framedString(value: string): Uint8Array {
  const encoded = textEncoder.encode(value);
  return concatBytes([uint32Be(encoded.length), encoded]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
