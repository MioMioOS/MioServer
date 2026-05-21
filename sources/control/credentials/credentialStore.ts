/**
 * CredentialStore — pluggable secret resolution interface.
 *
 * SECURITY INVARIANTS:
 * 1. resolve() returns plaintext only in memory — never logs, DB, or EventLog.
 * 2. Errors from resolve() MUST NOT contain secret values (even partial).
 * 3. CredentialStoreError.reason is a controlled enum, not a vault error message.
 * 4. PROD GUARD: FixtureCredentialStore is forbidden in production
 *    (NODE_ENV=production → startup fail-closed).
 * 5. AesFileCredentialStore KEK must NOT come from .env (same dump surface as DB).
 *    Source must be OS Keychain or independent secrets manager.
 */

// ── Error types ───────────────────────────────────────────────────────────────

export type CredentialStoreErrorReason =
  | 'store_unavailable'        // transient: vault/file unreachable; action → needs_human
  | 'credential_not_found'     // permanent config error; action → needs_human
  | 'credential_config_invalid'; // storage_ref broken/malformed; action → needs_human

export class CredentialStoreError extends Error {
  constructor(
    public readonly reason: CredentialStoreErrorReason,
    message: string,
  ) {
    // NEVER include secret values in the message
    super(message);
    this.name = 'CredentialStoreError';
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface CredentialStore {
  /**
   * Resolve a storage reference to a plaintext secret value.
   *
   * @param storageRef  Opaque reference stored in ControlCredential.storageRef
   * @param ctx         Non-secret context for logging/audit (never logged with value)
   * @returns           Plaintext secret value — use immediately, scrub after use
   * @throws            CredentialStoreError — never contains secret value
   */
  resolve(
    storageRef: string,
    ctx: { credentialId: string; orgId: string },
  ): Promise<string>;
}

// ── FixtureCredentialStore (test/CI only) ─────────────────────────────────────

/**
 * In-memory credential store for unit tests and CI fixtures.
 *
 * FORBIDDEN IN PRODUCTION: guarded by assertNotProduction() at construction.
 * Real secrets must NEVER be seeded into this store.
 * Use in vitest tests via: new FixtureCredentialStore({ 'ref:asc_key': 'test_value' })
 */
export class FixtureCredentialStore implements CredentialStore {
  private readonly store: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    assertNotProduction('FixtureCredentialStore');
    this.store = new Map(Object.entries(entries));
  }

  async resolve(storageRef: string, _ctx: { credentialId: string; orgId: string }): Promise<string> {
    const value = this.store.get(storageRef);
    if (value === undefined) {
      throw new CredentialStoreError(
        'credential_not_found',
        `FixtureCredentialStore: no entry for ref (check test setup)`,
      );
    }
    return value;
  }

  /** Seed additional entries (for test setup helpers). */
  seed(storageRef: string, value: string): void {
    this.store.set(storageRef, value);
  }
}

// ── AesFileCredentialStore (dev-local only) ───────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Local AES-256-GCM encrypted file store for development/local use.
 *
 * Secrets are stored encrypted in a JSON file (default: ~/.mio/credentials.enc).
 * KEK MUST come from OS Keychain or independent secrets manager — NOT from .env.
 *
 * File format (encrypted JSON):
 *   { "entries": { "<storageRef>": "<base64-encrypted-value>" } }
 *   Each value: IV(12B) + AuthTag(16B) + Ciphertext, all base64-concatenated.
 *
 * FORBIDDEN IN PRODUCTION: guarded by assertNotProduction() at construction.
 */
export class AesFileCredentialStore implements CredentialStore {
  private readonly storePath: string;
  private readonly kek: Buffer;

  /**
   * @param kek        256-bit key encryption key (32 bytes). MUST NOT come from .env.
   * @param storePath  Path to encrypted credentials file (default: ~/.mio/credentials.enc)
   */
  constructor(kek: Buffer, storePath?: string) {
    assertNotProduction('AesFileCredentialStore');
    if (kek.length !== 32) {
      throw new Error('AesFileCredentialStore: KEK must be exactly 32 bytes (256 bits)');
    }
    this.kek = kek;
    this.storePath = storePath ?? join(process.env.HOME ?? '/tmp', '.mio', 'credentials.enc');
  }

  async resolve(storageRef: string, _ctx: { credentialId: string; orgId: string }): Promise<string> {
    let fileContent: Buffer;
    try {
      fileContent = await readFile(this.storePath);
    } catch {
      throw new CredentialStoreError('store_unavailable', 'AesFileCredentialStore: file not readable');
    }

    let parsed: { entries: Record<string, string> };
    try {
      parsed = JSON.parse(fileContent.toString('utf8'));
    } catch {
      throw new CredentialStoreError('credential_config_invalid', 'AesFileCredentialStore: file format invalid');
    }

    const encEntry = parsed.entries?.[storageRef];
    if (!encEntry) {
      throw new CredentialStoreError('credential_not_found', 'AesFileCredentialStore: storage ref not found');
    }

    try {
      const raw = Buffer.from(encEntry, 'base64');
      const iv = raw.subarray(0, 12);
      const authTag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch {
      throw new CredentialStoreError('credential_config_invalid', 'AesFileCredentialStore: decryption failed');
    }
  }

  /** Encrypt and store a secret. For seed scripts only — never use in request handlers. */
  async set(storageRef: string, plaintext: string): Promise<void> {
    let existing: { entries: Record<string, string> } = { entries: {} };
    try {
      const content = await readFile(this.storePath);
      existing = JSON.parse(content.toString('utf8'));
    } catch {
      // File doesn't exist yet — start fresh
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encoded = Buffer.concat([iv, authTag, ciphertext]).toString('base64');

    existing.entries[storageRef] = encoded;
    await writeFile(this.storePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }
}

// ── Production guard ──────────────────────────────────────────────────────────

/**
 * Throws if NODE_ENV === 'production'.
 * Called at construction of dev/test-only stores to prevent accidental production use.
 */
function assertNotProduction(storeName: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[SECURITY] ${storeName} is forbidden in production. ` +
      `Use a production-grade CredentialStore adapter (KMS/Vault/Keychain). ` +
      `Refusing to start.`,
    );
  }
}
