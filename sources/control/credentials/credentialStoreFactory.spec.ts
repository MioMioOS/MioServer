import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { createCredentialStore } from './credentialStoreFactory.js';
import { FixtureCredentialStore, AesFileCredentialStore } from './credentialStore.js';

// All tests pass env/provider explicitly via opts so they never depend on or mutate process.env.

describe('createCredentialStore — provider selection', () => {
  it('fixture (non-prod) → FixtureCredentialStore', () => {
    const store = createCredentialStore({ provider: 'fixture', env: 'development', fixtureEntries: { 'ref:a': 'v' } });
    expect(store).toBeInstanceOf(FixtureCredentialStore);
  });

  it('aesfile (non-prod) with KEK → AesFileCredentialStore', () => {
    const store = createCredentialStore({
      provider: 'aesfile',
      env: 'development',
      aesFileKek: randomBytes(32),
      aesFileStorePath: '/tmp/mio-factory-test.enc',
    });
    expect(store).toBeInstanceOf(AesFileCredentialStore);
  });

  it('aesfile without KEK → refuses to construct (no fabricated KEK)', () => {
    expect(() => createCredentialStore({ provider: 'aesfile', env: 'development' })).toThrow(/requires a 32-byte KEK/);
  });
});

describe('createCredentialStore — production fail-closed allow-list', () => {
  it('fixture in production → refused (dev/test store forbidden in prod)', () => {
    expect(() => createCredentialStore({ provider: 'fixture', env: 'production' })).toThrow(/not allowed in production/);
  });

  it('aesfile in production → refused (dev-local store forbidden in prod)', () => {
    expect(() => createCredentialStore({ provider: 'aesfile', env: 'production', aesFileKek: randomBytes(32) }))
      .toThrow(/not allowed in production/);
  });

  it('unknown provider (non-prod) → Unknown provider', () => {
    expect(() => createCredentialStore({ provider: 'mystery', env: 'development' }))
      .toThrow(/Unknown CredentialStore provider/);
  });

  it('empty/unset provider → refused (must explicitly choose)', () => {
    expect(() => createCredentialStore({ provider: '', env: 'development' })).toThrow();
    expect(() => createCredentialStore({ provider: undefined as unknown as string, env: 'development' })).toThrow();
  });
});

describe('createCredentialStore — production providers not yet implemented (#73)', () => {
  it.each(['ssm', 'kms', 'vault'])('%s (non-prod) → not_implemented (blocked on #73), never a fake store', (p) => {
    expect(() => createCredentialStore({ provider: p, env: 'development' })).toThrow(/not_implemented; blocked on #73/);
  });

  it('ssm in PRODUCTION → not_implemented (fail-closed, NOT a silently non-resolving store)', () => {
    // ssm IS allow-listed for prod, so the allow-list guard passes; the factory must then refuse
    // because the adapter is not built — better to fail startup than run without secret resolution.
    expect(() => createCredentialStore({ provider: 'ssm', env: 'production' })).toThrow(/not_implemented; blocked on #73/);
  });
});

describe('createCredentialStore — env var fallback', () => {
  it('reads provider from process.env.CREDENTIAL_STORE_PROVIDER when opts.provider is absent', () => {
    const prev = process.env.CREDENTIAL_STORE_PROVIDER;
    process.env.CREDENTIAL_STORE_PROVIDER = 'fixture';
    try {
      const store = createCredentialStore({ env: 'development' });
      expect(store).toBeInstanceOf(FixtureCredentialStore);
    } finally {
      if (prev === undefined) delete process.env.CREDENTIAL_STORE_PROVIDER;
      else process.env.CREDENTIAL_STORE_PROVIDER = prev;
    }
  });
});
