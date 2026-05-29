import { describe, it, expect } from 'vitest';
import { mintUserSessionToken, hashUserSessionToken, USER_SESSION_TOKEN_PREFIX } from './tokenMint';

describe('tokenMint', () => {
    it('prefixed token, unique each call', () => {
        const a = mintUserSessionToken();
        const b = mintUserSessionToken();
        expect(a.startsWith(USER_SESSION_TOKEN_PREFIX)).toBe(true);
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(40);
    });
    it('hashUserSessionToken is sha256 hex', () => {
        const t = mintUserSessionToken();
        expect(hashUserSessionToken(t)).toHaveLength(64);
        expect(hashUserSessionToken(t)).toBe(hashUserSessionToken(t));
    });
});
