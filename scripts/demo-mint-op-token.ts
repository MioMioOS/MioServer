/**
 * demo-mint-op-token.ts — one-off: mint an op_sess_ token for the slockai workroom
 * and print the raw token (for injecting into the iOS app via --slock-op-token).
 *
 * Usage: tsx --env-file=.env.dev scripts/demo-mint-op-token.ts
 * Prints: the raw op_sess_ token on a single line.
 *
 * Not committed; pure dev harness. Contains no secrets at rest.
 */
import { randomUUID } from 'crypto';
import { mintOperatorSession } from '@/control/operatorSessions/operatorSessionMint';

const ORG_ID = 'dbb1c77e-11be-4f6f-99fa-9fb99284c6c6';
const WORKROOM_ID = 'ed224c68-1c51-462b-a86b-574dddc7667c';

async function main(): Promise<void> {
  const { rawToken } = await mintOperatorSession({
    orgId: ORG_ID,
    workroomId: WORKROOM_ID,
    operatorSubjectId: `pairing:${randomUUID()}`,
    issuedBy: 'demo-mint-op-token',
    allowedCommands: ['send_message'],
    ttlHours: 8,
  });
  console.log(rawToken);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e?.message ?? e);
  process.exit(1);
});
