/**
 * #179 (Track 4) — connection-credential core: the long-lived, refreshable ROOT credential for
 * CodeLight's "bind once, stay connected" model.
 *
 * SECURITY MODEL (mirrors op_sess_/dev_ctl_ — only sha256 stored, raw returned once):
 *   - mint: generate a `conn_...` token, store ONLY its sha256, return the raw exactly once
 *     (caller hands it straight to the iOS Keychain; never logged/persisted server-side).
 *   - verify: sha256 lookup + not-expired + not-revoked → returns the granted scopes. This credential
 *     is the ROOT only; it is exchanged at the /connections/access endpoint for SHORT-LIVED access
 *     tokens. It must NEVER be accepted as a data-request bearer.
 *   - revoke: single kill switch (revokedAt). Self-revoke (phone "disconnect") and machine_token
 *     revoke (Mac/daemon device management) both flip the same field.
 *   - rotate: rolling refresh — mint a successor linked via rotatedFromId and revoke the predecessor,
 *     so a leaked snapshot ages out. Scopes/operator identity carry forward unchanged (no escalation).
 *
 * Scope rule: "read" is the base scope (always present). "operator" is only granted when explicitly
 * requested AND an operatorSubjectId is supplied — there is no path to silently gain operator.
 */

import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';

export const CONNECTION_CREDENTIAL_PREFIX = 'conn_';

export type ConnectionScope = 'read' | 'operator';
export const VALID_CONNECTION_SCOPES: readonly ConnectionScope[] = ['read', 'operator'];

/** Default long-lived TTL (days) for a connection credential, and the hard cap (PM: 60d rolling). */
export const CONNECTION_CREDENTIAL_DEFAULT_TTL_DAYS = 60;
export const CONNECTION_CREDENTIAL_MAX_TTL_DAYS = 90;

const DAY_MS = 86_400_000;

export class ConnectionCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionCredentialError';
  }
}

export interface MintConnectionCredentialParams {
  orgId: string;
  workroomId: string;
  /** Granted scopes. Must include "read"; "operator" requires operatorSubjectId. */
  scopes: ConnectionScope[];
  /** Required iff scopes includes "operator" — opaque operator identity for derived op access. */
  operatorSubjectId?: string;
  /** Operator command keys to mint into operator access tokens (V1: ack + mark_reviewed). */
  allowedCommands?: string[];
  deviceLabel?: string;
  createdByMachineId?: string;
  /** Default CONNECTION_CREDENTIAL_DEFAULT_TTL_DAYS; capped at CONNECTION_CREDENTIAL_MAX_TTL_DAYS. */
  ttlDays?: number;
  /** Rolling-refresh lineage: the predecessor connection id this one replaces. */
  rotatedFromId?: string;
}

export interface MintConnectionCredentialResult {
  /** Raw `conn_...` — return to caller ONCE, never store/log. */
  rawCredential: string;
  connectionId: string;
  scopes: ConnectionScope[];
  expiresAt: Date;
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Normalize + validate the requested scopes. Always includes "read". Dedupes. Fail-closed. */
function normalizeScopes(scopes: ConnectionScope[], operatorSubjectId?: string): ConnectionScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ConnectionCredentialError('scopes must be a non-empty array');
  }
  const invalid = scopes.filter((s) => !VALID_CONNECTION_SCOPES.includes(s));
  if (invalid.length > 0) {
    throw new ConnectionCredentialError(`invalid scopes: ${invalid.join(', ')}`);
  }
  const set = new Set<ConnectionScope>(scopes);
  set.add('read'); // read is the base scope, always present
  if (set.has('operator') && !operatorSubjectId) {
    // Fail-closed: never grant operator without an operator identity to bind it to.
    throw new ConnectionCredentialError('operator scope requires operatorSubjectId');
  }
  return [...set];
}

/**
 * Mint a connection credential. Validates the workroom exists + belongs to orgId, validates scopes,
 * stores ONLY the sha256, returns the raw once.
 */
export async function mintConnectionCredential(
  params: MintConnectionCredentialParams,
): Promise<MintConnectionCredentialResult> {
  const { orgId, workroomId } = params;
  if (!orgId || !workroomId) {
    throw new ConnectionCredentialError('orgId and workroomId are required');
  }

  const ttlDays = params.ttlDays ?? CONNECTION_CREDENTIAL_DEFAULT_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > CONNECTION_CREDENTIAL_MAX_TTL_DAYS) {
    throw new ConnectionCredentialError(`ttlDays must be in 1..${CONNECTION_CREDENTIAL_MAX_TTL_DAYS}`);
  }

  const scopes = normalizeScopes(params.scopes, params.operatorSubjectId);

  // Validate workroom exists + belongs to org (no DB FK by convention).
  const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { orgId: true } });
  if (!wr) throw new ConnectionCredentialError(`workroom not found: ${workroomId}`);
  if (wr.orgId !== orgId) throw new ConnectionCredentialError('orgId mismatch: workroom belongs to a different org');

  const rawCredential = `${CONNECTION_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);

  const rec = await db.controlConnectionCredential.create({
    data: {
      credentialHash: hash(rawCredential),
      orgId,
      workroomId,
      scopes,
      operatorSubjectId: scopes.includes('operator') ? params.operatorSubjectId : null,
      allowedCommands: params.allowedCommands ?? [],
      deviceLabel: params.deviceLabel ?? null,
      createdByMachineId: params.createdByMachineId ?? null,
      rotatedFromId: params.rotatedFromId ?? null,
      expiresAt,
    },
  });

  return { rawCredential, connectionId: rec.id, scopes, expiresAt };
}

export interface VerifiedConnection {
  connectionId: string;
  orgId: string;
  workroomId: string;
  scopes: ConnectionScope[];
  operatorSubjectId: string | null;
  allowedCommands: string[];
}

/**
 * Verify a Bearer connection credential from the Authorization header.
 * Returns context iff it exists + not expired + not revoked, else null.
 * NOTE: this authenticates the ROOT credential (only valid at the /connections/access exchange and
 * the self-revoke endpoint) — it must NOT be used to authorize data-plane reads/writes directly.
 */
export async function verifyConnectionCredential(
  authHeader: string | undefined,
): Promise<VerifiedConnection | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const raw = authHeader.slice(7);
  if (!raw.startsWith(CONNECTION_CREDENTIAL_PREFIX)) return null;

  const rec = await db.controlConnectionCredential.findFirst({
    where: { credentialHash: hash(raw), expiresAt: { gt: new Date() }, revokedAt: null },
  });
  if (!rec) return null;

  return {
    connectionId: rec.id,
    orgId: rec.orgId,
    workroomId: rec.workroomId,
    scopes: rec.scopes as ConnectionScope[],
    operatorSubjectId: rec.operatorSubjectId,
    allowedCommands: rec.allowedCommands,
  };
}

/**
 * Revoke a connection credential by id (the single kill switch). Idempotent: returns false if not
 * found / already revoked, true if it flipped. Used by both self-revoke (phone disconnect) and
 * machine_token revoke (Mac/daemon device management).
 */
export async function revokeConnectionCredential(connectionId: string): Promise<boolean> {
  if (!connectionId) throw new ConnectionCredentialError('connectionId is required');
  const res = await db.controlConnectionCredential.updateMany({
    where: { id: connectionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

/**
 * Rolling refresh: mint a successor credential carrying the SAME scopes/operator identity, link it
 * via rotatedFromId, and revoke the predecessor — atomically. Returns the new raw credential once.
 * Fail-closed: if the predecessor is missing/expired/revoked, throws (caller → re-bind).
 */
export async function rotateConnectionCredential(
  connectionId: string,
  opts: { ttlDays?: number } = {},
): Promise<MintConnectionCredentialResult> {
  const prev = await db.controlConnectionCredential.findFirst({
    where: { id: connectionId, expiresAt: { gt: new Date() }, revokedAt: null },
  });
  if (!prev) throw new ConnectionCredentialError('connection not rotatable (missing/expired/revoked)');

  const ttlDays = opts.ttlDays ?? CONNECTION_CREDENTIAL_DEFAULT_TTL_DAYS;
  const rawCredential = `${CONNECTION_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);

  const next = await db.$transaction(async (tx) => {
    const created = await tx.controlConnectionCredential.create({
      data: {
        credentialHash: hash(rawCredential),
        orgId: prev.orgId,
        workroomId: prev.workroomId,
        scopes: prev.scopes,
        operatorSubjectId: prev.operatorSubjectId,
        allowedCommands: prev.allowedCommands,
        deviceLabel: prev.deviceLabel,
        createdByMachineId: prev.createdByMachineId,
        rotatedFromId: prev.id,
        expiresAt,
      },
    });
    // Revoke the predecessor; CAS on revokedAt:null guards against double-rotate races.
    const revoked = await tx.controlConnectionCredential.updateMany({
      where: { id: prev.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      throw new ConnectionCredentialError('predecessor revoked concurrently — rotation aborted');
    }
    return created;
  });

  return {
    rawCredential,
    connectionId: next.id,
    scopes: next.scopes as ConnectionScope[],
    expiresAt,
  };
}
