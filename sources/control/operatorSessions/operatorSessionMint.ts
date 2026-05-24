/**
 * Root/owner-only operator_session mint + revoke (#86).
 *
 * `op_sess_` is a SEPARATE credential class from `dev_ctl_`: it authorizes a SCOPED set of
 * operator WRITE commands (V1: acknowledge_needs_human + mark_reviewed only). Like the #32
 * dev-token mint, this is the production-safe issuance path — run locally on the box by an
 * operator; there is intentionally NO HTTP mint endpoint. Only the SHA-256 hash is stored; the
 * raw token is shown exactly once.
 *
 * NOTE: anti-replay signing-key material is NOT issued here — that is the #87 decision (encrypted
 * symmetric MAC key vs asymmetric public key). This module mints the bearer credential + scope +
 * audit identity only. Write endpoints (later slices) will require the #87 signed request proof on
 * top of this bearer token.
 *
 * CLI usage:
 *   tsx --env-file=.env sources/control/operatorSessions/operatorSessionMint.ts \
 *     mint <orgId> <workroomId> <operatorSubjectId> [ttlHours] [cmd1,cmd2]
 *   tsx --env-file=.env sources/control/operatorSessions/operatorSessionMint.ts revoke <sessionId>
 */

import { randomBytes, createHash } from 'crypto';
import { userInfo } from 'os';
import { db } from '@/storage/db';

export const OPERATOR_SESSION_TOKEN_PREFIX = 'op_sess_';

/** Commands an operator_session may be granted in V1. approve/retry are intentionally excluded. */
export const V1_OPERATOR_COMMANDS = [
  'acknowledge_needs_human',
  'mark_reviewed',
  'send_message',
  // S5 Saved messages: operator (phone) save/unsave command.
  'save_message',
  // S3 Slock Tasks: operator (phone) task commands.
  'create_task',
  'update_task_status',
  'assign_task',
  // S6 channel write-ops: operator (phone) channel commands.
  'create_channel',
  'manage_members',
  // Emergency stop: operator (phone) "□ Stop all agents" channel-header action.
  'stop_agents',
  // Create Agent: operator (phone) "Create Agent" form → POST /workrooms/:wid/agents.
  'create_agent',
] as const;
export type V1OperatorCommand = (typeof V1_OPERATOR_COMMANDS)[number];

/** Default TTL (hours) for a freshly minted operator_session, and the hard cap. */
export const OPERATOR_SESSION_DEFAULT_TTL_HOURS = 8;
export const OPERATOR_SESSION_MAX_TTL_HOURS = 24; // operator write credential — kept short-lived

export interface MintOperatorSessionParams {
  orgId: string;
  workroomId: string;
  operatorSubjectId: string;
  issuedBy: string;
  /** Defaults to V1_OPERATOR_COMMANDS. Must be a subset of V1_OPERATOR_COMMANDS. */
  allowedCommands?: string[];
  /** Defaults to OPERATOR_SESSION_DEFAULT_TTL_HOURS. Capped at OPERATOR_SESSION_MAX_TTL_HOURS. */
  ttlHours?: number;
}

export interface MintOperatorSessionResult {
  /** Raw token — return to caller ONCE, never stored. Caller must not log/persist it. */
  rawToken: string;
  id: string;
  expiresAt: Date;
  allowedCommands: string[];
}

/** Error thrown for invalid mint inputs (no secret values in the message). */
export class OperatorSessionMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorSessionMintError';
  }
}

/**
 * Mint an operator_session. Validates the workroom exists and belongs to `orgId`, validates the
 * requested commands are within the V1 allow-list, generates an `op_sess_` token, stores ONLY its
 * SHA-256 hash, and returns the raw token once.
 */
export async function mintOperatorSession(params: MintOperatorSessionParams): Promise<MintOperatorSessionResult> {
  const { orgId, workroomId, operatorSubjectId, issuedBy } = params;

  if (!orgId || !workroomId || !operatorSubjectId || !issuedBy) {
    throw new OperatorSessionMintError('orgId, workroomId, operatorSubjectId and issuedBy are required');
  }

  const ttlHours = params.ttlHours ?? OPERATOR_SESSION_DEFAULT_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > OPERATOR_SESSION_MAX_TTL_HOURS) {
    throw new OperatorSessionMintError(`ttlHours must be an integer in 1..${OPERATOR_SESSION_MAX_TTL_HOURS}`);
  }

  const allowedCommands = params.allowedCommands ?? [...V1_OPERATOR_COMMANDS];
  if (allowedCommands.length === 0) {
    throw new OperatorSessionMintError('allowedCommands must not be empty');
  }
  const invalid = allowedCommands.filter((c) => !V1_OPERATOR_COMMANDS.includes(c as V1OperatorCommand));
  if (invalid.length > 0) {
    // Fail-closed: never mint a session that claims a command outside the V1 allow-list
    // (e.g. approve/retry are not grantable in V1).
    throw new OperatorSessionMintError(`commands not allowed in V1: ${invalid.join(', ')}`);
  }

  // Validate workroom exists + belongs to the org (no DB FK by convention).
  const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { orgId: true } });
  if (!wr) {
    throw new OperatorSessionMintError(`workroom not found: ${workroomId}`);
  }
  if (wr.orgId !== orgId) {
    throw new OperatorSessionMintError('orgId mismatch: workroom belongs to a different org');
  }

  const rawToken = `${OPERATOR_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const rec = await db.controlOperatorSession.create({
    data: { tokenHash, orgId, workroomId, allowedCommands, operatorSubjectId, issuedBy, expiresAt },
  });

  return { rawToken, id: rec.id, expiresAt, allowedCommands };
}

/** Revoke an operator_session by id. Idempotent: returns false if not found, true if revoked. */
export async function revokeOperatorSession(id: string): Promise<boolean> {
  if (!id) throw new OperatorSessionMintError('session id is required');
  const res = await db.controlOperatorSession.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

// ── CLI entry ───────────────────────────────────────────────────────────────────
// Run only when invoked directly (not when imported by tests).
const isDirectRun = process.argv[1]?.endsWith('operatorSessionMint.ts')
  || process.argv[1]?.endsWith('operatorSessionMint.js');

if (isDirectRun) {
  void (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    try {
      if (cmd === 'mint') {
        const [orgId, workroomId, operatorSubjectId, ttlArg, commandsArg] = rest;
        if (!orgId || !workroomId || !operatorSubjectId) {
          console.error('Usage: ... operatorSessionMint.ts mint <orgId> <workroomId> <operatorSubjectId> [ttlHours] [cmd1,cmd2]');
          await db.$disconnect();
          process.exit(1);
        }
        const issuedBy = `cli:${userInfo().username}`;
        const allowedCommands = commandsArg ? commandsArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const ttlHours = ttlArg ? Number.parseInt(ttlArg, 10) : undefined;
        const r = await mintOperatorSession({ orgId, workroomId, operatorSubjectId, issuedBy, allowedCommands, ttlHours });
        // SECURITY: raw token printed ONCE; only its hash is stored.
        console.log('');
        console.log('=== operator_session minted (op_sess_) — copy now, shown once ===');
        console.log(`  token:               ${r.rawToken}`);
        console.log(`  id:                  ${r.id}`);
        console.log(`  org_id:              ${orgId}`);
        console.log(`  workroom_id:         ${workroomId}`);
        console.log(`  operator_subject_id: ${operatorSubjectId}`);
        console.log(`  issued_by:           ${issuedBy}`);
        console.log(`  allowed_commands:    ${r.allowedCommands.join(', ')}`);
        console.log(`  expires_at:          ${r.expiresAt.toISOString()}`);
        console.log('');
        console.log(`  Revoke: ... operatorSessionMint.ts revoke ${r.id}`);
        console.log('');
      } else if (cmd === 'revoke') {
        const [id] = rest;
        if (!id) {
          console.error('Usage: ... operatorSessionMint.ts revoke <sessionId>');
          await db.$disconnect();
          process.exit(1);
        }
        const ok = await revokeOperatorSession(id);
        console.log(ok ? `revoked: ${id}` : `not found or already revoked: ${id}`);
      } else {
        console.error('Usage: operatorSessionMint.ts <mint|revoke> ...');
        await db.$disconnect();
        process.exit(1);
      }
      await db.$disconnect();
    } catch (err) {
      console.error('operator_session CLI failed:', err instanceof Error ? err.message : err);
      try { await db.$disconnect(); } catch { /* ignore */ }
      process.exit(1);
    }
  })();
}
