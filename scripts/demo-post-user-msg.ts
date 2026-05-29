/**
 * demo-post-user-msg.ts — one-off: mint an op_sess_ and POST a single USER message
 * to the slockai channel, to drive the mio-agent autonomous-loop live demo.
 *
 * Usage: tsx --env-file=.env.dev scripts/demo-post-user-msg.ts "<content>"
 * Prints a JSON line: {"seq":"...","sender_kind":"...","id":"..."}
 *
 * Not committed; pure dev harness. Contains no secrets.
 */
import { randomUUID } from 'crypto';
import { mintOperatorSession } from '@/control/operatorSessions/operatorSessionMint';

const ORG_ID = 'dbb1c77e-11be-4f6f-99fa-9fb99284c6c6';
const WORKROOM_ID = 'ed224c68-1c51-462b-a86b-574dddc7667c';
const CHANNEL_ID = 'ce7c56af-f942-4d30-8967-f68e8b0c913f';
const BASE = 'http://localhost:3005';

async function main(): Promise<void> {
  const content = process.argv[2] ?? '@agent 帮我用一句话总结今天的部署计划';

  const { rawToken } = await mintOperatorSession({
    orgId: ORG_ID,
    workroomId: WORKROOM_ID,
    operatorSubjectId: `pairing:${randomUUID()}`,
    issuedBy: 'demo-post-user-msg',
    allowedCommands: ['send_message'],
    ttlHours: 1,
  });

  const res = await fetch(`${BASE}/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawToken}` },
    body: JSON.stringify({ content, client_idempotency_key: randomUUID() }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`POST failed ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(text);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e?.message ?? e);
  process.exit(1);
});
