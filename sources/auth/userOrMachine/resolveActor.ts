/**
 * Slice 7 — Task B2-a: shared "userOrMachine" actor resolver for multi-actor
 * read surfaces (memberRoutes, searchRoutes, explanationRoutes, and B2-b…e).
 *
 * Why this exists
 * ----------------
 * Some control-plane GET endpoints must accept BOTH:
 *   1. A user session bearer (`user_sess_…`)  — phone/iOS, MioIsland-issued.
 *   2. A machine token bearer (`machine_…`)   — daemons / mio-agent.
 *
 * The previous dual-auth (`authorizeControlRead` = machine_token OR dev_ctl_)
 * is gone with Slice 7. This helper is the replacement on multi-actor reads.
 * For single-actor surfaces use `requireUser` (humans only) or `verifyMachineToken`
 * (daemons only); use `resolveActor` / `requireActor` only when both must work.
 *
 * Workroom semantics
 * -------------------
 * If `opts.workroomId` is provided to `resolveActor`, the helper enforces the
 * caller is bound to that workroom BEFORE returning. Failure modes:
 *   - user path: membership row missing → returns null (handler maps to 403)
 *   - machine path: machine.orgId !== workroom.orgId, machine has no org, or
 *                   the workroom is missing → returns null (handler maps to
 *                   403 / 404 via `requireActor`'s reply logic). For finer
 *                   error codes the caller can run `requireMachineAccessToWorkroom`
 *                   itself after `resolveActor`.
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md
 *       §6.2 + Task B2-a controller decision.
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

export type Actor =
    | {
          kind: 'user';
          userId: string;
          sessionId: string;
          /** Membership role for the workroom we were resolved against, if any. */
          workroomRole: string | null;
      }
    | {
          kind: 'machine';
          machineId: string;
          orgId: string;
      };

declare module 'fastify' {
    interface FastifyRequest {
        /** Populated by `requireActor` (or manual `resolveActor`) on multi-actor routes. */
        actor?: Actor;
    }
}

export interface ResolveActorOpts {
    /**
     * If provided, the resolver enforces workroom scope before returning:
     *   - user → must have a UserWorkroomMembership row for this workroom
     *   - machine → machine.orgId must match controlWorkroom.orgId
     * Failure → returns null (caller responds 401/403 uniformly).
     */
    workroomId?: string;
}

/**
 * Resolve a Bearer token to an Actor (user OR machine). Returns null when:
 *   - No Bearer header
 *   - Token doesn't match a known prefix / not a live session / not a live machine_token
 *   - workroomId provided and the actor is not scoped to it
 *
 * Does NOT send a reply — leaves HTTP responses to the caller (`requireActor` or
 * a handler that wants custom error codes). For most multi-actor reads, use
 * `requireActor()` as a preHandler.
 */
export async function resolveActor(
    req: FastifyRequest,
    opts?: ResolveActorOpts,
): Promise<Actor | null> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    if (!token) return null;

    // ── Path 1: user_sess_ ──
    if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
        const session = await resolveUserSession(auth);
        if (!session) return null;
        let role: string | null = null;
        if (opts?.workroomId) {
            const mem = await db.userWorkroomMembership.findUnique({
                where: {
                    userId_workroomId: {
                        userId: session.userId,
                        workroomId: opts.workroomId,
                    },
                },
            });
            if (!mem) return null;
            role = mem.role;
        }
        return {
            kind: 'user',
            userId: session.userId,
            sessionId: session.id,
            workroomRole: role,
        };
    }

    // ── Path 2: machine_token ──
    // machine_ tokens don't have a hard prefix guard in verifyMachineToken (any
    // Bearer is hash-looked up), so we don't gate by prefix here either — the
    // hash lookup is the source of truth.
    const machine = await verifyMachineToken(auth);
    if (!machine) return null;
    if (!machine.orgId) return null;

    if (opts?.workroomId) {
        const access = await requireMachineAccessToWorkroom(machine, opts.workroomId);
        if (!access.ok) return null;
    }
    return { kind: 'machine', machineId: machine.id, orgId: machine.orgId };
}

export interface RequireActorOpts {
    /** Where to read the target workroom id from. Omit to skip workroom scope check. */
    workroomIdFrom?: 'param' | 'query' | 'body';
    /** Name of the param/query/body field; defaults to 'workroom_id'. */
    paramName?: string;
}

/**
 * preHandler middleware. Resolves an Actor and sets `req.actor`, or short-circuits
 * with a uniform 401 ("INVALID_SESSION") on any failure — including failed workroom
 * scope. We use 401 uniformly (rather than 401-for-anonymous-vs-403-for-scoped)
 * because:
 *   - The user-vs-machine path divergence on a 403 would leak which actor the
 *     server thinks the caller is.
 *   - Per-actor membership/workroom mismatches should not enumerate workroom ids.
 *
 * Routes that NEED distinct 401/403/404 (e.g. memberRoutes preserving the "missing
 * workroom → 404" semantic) should call `resolveActor` manually instead.
 */
export function requireActor(opts: RequireActorOpts = {}): preHandlerHookHandler {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const workroomId = extractWorkroomId(req, opts);
        const actor = await resolveActor(req, workroomId ? { workroomId } : undefined);
        if (!actor) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }
        req.actor = actor;
    };
}

function extractWorkroomId(req: FastifyRequest, opts: RequireActorOpts): string | null {
    if (!opts.workroomIdFrom) return null;
    const name = opts.paramName ?? 'workroom_id';
    const src =
        opts.workroomIdFrom === 'param'
            ? (req.params as Record<string, unknown>) ?? {}
            : opts.workroomIdFrom === 'query'
              ? (req.query as Record<string, unknown>) ?? {}
              : (req.body as Record<string, unknown>) ?? {};
    const raw = src[name];
    return typeof raw === 'string' ? raw : null;
}

/**
 * Derive an opaque "viewer id" from an Actor for callers that previously used
 * `auth.mode === 'machine' ? auth.machine.id : auth.devToken.id`. Maps to:
 *   - user actor    → user.id
 *   - machine actor → machine.id
 *
 * This is the identity used for channel-membership lookup in `visibleChannels`
 * and for `senderId` filters in `MY_MESSAGES` search.
 */
export function viewerIdFromActor(actor: Actor): string {
    return actor.kind === 'user' ? actor.userId : actor.machineId;
}
