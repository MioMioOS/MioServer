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
  | 'credential_config_invalid' // storage_ref broken/malformed; action → needs_human
  | 'credential_denied';        // #72/#69: adapter authZ/policy denial (IAM/policy refused) →
                                // action → `failed + credential_denied`, NOT needs_human (5D decision).
                                // A denial is an authorization failure, not a recoverable infra blip.

/**
 * #72: error reasons that mean "infrastructure could not resolve" → the action should go to
 * `needs_human` (recoverable / config attention). DISTINCT from `credential_denied`, which is
 * an authorization denial → `failed + credential_denied`. Callers (consume route) must branch
 * on this set so a denial is never misclassified as a recoverable infra error.
 */
export const NEEDS_HUMAN_RESOLVE_REASONS: ReadonlySet<CredentialStoreErrorReason> = new Set([
  'store_unavailable',
  'credential_not_found',
  'credential_config_invalid',
]);

/** True iff the reason is an authorization denial (→ failed + credential_denied), not infra. */
export function isCredentialDenial(reason: CredentialStoreErrorReason): boolean {
  return reason === 'credential_denied';
}

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

// ── #72: production provider allow-list (positive fail-closed factory guard) ──────
//
// The complement to assertNotProduction: in production, ONLY a vetted production provider
// may back the CredentialStore. Anything else (fixture/aesfile/unknown) → fail closed at
// startup. This prevents prod from silently running with a dev/test store, and prevents a
// future provider being enabled in prod before it has been security-reviewed.

/** Provider identifiers allowed to back the CredentialStore in production. */
// #95 pivot (2026-05-22): VENDOR-NEUTRAL — none of these is privileged or required. A production
// provider is chosen per deployment only when a real credentialed action needs one; until then
// production runs with no provider (fail-closed → needs_human). 'ssm' here is just one allowed
// option (AWS/GCP Secrets Manager would map to 'ssm'/'kms'-style adapters too), NOT a Tencent
// commitment (#73 closed).
export const PROD_CREDENTIAL_PROVIDERS: ReadonlySet<string> = new Set([
  'ssm',   // a cloud Secrets Manager adapter (any vendor) — one option, not the default
  'kms',   // KMS-envelope adapter (vendor-neutral)
  'vault', // HashiCorp Vault
]);

/** Dev/test-only providers — forbidden in production. */
const NON_PROD_CREDENTIAL_PROVIDERS: ReadonlySet<string> = new Set(['fixture', 'aesfile']);

/**
 * Fail-closed factory guard. Throws if, in production, `provider` is not a vetted production
 * provider (or is a known dev/test provider, or is unknown/empty). Non-production allows any
 * known provider. Call this in the CredentialStore factory before constructing the adapter.
 */
export function assertProviderAllowedInEnv(provider: string | undefined, env = process.env.NODE_ENV): void {
  const p = (provider ?? '').trim();
  if (env === 'production') {
    if (!PROD_CREDENTIAL_PROVIDERS.has(p)) {
      throw new Error(
        `[SECURITY] CredentialStore provider '${p || '(unset)'}' is not allowed in production. ` +
        `Allowed: ${[...PROD_CREDENTIAL_PROVIDERS].join(', ')}. Refusing to start (fail-closed).`,
      );
    }
    return;
  }
  // Non-production: allow any known provider (prod or dev/test).
  if (!PROD_CREDENTIAL_PROVIDERS.has(p) && !NON_PROD_CREDENTIAL_PROVIDERS.has(p)) {
    throw new Error(`Unknown CredentialStore provider '${p || '(unset)'}'.`);
  }
}
