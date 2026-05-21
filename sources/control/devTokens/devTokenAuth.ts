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

import { createHash } from 'crypto';
import { db } from '@/storage/db';

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
  /^\/api\/v1\/workrooms\/[^/]+\/tasks$/,
  /^\/api\/v1\/workrooms\/[^/]+\/actions$/,
  /^\/api\/v1\/actions\/[^/]+$/,
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
