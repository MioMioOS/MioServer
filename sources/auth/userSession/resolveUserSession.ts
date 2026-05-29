/**
 * Slice 7 — shared helper: resolve a user_sess_ Bearer to a live UserSession.
 *
 * Extracted from userSessionRoutes.ts (A4) so the chat-side `/v1/auth` route
 * (A5) can hard-require a user bearer using identical semantics. Centralising
 * here prevents the two endpoints drifting on what counts as a valid session
 * (prefix, revocation, expiry).
 *
 * Returns the raw `UserSession` row on success, `null` on any failure:
 *   - missing/non-Bearer header
 *   - wrong token prefix
 *   - token hash not found
 *   - session revoked
 *   - session expired
 *
 * Spec: §6.1 (chat-side auth must bind to user) + §6.2 (requireUser semantics).
 */
import type { FastifyRequest } from 'fastify';
import { db } from '@/storage/db';
import { USER_SESSION_TOKEN_PREFIX, hashUserSessionToken } from './tokenMint';

export async function resolveUserSession(
    authorizationHeader: string | undefined,
) {
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authorizationHeader.slice(7);
    if (!token.startsWith(USER_SESSION_TOKEN_PREFIX)) return null;

    const session = await db.userSession.findUnique({
        where: { tokenHash: hashUserSessionToken(token) },
    });
    if (!session || session.revokedAt !== null || session.expiresAt <= new Date()) {
        return null;
    }
    return session;
}

/** Convenience wrapper for callers that already have a FastifyRequest. */
export function resolveUserSessionFromRequest(req: FastifyRequest) {
    return resolveUserSession(req.headers.authorization);
}
