/**
 * Bootstrap-time CredentialStore provisioning (#75) — the single seam where the running server
 * decides which CredentialStore (if any) backs secret resolution, fail-closed.
 *
 * Called ONCE at server bootstrap (not lazily, not per-request) so that any misconfiguration
 * fails BEFORE the server begins serving requests — never half-resolving mid-flight.
 *
 * Behavior:
 *   - CREDENTIAL_STORE_PROVIDER unset/empty → returns undefined → the consume route fail-safes to
 *     `needs_human` (current behavior preserved). This keeps deploys that have not configured a
 *     provider safe — important while #73 (Tencent SSM infra) is not ready and there is no working
 *     production adapter to select. It does NOT silently "succeed": no store means no resolution.
 *   - provider set → createCredentialStore() enforces the production allow-list (prod refuses
 *     fixture/aesfile/unknown/empty) and throws not_implemented for ssm/kms/vault until #73.
 *
 * KEK sourcing (aesfile only): the 32-byte KEK is read from the macOS Keychain, NEVER from .env
 * (invariant 5 — KEK must not share the DB/.env dump surface). On non-macOS hosts aesfile is
 * refused (use a managed-secret provider instead).
 */

import { execFileSync } from 'child_process';
import { config } from '@/config';
import { createCredentialStore } from './credentialStoreFactory.js';
import type { CredentialStore } from './credentialStore.js';

/**
 * Read the AesFile KEK from the macOS Keychain. The Keychain item must store the base64 encoding
 * of exactly 32 raw bytes. Service/account default to mio-credential-kek / mio, overridable by the
 * NON-secret env vars CREDENTIAL_STORE_KEK_KEYCHAIN_SERVICE / _ACCOUNT (these name the item; they
 * are not the secret). The KEK VALUE itself is never read from any env var.
 *
 * Provision once with:
 *   security add-generic-password -s mio-credential-kek -a mio -w "$(openssl rand -base64 32)"
 */
export function loadAesFileKekFromKeychain(): Buffer {
  if (process.platform !== 'darwin') {
    throw new Error(
      "[SECURITY] aesfile KEK must come from the macOS Keychain (dev-mac only). This host is not " +
      'macOS — use a managed-secret provider (ssm/kms/vault) instead. KEK must NEVER come from .env.',
    );
  }
  const service = (process.env.CREDENTIAL_STORE_KEK_KEYCHAIN_SERVICE ?? 'mio-credential-kek').trim();
  const account = (process.env.CREDENTIAL_STORE_KEK_KEYCHAIN_ACCOUNT ?? 'mio').trim();

  let raw: string;
  try {
    raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', service, '-a', account],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    throw new Error(
      `[SECURITY] Could not read AesFile KEK from macOS Keychain (service='${service}', account='${account}'). ` +
      `Provision it with: security add-generic-password -s '${service}' -a '${account}' -w "$(openssl rand -base64 32)". ` +
      'KEK must NEVER come from .env.',
    );
  }

  const kek = Buffer.from(raw, 'base64');
  if (kek.length !== 32) {
    throw new Error(
      '[SECURITY] AesFile KEK from Keychain did not decode to 32 bytes. Re-provision a 256-bit (32-byte) KEK.',
    );
  }
  return kek;
}

export interface ProvisionCredentialStoreOptions {
  /** Override the provider (defaults to config.credentialStoreProvider). Mainly for tests. */
  provider?: string;
  /** Injectable KEK loader (defaults to loadAesFileKekFromKeychain). Mainly for tests. */
  kekLoader?: () => Buffer;
}

/**
 * Provision the CredentialStore for this process, or undefined if no provider is configured.
 * Throws (fail-closed) if a configured provider is invalid for the env, not implemented, or — for
 * aesfile — the KEK cannot be sourced from the Keychain.
 */
export function provisionCredentialStore(opts: ProvisionCredentialStoreOptions = {}): CredentialStore | undefined {
  const provider = (opts.provider ?? config.credentialStoreProvider ?? '').trim();
  if (!provider) {
    // No provider configured → no store. consume route fail-safes to needs_human.
    return undefined;
  }

  const kekLoader = opts.kekLoader ?? loadAesFileKekFromKeychain;
  return createCredentialStore({
    provider,
    // Only load a KEK when aesfile is actually selected (avoids touching the Keychain otherwise).
    aesFileKek: provider === 'aesfile' ? kekLoader() : undefined,
    aesFileStorePath: config.credentialStoreAesFilePath || undefined,
  });
}
