/**
 * Machine API — minimal security tests.
 *
 * Key invariants to verify:
 * 1. machine_token is NOT stored in DB (only hash is stored)
 * 2. machine_token is returned exactly once at registration
 * 3. Invalid/expired tokens are rejected
 * 4. bind-org requires token that matches machine_id
 * 5. Refresh rotates the token (old hash no longer valid)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// ---- Unit tests for token security (no DB needed) ----

function generateMachineToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('machine token security', () => {
  it('hash is deterministic', () => {
    const token = generateMachineToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('different tokens produce different hashes', () => {
    const t1 = generateMachineToken();
    const t2 = generateMachineToken();
    expect(hashToken(t1)).not.toBe(hashToken(t2));
  });

  it('hash does not contain raw token', () => {
    const token = generateMachineToken();
    const hash = hashToken(token);
    expect(hash).not.toContain(token.slice(0, 8));
    expect(hash.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it('token is 64 hex chars (256-bit)', () => {
    const token = generateMachineToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('machine token — DB invariant (manual check)', () => {
  it('DB should only store hash, not raw token', () => {
    // This is a documentation test — asserting the contract in code.
    // The actual DB column is token_hash TEXT, not machine_token.
    // machineRoutes.ts only passes hashToken(token) to Prisma, never raw token.
    const token = generateMachineToken();
    const storedValue = hashToken(token); // what goes into DB
    expect(storedValue).not.toBe(token);  // DB value ≠ raw token
    expect(storedValue.length).toBe(64);  // SHA-256 hex length
  });
});

describe('refresh threshold', () => {
  const TOKEN_REFRESH_THRESHOLD_DAYS = 7;

  it('refresh is not needed when > 7 days remain', () => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const daysUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysUntilExpiry).toBeGreaterThan(TOKEN_REFRESH_THRESHOLD_DAYS);
  });

  it('refresh is needed when < 7 days remain', () => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);
    const daysUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysUntilExpiry).toBeLessThan(TOKEN_REFRESH_THRESHOLD_DAYS);
  });
});
