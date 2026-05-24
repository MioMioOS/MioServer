/**
 * Dev control-plane token auth (#32) — READ-ONLY, debug/dev-only.
 *
 * Lets the human UI (CodeLight) call a small allowlist of control-plane GET endpoints
 * WITHOUT a machine_token. The token is minted via a root-only CLI/seed (the HTTP issuance
 * endpoint is disabled when NODE_ENV=production). Only SHA-256(token) is stored; the raw
 * token is shown once at mint time.
 *
 * SECURITY MODEL (all enforced here; routes must apply all three):
 *   1. verifyDevControlToken — token exists + not expired + not revoked + scope read_only.
 *   2. isDevTokenAllowedPath — hardcoded GET allowlist, DEFAULT-DENY (non-GET / off-list → no).
 *   3. devTokenInWorkroomScope — token is bound to ONE workroom:
 *        /workrooms/:wid/*  → wid must equal token.workroomId
 *        /actions/:id       → reverse-lookup the action's workroomId, must equal token.workroomId
 *      Any failure (including not-found / malformed id) → false. The route returns a UNIFORM
 *      403 on ANY of these failures (anti-enumeration: never reveal expired vs revoked vs
 *      out-of-scope vs not-found — same response for all). Mirrors the 5D
 *      TOKEN_NOT_CONSUMABLE uniform-403 principle.
 *
 * NOTE: machine_token auth is unaffected — read routes accept machine_token OR dev token;
 * the dev-token restrictions (allowlist + workroom-scope) apply ONLY to the dev-token path.
 */

import type { FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface DevTokenContext {
  id: string;
  orgId: string;
  workroomId: string;
  scope: string;
}

/**
 * Verify a Bearer dev_control_token from the Authorization header.
 * Returns the token context if valid (exists + not expired + not revoked + scope read_only),
 * else null. Mirrors verifyMachineToken's hash-lookup pattern (sha256, never store raw).
 */
export async function verifyDevControlToken(
  authHeader: string | undefined,
): Promise<DevTokenContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token) return null;
  const hash = hashToken(token);

  const rec = await db.controlDevToken.findFirst({
    where: {
      tokenHash: hash,
      scope: 'read_only',
      expiresAt: { gt: new Date() },
      revokedAt: null,
    },
  });
  if (!rec) return null;
  return { id: rec.id, orgId: rec.orgId, workroomId: rec.workroomId, scope: rec.scope };
}

/**
 * Hardcoded GET allowlist for dev tokens. DEFAULT-DENY: anything not matched is rejected.
 * Only read endpoints the human UI needs for the Task execution detail surface.
 */
const DEV_TOKEN_GET_ALLOWLIST: RegExp[] = [
  /^\/api\/v1\/workrooms\/[^/]+\/channels$/,
  /^\/api\/v1\/workrooms\/[^/]+\/tasks$/,
  // S3 Slock: per-channel task list (the workroom-aggregate /tasks is already allowlisted above).
  /^\/api\/v1\/workrooms\/[^/]+\/channels\/[^/]+\/tasks$/,
  /^\/api\/v1\/workrooms\/[^/]+\/actions$/,
  /^\/api\/v1\/actions\/[^/]+$/,
  // #164: server-assist explanation (read-only; workroom-scoped via the /workrooms/:wid/ rule).
  /^\/api\/v1\/workrooms\/[^/]+\/explanation$/,
  // S1: message read endpoints (Chunk 5 allowlist expansion).
  /^\/api\/v1\/workrooms\/[^/]+\/channels\/[^/]+\/messages$/,
  /^\/api\/v1\/messages\/[^/]+$/,
  // S2: members endpoint (workroom-scope already enforced by devTokenInWorkroomScope).
  /^\/api\/v1\/workrooms\/[^/]+\/members$/,
  // S4: DM list endpoint (read-only; workroom-scope enforced by devTokenInWorkroomScope).
  /^\/api\/v1\/workrooms\/[^/]+\/dms$/,
  // S2: thread read endpoints (workroom-scope enforced by devTokenInWorkroomScope).
  // /messages/:id (used to fetch the thread parent) is already allowlisted above.
  /^\/api\/v1\/workrooms\/[^/]+\/threads\/[^/]+$/,
  /^\/api\/v1\/workrooms\/[^/]+\/threads\/[^/]+\/replies$/,
  // S5: workroom search (read-only; workroom-scope enforced by devTokenInWorkroomScope).
  /^\/api\/v1\/workrooms\/[^/]+\/search$/,
];

/** True iff (method, path) is an allowed dev-token GET endpoint. Default-deny. */
export function isDevTokenAllowedPath(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  // Strip any query string before matching.
  const clean = path.split('?')[0];
  return DEV_TOKEN_GET_ALLOWLIST.some((re) => re.test(clean));
}

/**
 * Enforce that a dev token may only read data within its bound workroom.
 *   /workrooms/:wid/...  → wid === token.workroomId
 *   /actions/:id         → reverse-lookup action.workroomId === token.workroomId
 * Returns false on any mismatch, not-found, or malformed id (caller → uniform 403).
 */
export async function devTokenInWorkroomScope(
  token: DevTokenContext,
  path: string,
): Promise<boolean> {
  const clean = path.split('?')[0];

  const wrMatch = clean.match(/^\/api\/v1\/workrooms\/([^/]+)\//);
  if (wrMatch) {
    return wrMatch[1] === token.workroomId;
  }

  const actMatch = clean.match(/^\/api\/v1\/actions\/([^/]+)$/);
  if (actMatch) {
    try {
      const action = await db.controlAction.findUnique({
        where: { id: actMatch[1] },
        select: { workroomId: true },
      });
      return !!action && action.workroomId === token.workroomId;
    } catch {
      // Malformed id (e.g. not a valid uuid) → deny (uniform 403 upstream).
      return false;
    }
  }

  // Path not recognised as a workroom-scoped read → deny.
  return false;
}

/**
 * Dual-auth for control-plane READ endpoints.
 *
 * Accepts EITHER:
 *   - a machine_token  → full access (existing behaviour; caller still runs
 *                        requireMachineAccessToWorkroom for org/workroom authz), or
 *   - a dev_control_token → read-only, restricted to the GET allowlist + its bound
 *                        workroom. allowlist + workroom-scope are enforced HERE; any
 *                        failure returns a UNIFORM 403 (anti-enumeration).
 *
 * The machine path is unchanged — this only ADDS the dev-token path, so machine_token
 * auth does not regress.
 */
export type ControlReadAuth =
  | { ok: true; mode: 'machine'; machine: NonNullable<Awaited<ReturnType<typeof verifyMachineToken>>> }
  | { ok: true; mode: 'dev'; devToken: DevTokenContext }
  | { ok: false; status: number; code: string; message: string };

export async function authorizeControlRead(request: FastifyRequest): Promise<ControlReadAuth> {
  const authHeader = request.headers.authorization;

  // 1. machine_token — unchanged full-access path.
  const machine = await verifyMachineToken(authHeader);
  if (machine) return { ok: true, mode: 'machine', machine };

  // 2. dev_control_token — read-only, allowlist + workroom-scope, uniform 403 on any failure.
  const devToken = await verifyDevControlToken(authHeader);
  if (devToken) {
    const path = request.url;
    if (!isDevTokenAllowedPath(request.method, path)) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    }
    if (!(await devTokenInWorkroomScope(devToken, path))) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    }
    return { ok: true, mode: 'dev', devToken };
  }

  // 3. neither → 401.
  return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
}
