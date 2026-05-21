/**
 * Root-only dev_control_token mint CLI (#32).
 *
 * Generates a short-lived, READ-ONLY dev control token bound to one workroom, stores
 * ONLY its SHA-256 hash, and prints the raw token exactly ONCE to the operator's terminal.
 *
 * This CLI is the production-safe mint path: it is run locally on the server by an
 * operator (root) and writes directly to the DB — there is intentionally NO HTTP token
 * issuance endpoint (which would be a public attack surface). Hence no NODE_ENV guard is
 * needed here; access control is "you have a shell on the box".
 *
 * Usage:
 *   tsx --env-file=.env sources/control/devTokens/mintDevToken.ts <orgId> <workroomId> [ttlHours]
 *
 * Defaults: ttlHours = 24 (max 720 = 30 days).
 *
 * Revoke a token later:
 *   UPDATE control_dev_tokens SET revoked_at = now() WHERE id = '<id>';
 */

import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';

const TOKEN_PREFIX = 'dev_ctl_';

async function main(): Promise<void> {
  const [orgId, workroomId, ttlArg] = process.argv.slice(2);

  if (!orgId || !workroomId) {
    console.error(
      'Usage: tsx --env-file=.env sources/control/devTokens/mintDevToken.ts <orgId> <workroomId> [ttlHours]',
    );
    process.exit(1);
  }

  const ttlHours = ttlArg ? Number.parseInt(ttlArg, 10) : 24;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 720) {
    console.error('ttlHours must be an integer in 1..720 (max 30 days)');
    process.exit(1);
  }

  // Validate the workroom exists and belongs to the given org (no DB FK by convention,
  // so we check here to avoid minting a token bound to a non-existent / mismatched workroom).
  const wr = await db.controlWorkroom.findUnique({
    where: { id: workroomId },
    select: { orgId: true },
  });
  if (!wr) {
    console.error(`workroom not found: ${workroomId}`);
    await db.$disconnect();
    process.exit(1);
  }
  if (wr.orgId !== orgId) {
    console.error(`orgId mismatch: workroom ${workroomId} belongs to a different org`);
    await db.$disconnect();
    process.exit(1);
  }

  const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const rec = await db.controlDevToken.create({
    data: { tokenHash, orgId, workroomId, scope: 'read_only', expiresAt },
  });

  // SECURITY: the raw token is printed ONCE here and never stored (only the hash is in DB).
  console.log('');
  console.log('=== dev_control_token minted (READ-ONLY) — copy now, shown once ===');
  console.log(`  token:       ${rawToken}`);
  console.log(`  id:          ${rec.id}`);
  console.log(`  workroom_id: ${workroomId}`);
  console.log(`  org_id:      ${orgId}`);
  console.log(`  scope:       read_only`);
  console.log(`  expires_at:  ${expiresAt.toISOString()}`);
  console.log('');
  console.log('  Use:    Authorization: Bearer <token>   (GET allowlist + this workroom only)');
  console.log(`  Revoke: UPDATE control_dev_tokens SET revoked_at = now() WHERE id = '${rec.id}';`);
  console.log('');

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error('mint failed:', err);
  try {
    await db.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
