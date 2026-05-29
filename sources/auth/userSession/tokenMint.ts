import { randomBytes, createHash } from 'crypto';

export const USER_SESSION_TOKEN_PREFIX = 'user_sess_';

/**
 * Mint an opaque user-session bearer token: `user_sess_<32 random bytes, base64url>`.
 * Stored in the DB only as its sha256 hash (see {@link hashUserSessionToken}).
 */
export function mintUserSessionToken(): string {
    return USER_SESSION_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Compute the sha256 hex digest of a user-session token. Used at lookup time
 * to match an incoming bearer token against the `UserSession.tokenHash` column.
 */
export function hashUserSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
