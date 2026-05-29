/**
 * Slice 7 — Task A4: public user-auth endpoints.
 *
 *   POST   /v1/users/signin   { email, password }              → 200 + token + workrooms
 *   POST   /v1/users/signout  Bearer user_sess_                  → 204
 *   GET    /v1/users/me       Bearer user_sess_                  → 200 + me + workrooms
 *   DELETE /v1/users/me       Bearer user_sess_ + { password }   → 204
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md
 *       §5.1–§5.4 (contracts), §9.1 T1–T11 (tests), §10 (timing + rate limit).
 *
 * Notes:
 *  - signin runs bcrypt against DUMMY_PASSWORD_HASH on unknown-email to keep
 *    timing constant (anti-enumeration, spec §10).
 *  - Rate limit: 5/min per IP on signin only; 6th attempt → 429 + Retry-After.
 *    In-memory sliding window — process-local; fine for dogfood single-instance.
 *  - me does a throttled (once / 12h) sliding-refresh bump on expiresAt.
 *  - DELETE /me cascades sessions + memberships; Device.userId FK is
 *    `onDelete: SetNull` so Postgres nulls the column automatically.
 *    Solo-owned workrooms are LEFT ORPHANED in this slice — see file footer.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '@/storage/db';
import { verifyPassword, DUMMY_PASSWORD_HASH } from './passwordHash';
import {
    mintUserSessionToken,
    hashUserSessionToken,
    USER_SESSION_TOKEN_PREFIX,
} from './tokenMint';
import { resolveUserSession } from './resolveUserSession';
import { generateIdenticon } from '@/control/profile/identicon';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const BUMP_THROTTLE_MS = 12 * 3600 * 1000;
// Spec §5.3: only refresh a session whose remaining TTL has dipped below 25d
// (i.e. it's aged more than 5d since last bump/mint). Avoids a write per /me
// for fresh sessions.
const BUMP_STALENESS_MS = 25 * 24 * 3600 * 1000;

const RL_WINDOW_MS = 60_000;
const RL_MAX_PER_IP = 5;
// Spec §10: per-email lock — defends against credential stuffing across a
// rotating proxy pool that would defeat the per-IP gate alone.
const RL_EMAIL_WINDOW_MS = 15 * 60_000;
const RL_EMAIL_MAX = 10;

// IP → recent attempt timestamps (sliding window).
// Memory bound: when a bucket filters down to empty (offender's burst aged
// out) we DELETE the key instead of leaving an empty array behind, so the
// Map stays sized to currently-active offenders, not lifetime visitors.
const rateBuckets = new Map<string, number[]>();
function rateLimitOk(ip: string): boolean {
    const now = Date.now();
    const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
    if (arr.length >= RL_MAX_PER_IP) {
        if (arr.length === 0) rateBuckets.delete(ip);
        else rateBuckets.set(ip, arr);
        return false;
    }
    arr.push(now);
    rateBuckets.set(ip, arr);
    return true;
}

// email (lower-cased) → recent attempt timestamps (15-min sliding window).
// Same bounded-map discipline as rateBuckets above.
const rateBucketsByEmail = new Map<string, number[]>();
function rateLimitEmailOk(email: string): boolean {
    const key = email.toLowerCase();
    const now = Date.now();
    const arr = (rateBucketsByEmail.get(key) ?? []).filter(
        (t) => now - t < RL_EMAIL_WINDOW_MS,
    );
    if (arr.length >= RL_EMAIL_MAX) {
        if (arr.length === 0) rateBucketsByEmail.delete(key);
        else rateBucketsByEmail.set(key, arr);
        return false;
    }
    arr.push(now);
    rateBucketsByEmail.set(key, arr);
    return true;
}

// Test-only escape hatch — lets the integration spec start each case with a
// clean slate so prior signin attempts in a sibling test don't leak in.
export function __resetUserSessionRateLimit(): void {
    rateBuckets.clear();
    rateBucketsByEmail.clear();
    lastBumpAt.clear();
}

const lastBumpAt = new Map<string, number>();
// Cheap canary — when the map outgrows this we sweep entries whose throttle
// window has expired. Keeps memory bounded to "recently-bumped sessions"
// without a separate timer.
const LAST_BUMP_SWEEP_CANARY = 1000;

async function maybeBump(session: { id: string; expiresAt: Date }): Promise<void> {
    // Lazy sweep — only iterates when the map gets large, and only deletes
    // entries whose throttle window has expired (i.e. they couldn't suppress
    // a future bump anyway).
    if (lastBumpAt.size > LAST_BUMP_SWEEP_CANARY) {
        const cutoff = Date.now() - BUMP_THROTTLE_MS;
        for (const [k, t] of lastBumpAt) {
            if (t < cutoff) lastBumpAt.delete(k);
        }
    }

    // Spec §5.3: skip the bump if the session is NOT yet stale (still has
    // > 25d of TTL left). Without this gate a fresh session would re-bump
    // every 12h forever, generating unnecessary writes.
    const staleAfter = new Date(Date.now() + BUMP_STALENESS_MS);
    if (session.expiresAt >= staleAfter) return;

    const prev = lastBumpAt.get(session.id) ?? 0;
    if (Date.now() - prev < BUMP_THROTTLE_MS) return;
    // Throttle-set goes AFTER a successful update — if the write throws (DB
    // blip), we WANT the next request to retry. Setting it first would arm
    // the throttle on a failed write and silently skip bumps for 12h.
    try {
        await db.userSession.update({
            where: { id: session.id },
            data: {
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
                lastUsedAt: new Date(),
            },
        });
        lastBumpAt.set(session.id, Date.now());
    } catch {
        // Swallow — caller treats maybeBump as fire-and-forget. lastBumpAt
        // stays untouched so the next /me retries the bump.
    }
}

function bearer(req: FastifyRequest): string | null {
    const a = req.headers.authorization;
    if (!a || !a.startsWith('Bearer ')) return null;
    return a.slice(7);
}

// Thin local alias preserved for call-site clarity; semantics live in the
// shared resolveUserSession helper (so /v1/auth in A5 stays in lockstep).
async function resolveSession(req: FastifyRequest) {
    return resolveUserSession(req.headers.authorization);
}

async function loadWorkrooms(userId: string) {
    // Stable ordering for clients: ascending by membership createdAt — earliest
    // join first. Without an explicit orderBy Postgres returns rows in any
    // order and clients that key off list position would break flakily.
    const memberships = await db.userWorkroomMembership.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
    });
    if (memberships.length === 0) return [];
    const workrooms = await db.controlWorkroom.findMany({
        where: { id: { in: memberships.map((m) => m.workroomId) } },
    });
    const byId = new Map(workrooms.map((w) => [w.id, w]));
    return memberships.map((m) => ({
        id: m.workroomId,
        name: byId.get(m.workroomId)?.name ?? '',
        role: m.role,
    }));
}

// display_name bounds (mirrors agentApiProfile.ts validation style: must be a
// non-empty string after trim). Upper bound guards against unbounded UI input.
const DISPLAY_NAME_MAX_LEN = 80;

type MeUserRow = { id: string; email: string; displayName: string | null };

/**
 * Public shape of a user identity, shared by signin / GET /me / PATCH /me so the
 * three stay in lockstep. avatar is a derived identicon (data-URI SVG) seeded by
 * displayName when set, else the email — there is NO avatar column.
 */
function buildMe(user: MeUserRow) {
    return {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        avatar: generateIdenticon(user.displayName || user.email),
    };
}

export const userSessionRoutes: FastifyPluginAsync = async (app) => {
    app.post('/v1/users/signin', async (req, reply) => {
        // Order matters: IP gate fires BEFORE we read the email — otherwise
        // attackers could probe whether an email is currently locked by
        // observing the 429 shape (and which window it came from).
        const ip = req.ip;
        if (!rateLimitOk(ip)) {
            reply.header('Retry-After', String(Math.ceil(RL_WINDOW_MS / 1000)));
            return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
        }

        const body = req.body as { email?: unknown; password?: unknown } | null;
        if (
            !body ||
            typeof body.email !== 'string' ||
            typeof body.password !== 'string'
        ) {
            return reply.code(400).send({ error: { code: 'INVALID_BODY' } });
        }

        // Per-email lock (spec §10) — kicks in for distributed credential
        // stuffing where IPs rotate but the target email is fixed.
        if (!rateLimitEmailOk(body.email)) {
            reply.header(
                'Retry-After',
                String(Math.ceil(RL_EMAIL_WINDOW_MS / 1000)),
            );
            return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
        }

        const user = await db.user.findUnique({ where: { email: body.email } });
        // Timing-constant: ALWAYS bcrypt-compare, even on unknown email,
        // against a fixed dummy hash so unknown-email and wrong-password
        // paths take the same wall-clock time. Spec §10.
        const hashToCheck = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
        const passwordOk = await verifyPassword(body.password, hashToCheck);
        if (!user || !passwordOk) {
            return reply
                .code(401)
                .send({ error: { code: 'EMAIL_OR_PASSWORD_INVALID' } });
        }

        const rawToken = mintUserSessionToken();
        await db.userSession.create({
            data: {
                userId: user.id,
                tokenHash: hashUserSessionToken(rawToken),
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        });

        const workrooms = await loadWorkrooms(user.id);
        return reply.code(200).send({
            token: rawToken,
            user: buildMe(user),
            default_workroom_id: user.defaultWorkroomId,
            workrooms,
        });
    });

    app.post('/v1/users/signout', async (req, reply) => {
        const token = bearer(req);
        // Idempotent: no token, bad token, already-revoked — all → 204.
        // Avoids leaking whether the token was ever valid.
        if (token && token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
            await db.userSession.updateMany({
                where: {
                    tokenHash: hashUserSessionToken(token),
                    revokedAt: null,
                },
                data: { revokedAt: new Date() },
            });
        }
        return reply.code(204).send();
    });

    app.get('/v1/users/me', async (req, reply) => {
        const session = await resolveSession(req);
        if (!session) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }
        const user = await db.user.findUnique({ where: { id: session.userId } });
        if (!user) {
            // User row vanished beneath a still-valid session — treat as logged out.
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }
        const workrooms = await loadWorkrooms(user.id);
        // Sliding refresh — fire-and-forget so the response isn't gated on the
        // write. Throttled to once / 12h per session.
        maybeBump(session).catch(() => {
            /* fire-and-forget */
        });
        return reply.code(200).send({
            user: buildMe(user),
            default_workroom_id: user.defaultWorkroomId,
            workrooms,
        });
    });

    // PATCH /v1/users/me — update editable profile fields (currently only
    // display_name). Validation mirrors agentApiProfile.ts: present-but-invalid
    // → 400 INVALID_BODY; nothing to update → 400 INVALID_BODY. Returns the same
    // shape as GET /v1/users/me so the client can hydrate from the response.
    app.patch('/v1/users/me', async (req, reply) => {
        const session = await resolveSession(req);
        if (!session) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }

        const body = req.body as { display_name?: unknown } | null;
        const updateData: { displayName?: string } = {};

        if (body?.display_name !== undefined) {
            if (typeof body.display_name !== 'string') {
                return reply.code(400).send({
                    error: { code: 'INVALID_BODY', message: 'display_name must be a string' },
                });
            }
            const trimmed = body.display_name.trim();
            if (trimmed === '') {
                return reply.code(400).send({
                    error: { code: 'INVALID_BODY', message: 'display_name must be a non-empty string' },
                });
            }
            if (trimmed.length > DISPLAY_NAME_MAX_LEN) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_BODY',
                        message: `display_name must be at most ${DISPLAY_NAME_MAX_LEN} characters`,
                    },
                });
            }
            updateData.displayName = trimmed;
        }

        if (Object.keys(updateData).length === 0) {
            return reply.code(400).send({
                error: { code: 'INVALID_BODY', message: 'display_name must be provided' },
            });
        }

        // Guard the user-vanished race the same way GET /me does: update can
        // throw P2025 if the row was deleted beneath a still-valid session.
        let updated: MeUserRow & { defaultWorkroomId: string | null };
        try {
            updated = await db.user.update({
                where: { id: session.userId },
                data: updateData,
                select: { id: true, email: true, displayName: true, defaultWorkroomId: true },
            });
        } catch {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }

        const workrooms = await loadWorkrooms(updated.id);
        // Same shape as GET /v1/users/me.
        return reply.code(200).send({
            user: buildMe(updated),
            default_workroom_id: updated.defaultWorkroomId,
            workrooms,
        });
    });

    app.delete('/v1/users/me', async (req, reply) => {
        const session = await resolveSession(req);
        if (!session) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }
        const body = req.body as { password?: unknown } | null;
        if (!body || typeof body.password !== 'string') {
            // Missing / malformed password field → REQUIRED.
            return reply.code(403).send({ error: { code: 'PASSWORD_REQUIRED' } });
        }
        const user = await db.user.findUnique({ where: { id: session.userId } });
        if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
            // Password supplied but didn't verify → INVALID (distinct from
            // REQUIRED so clients can choose to re-prompt vs. show "wrong pw").
            return reply.code(403).send({ error: { code: 'PASSWORD_INVALID' } });
        }

        // Cascade per spec §5.4 — scoped pragmatically for Slice 7:
        //   1. UserSession rows: deleted via FK Cascade when User is deleted
        //      (schema has onDelete: Cascade), but we delete explicitly first
        //      to keep the transaction's intent obvious.
        //   2. UserWorkroomMembership rows: same — schema cascades, deleted
        //      explicitly.
        //   3. Device.userId: schema's FK is `onDelete: SetNull`, so Postgres
        //      nulls those columns automatically when the User row goes — we
        //      DO NOT delete devices (chat-side rows must survive, spec §5.4).
        //   4. Solo-owned ControlWorkroom rows: NOT touched. ControlWorkroom
        //      has many child tables (channels, tasks, agents, messages,
        //      machines, goals, etc.) whose FKs default to NO ACTION, so
        //      deleting a workroom underneath them would error. Spec §5.4's
        //      "workroom dies with its sole user" intent is left as a known
        //      follow-up; the orphaned workroom has no remaining members and
        //      will simply be inaccessible via the new auth surface. Disclosed
        //      to the orchestrator as a known concern for this slice.
        await db.$transaction(async (tx) => {
            await tx.userSession.deleteMany({ where: { userId: user.id } });
            await tx.userWorkroomMembership.deleteMany({
                where: { userId: user.id },
            });
            await tx.user.delete({ where: { id: user.id } });
        });
        return reply.code(204).send();
    });
};
