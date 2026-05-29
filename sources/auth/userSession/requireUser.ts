/**
 * Slice 7 — Task A3: requireUser preHandler middleware.
 *
 * Authenticates an incoming Bearer token against `UserSession`, optionally
 * authorizes the user for a target ControlWorkroom (membership check), and
 * sets request-scoped state (`req.user`, `req.userSession`, `req.userWorkroomRole`)
 * for downstream handlers.
 *
 * Side effect: best-effort sliding-window expiry bump on the session
 * (throttled to once per 12h per session, in-memory only — no DB load).
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md §6.2
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { db } from '@/storage/db';
import { USER_SESSION_TOKEN_PREFIX, hashUserSessionToken } from './tokenMint';

declare module 'fastify' {
    interface FastifyRequest {
        user?: { id: string };
        userSession?: { id: string; userId: string };
        userWorkroomRole?: string;
    }
}

export type WorkroomLoc = {
    workroomIdFrom: 'param' | 'query' | 'body';
    paramName?: string;
};

export function requireUser(loc?: WorkroomLoc): preHandlerHookHandler {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }
        const token = auth.slice(7);
        if (!token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }

        const session = await db.userSession.findUnique({
            where: { tokenHash: hashUserSessionToken(token) },
        });
        if (!session || session.revokedAt !== null || session.expiresAt <= new Date()) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }

        req.user = { id: session.userId };
        req.userSession = { id: session.id, userId: session.userId };

        if (loc) {
            const wkId = extractWorkroomId(req, loc);
            if (wkId) {
                const mem = await db.userWorkroomMembership.findUnique({
                    where: { userId_workroomId: { userId: session.userId, workroomId: wkId } },
                });
                if (!mem) {
                    return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
                }
                req.userWorkroomRole = mem.role;
            }
        }

        // Fire-and-forget sliding-window expiry bump. Failures are swallowed —
        // a missed bump only shortens this session's TTL, never blocks the call.
        maybeBumpExpiresAt(session).catch(() => {
            /* fire-and-forget */
        });
    };
}

/**
 * Like {@link requireUser} but additionally requires `role === 'owner'`.
 * Used by write-side Slock routes (B chunk).
 */
export function requireUserWrite(loc: WorkroomLoc): preHandlerHookHandler {
    const base = requireUser(loc);
    return async (req: FastifyRequest, reply: FastifyReply) => {
        // The async overload of preHandlerHookHandler ignores `done`; we just
        // delegate to the base async handler and check its reply state.
        await (base as unknown as (req: FastifyRequest, reply: FastifyReply) => Promise<void>)(
            req,
            reply,
        );
        if (reply.sent) return;
        if (req.userWorkroomRole !== 'owner') {
            return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
        }
    };
}

function extractWorkroomId(req: FastifyRequest, loc: WorkroomLoc): string | null {
    const name = loc.paramName ?? 'workroom_id';
    const params = (req.params as Record<string, unknown>) ?? {};
    const query = (req.query as Record<string, unknown>) ?? {};
    const body = (req.body as Record<string, unknown>) ?? {};
    const raw =
        loc.workroomIdFrom === 'param'
            ? params[name]
            : loc.workroomIdFrom === 'query'
              ? query[name]
              : body[name];
    return typeof raw === 'string' ? raw : null;
}

// Throttle bumpExpiresAt to once per 12h per session (in-memory map only;
// no persistence required — worst case after a restart we bump once more).
const lastBumpAt = new Map<string, number>();
const BUMP_THROTTLE_MS = 12 * 3600 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function maybeBumpExpiresAt(session: { id: string; expiresAt: Date }): Promise<void> {
    const prev = lastBumpAt.get(session.id) ?? 0;
    if (Date.now() - prev < BUMP_THROTTLE_MS) return;
    lastBumpAt.set(session.id, Date.now());
    await db.userSession.update({
        where: { id: session.id },
        data: {
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            lastUsedAt: new Date(),
        },
    });
}
