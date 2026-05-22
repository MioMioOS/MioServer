/**
 * CredentialStore factory — env-keyed selection with a fail-closed production allow-list (#72).
 *
 * This is the single place the control plane decides WHICH CredentialStore backs secret
 * resolution. It enforces two security invariants before constructing anything:
 *
 *  1. Production allow-list (assertProviderAllowedInEnv): in production ONLY a vetted production
 *     provider (ssm/kms/vault) may be selected. fixture/aesfile/unknown/empty → refuse to start.
 *  2. No fake success: a provider that is allow-listed but not yet implemented (ssm/kms/vault,
 *     blocked on #73) throws `not_implemented` rather than silently returning a store that can't
 *     resolve. Refusing to start is correct — running without secret resolution is worse.
 *
 * Selection key: `CREDENTIAL_STORE_PROVIDER` = fixture | aesfile | ssm | kms | vault.
 *
 * KEK SOURCING (aesfile only): the KEK MUST come from the OS Keychain / an independent secrets
 * manager and be passed in via `aesFileKek` — NEVER from `.env` (same dump surface as the DB,
 * invariant 5 in credentialStore.ts). The factory refuses to construct AesFileCredentialStore
 * without an explicit KEK rather than fabricating one.
 */

import {
  type CredentialStore,
  FixtureCredentialStore,
  AesFileCredentialStore,
  assertProviderAllowedInEnv,
} from './credentialStore.js';

export interface CreateCredentialStoreOptions {
  /** Provider id. Defaults to `process.env.CREDENTIAL_STORE_PROVIDER`. */
  provider?: string;
  /** Environment for the prod allow-list check. Defaults to `process.env.NODE_ENV`. */
  env?: string;
  /** aesfile only: 32-byte KEK from OS Keychain / secrets manager (NOT .env). */
  aesFileKek?: Buffer;
  /** aesfile only: encrypted store path (defaults to ~/.mio/credentials.enc inside the adapter). */
  aesFileStorePath?: string;
  /** fixture only: in-memory seed entries (test/CI). */
  fixtureEntries?: Record<string, string>;
}

/**
 * Construct the CredentialStore for the current environment, fail-closed.
 *
 * @throws Error if the provider is not allowed in the env (prod allow-list), is unknown/empty,
 *         is allow-listed-but-not-implemented (ssm/kms/vault → not_implemented), or aesfile is
 *         selected without a KEK.
 */
export function createCredentialStore(opts: CreateCredentialStoreOptions = {}): CredentialStore {
  const provider = (opts.provider ?? process.env.CREDENTIAL_STORE_PROVIDER ?? '').trim();
  const env = opts.env ?? process.env.NODE_ENV;

  // (1) Fail-closed allow-list FIRST: prod rejects fixture/aesfile/unknown/empty; non-prod rejects unknown.
  assertProviderAllowedInEnv(provider, env);

  switch (provider) {
    case 'fixture':
      // assertNotProduction inside the constructor is a second guard (assertProviderAllowedInEnv
      // already rejects fixture in prod, so this branch is non-prod only).
      return new FixtureCredentialStore(opts.fixtureEntries ?? {});

    case 'aesfile':
      if (!opts.aesFileKek) {
        throw new Error(
          "[SECURITY] CredentialStore provider 'aesfile' requires a 32-byte KEK from the OS Keychain " +
          'or an independent secrets manager (NOT .env). No KEK was provided. Refusing to start.',
        );
      }
      return new AesFileCredentialStore(opts.aesFileKek, opts.aesFileStorePath);

    case 'ssm':
    case 'kms':
    case 'vault':
      // Allow-listed for production, but the adapter is not built yet (blocked on #73 — Tencent SSM
      // infra prep). Fail closed with not_implemented instead of returning a non-resolving store.
      throw new Error(
        `[CredentialStore] provider '${provider}' is allow-listed for production but not yet ` +
        'implemented (not_implemented; blocked on #73). Refusing to start rather than running ' +
        'without secret resolution.',
      );

    default:
      // Unreachable: assertProviderAllowedInEnv rejects unknown/empty above. Kept fail-closed.
      throw new Error(`[CredentialStore] Unhandled provider '${provider || '(unset)'}' (not_configured).`);
  }
}
