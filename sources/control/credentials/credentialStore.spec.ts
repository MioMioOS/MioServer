import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  FixtureCredentialStore,
  AesFileCredentialStore,
  CredentialStoreError,
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
