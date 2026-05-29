/**
 * prod-mint-op.ts — mint an op_sess_ token for a given org+workroom (all V1 commands).
 * Usage: ORG_ID=... WORKROOM_ID=... npx tsx --env-file=.env scripts/prod-mint-op.ts
 * Prints the raw op_sess_ token on a single line. Dev/test harness; no secret at rest.
 */
import { randomUUID } from 'crypto';
import { mintOperatorSession, V1_OPERATOR_COMMANDS } from '@/control/operatorSessions/operatorSessionMint';

async function main(): Promise<void> {
  const orgId = process.env.ORG_ID;
  const workroomId = process.env.WORKROOM_ID;
  if (!orgId || !workroomId) {
    console.error('ORG_ID and WORKROOM_ID env vars required');
    process.exit(1);
  }
  const { rawToken } = await mintOperatorSession({
    orgId,
    workroomId,
    operatorSubjectId: `pairing:${randomUUID()}`,
    issuedBy: 'prod-test-setup',
    allowedCommands: [...V1_OPERATOR_COMMANDS],
    ttlHours: 24,
  });
  console.log(rawToken);
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
