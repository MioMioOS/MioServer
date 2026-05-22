import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { provisionCredentialStore, loadAesFileKekFromKeychain } from './provisionCredentialStore.js';
import { FixtureCredentialStore, AesFileCredentialStore } from './credentialStore.js';

// provisionCredentialStore reads config.credentialStoreProvider, which is derived from
// process.env.CREDENTIAL_STORE_PROVIDER at module load. Tests pass `provider` via opts to avoid
// depending on that load-time snapshot, and inject `kekLoader` to avoid touching the real Keychain.

const fakeKek = () => randomBytes(32);

describe('provisionCredentialStore — bootstrap selection', () => {
  it('unset provider → undefined (consume route fail-safes to needs_human)', () => {
    expect(provisionCredentialStore({ provider: '' })).toBeUndefined();
    expect(provisionCredentialStore({ provider: '   ' })).toBeUndefined();
  });

  it('fixture → FixtureCredentialStore (non-prod)', () => {
    // NODE_ENV is not 'production' in the test runner, so fixture is allowed.
    const store = provisionCredentialStore({ provider: 'fixture' });
    expect(store).toBeInstanceOf(FixtureCredentialStore);
  });

  it('aesfile → AesFileCredentialStore, using the injected KEK loader (never .env)', () => {
    const store = provisionCredentialStore({ provider: 'aesfile', kekLoader: fakeKek });
    expect(store).toBeInstanceOf(AesFileCredentialStore);
  });

  it('aesfile → KEK loader is only invoked when aesfile is selected', () => {
    let called = 0;
    const loader = () => { called += 1; return randomBytes(32); };
    // fixture selected → loader must NOT run
    provisionCredentialStore({ provider: 'fixture', kekLoader: loader });
    expect(called).toBe(0);
    // aesfile selected → loader runs exactly once
    provisionCredentialStore({ provider: 'aesfile', kekLoader: loader });
    expect(called).toBe(1);
  });

  it('ssm → not_implemented (blocked on #73), never a fake store', () => {
    expect(() => provisionCredentialStore({ provider: 'ssm' })).toThrow(/not_implemented; blocked on #73/);
  });

  it('unknown provider → rejected', () => {
    expect(() => provisionCredentialStore({ provider: 'mystery' })).toThrow(/Unknown CredentialStore provider/);
  });
});

describe('loadAesFileKekFromKeychain — host guard', () => {
  it('refuses on non-macOS hosts (KEK must be Keychain/managed-secret, never .env)', () => {
    if (process.platform === 'darwin') {
      // On macOS this would attempt a real Keychain read; covered by manual test, skip the assertion.
      return;
    }
    expect(() => loadAesFileKekFromKeychain()).toThrow(/not.*macOS|never come from \.env/i);
  });
});
