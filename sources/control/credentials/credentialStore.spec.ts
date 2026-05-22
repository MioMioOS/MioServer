import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  FixtureCredentialStore,
  AesFileCredentialStore,
  CredentialStoreError,
  NEEDS_HUMAN_RESOLVE_REASONS,
  isCredentialDenial,
  assertProviderAllowedInEnv,
  PROD_CREDENTIAL_PROVIDERS,
} from './credentialStore.js';
import { randomBytes } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const CTX = { credentialId: 'cred-1', orgId: 'org-1' };

describe('FixtureCredentialStore', () => {
  it('resolves a seeded entry', async () => {
    const store = new FixtureCredentialStore({ 'ref:asc_key': 'secret_value_abc' });
    const val = await store.resolve('ref:asc_key', CTX);
    expect(val).toBe('secret_value_abc');
  });

  it('throws credential_not_found for missing ref', async () => {
    const store = new FixtureCredentialStore();
    await expect(store.resolve('ref:missing', CTX)).rejects.toMatchObject({
      reason: 'credential_not_found',
    });
  });

  it('seed() adds entries after construction', async () => {
    const store = new FixtureCredentialStore();
    store.seed('ref:late', 'late_value');
    expect(await store.resolve('ref:late', CTX)).toBe('late_value');
  });

  it('error message does not contain secret value', async () => {
    const store = new FixtureCredentialStore({ 'ref:k': 'super_secret_xyz' });
    try {
      await store.resolve('ref:missing', CTX);
    } catch (e) {
      if (e instanceof CredentialStoreError) {
        expect(e.message).not.toContain('super_secret_xyz');
      }
    }
  });
});

describe('AesFileCredentialStore', () => {
  let tmpDir: string;
  let storePath: string;
  let kek: Buffer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mio-cred-test-'));
    storePath = join(tmpDir, 'credentials.enc');
    kek = randomBytes(32);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a secret through encrypt/decrypt', async () => {
    const store = new AesFileCredentialStore(kek, storePath);
    await store.set('ref:asc', 'my_secret_p8_key');
    const resolved = await store.resolve('ref:asc', CTX);
    expect(resolved).toBe('my_secret_p8_key');
  });

  it('different KEK cannot decrypt', async () => {
    const store1 = new AesFileCredentialStore(kek, storePath);
    await store1.set('ref:key', 'secret123');

    const store2 = new AesFileCredentialStore(randomBytes(32), storePath);
    await expect(store2.resolve('ref:key', CTX)).rejects.toMatchObject({
      reason: 'credential_config_invalid',
    });
  });

  it('throws store_unavailable when file missing', async () => {
    const store = new AesFileCredentialStore(kek, join(tmpDir, 'nonexistent.enc'));
    await expect(store.resolve('ref:missing', CTX)).rejects.toMatchObject({
      reason: 'store_unavailable',
    });
  });

  it('throws credential_not_found when ref not in store', async () => {
    const store = new AesFileCredentialStore(kek, storePath);
    await store.set('ref:other', 'some_value');
    await expect(store.resolve('ref:nothere', CTX)).rejects.toMatchObject({
      reason: 'credential_not_found',
    });
  });

  it('rejects 31-byte KEK', () => {
    expect(() => new AesFileCredentialStore(Buffer.alloc(31), storePath)).toThrow('32 bytes');
  });

  it('error messages do not contain secret value', async () => {
    const store = new AesFileCredentialStore(kek, storePath);
    await store.set('ref:k', 'ultra_secret_value');
    const wrongStore = new AesFileCredentialStore(randomBytes(32), storePath);
    try {
      await wrongStore.resolve('ref:k', CTX);
    } catch (e) {
      if (e instanceof CredentialStoreError) {
        expect(e.message).not.toContain('ultra_secret_value');
      }
    }
  });
});

describe('prod guard', () => {
  it('FixtureCredentialStore throws in production', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FixtureCredentialStore()).toThrow('forbidden in production');
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('AesFileCredentialStore throws in production', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new AesFileCredentialStore(randomBytes(32), '/tmp/test.enc')).toThrow('forbidden in production');
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

// ── #72: credential_denied vs infra-error split + prod provider fail-closed ──────

describe('#72 failure-reason split (denial vs infra)', () => {
  it('infra reasons are in NEEDS_HUMAN set; credential_denied is NOT', () => {
    expect(NEEDS_HUMAN_RESOLVE_REASONS.has('store_unavailable')).toBe(true);
    expect(NEEDS_HUMAN_RESOLVE_REASONS.has('credential_not_found')).toBe(true);
    expect(NEEDS_HUMAN_RESOLVE_REASONS.has('credential_config_invalid')).toBe(true);
    // credential_denied must NOT be treated as a recoverable infra error.
    expect(NEEDS_HUMAN_RESOLVE_REASONS.has('credential_denied' as never)).toBe(false);
  });

  it('isCredentialDenial only true for credential_denied', () => {
    expect(isCredentialDenial('credential_denied')).toBe(true);
    expect(isCredentialDenial('store_unavailable')).toBe(false);
    expect(isCredentialDenial('credential_not_found')).toBe(false);
    expect(isCredentialDenial('credential_config_invalid')).toBe(false);
  });
});

describe('#72 assertProviderAllowedInEnv (prod fail-closed)', () => {
  it('production allows only vetted prod providers', () => {
    for (const p of PROD_CREDENTIAL_PROVIDERS) {
      expect(() => assertProviderAllowedInEnv(p, 'production')).not.toThrow();
    }
  });

  it('production rejects dev/test + unknown + empty providers (fail-closed)', () => {
    for (const p of ['fixture', 'aesfile', 'mystery', '', undefined]) {
      expect(() => assertProviderAllowedInEnv(p, 'production')).toThrow(/not allowed in production/);
    }
  });

  it('non-production allows any KNOWN provider (prod or dev)', () => {
    for (const p of ['fixture', 'aesfile', 'ssm', 'kms', 'vault']) {
      expect(() => assertProviderAllowedInEnv(p, 'development')).not.toThrow();
    }
  });

  it('non-production still rejects an unknown provider', () => {
    expect(() => assertProviderAllowedInEnv('mystery', 'development')).toThrow(/Unknown CredentialStore provider/);
  });
});
