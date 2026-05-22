/**
 * demo-fixture.ts — one-command repeatable demo data + dev_ctl token (#66).
 *
 * Replaces the manual seed/mint/cleanup dance used for CodeLight real-data demos.
 * All demo data is tagged with a recognizable org slug prefix (`demo-fixture-`) so
 * `cleanup` can find and remove every demo artifact, leaving no prod test pollution.
 *
 * Usage (run on the box where MioServer's .env points at the target DB):
 *   tsx --env-file=.env scripts/demo-fixture.ts provision [ttlHours]   # seed + mint (token shown ONCE)
 *   tsx --env-file=.env scripts/demo-fixture.ts cleanup                # revoke + delete ALL demo fixtures
 *   tsx --env-file=.env scripts/demo-fixture.ts list                   # list current demo fixtures (no secrets)
 *
 * SECURITY:
 *   - The raw dev_ctl token is printed ONCE to stdout and never persisted (only its
 *     sha256 hash is stored). Do NOT paste it into public channels — DM only.
 *   - read_only scope, short TTL (default 2h, max 24h here), bound to one workroom.
 *   - cleanup revokes + deletes; no token value is ever logged.
 */

import { randomBytes, createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';

const SLUG_PREFIX = 'demo-fixture-';
const TOKEN_PREFIX = 'dev_ctl_';

async function provision(ttlHours: number): Promise<void> {
  const orgId = randomUUID();
  const agentId = randomUUID();
  const workroomId = randomUUID();
  const sessionId = randomUUID();

  await db.controlOrg.create({
    data: { id: orgId, name: 'CodeLight Demo Org', slug: `${SLUG_PREFIX}${randomUUID().slice(0, 8)}`, ownerUserId: randomUUID() },
  });
  await db.controlAgent.create({
    data: { id: agentId, orgId, name: 'demo-agent', displayName: 'Demo Agent', role: 'ops' },
  });
  await db.controlWorkroom.create({
    data: { id: workroomId, orgId, name: 'CodeLight Demo Workroom', createdBy: randomUUID() },
  });
  await db.controlSession.create({
    data: { id: sessionId, orgId, workroomId, machineId: null, mode: 'daemon', runtime: 'claude', displayName: 'demo-session' },
  });

  // Tasks: in_progress + todo (covers task-list states).
  await db.controlTask.create({ data: { id: randomUUID(), workroomId, title: '部署 CodeLight 到 TestFlight', status: 'in_progress', ownerInstanceId: agentId } });
  await db.controlTask.create({ data: { id: randomUUID(), workroomId, title: '修复登录态丢失问题', status: 'todo', ownerInstanceId: agentId } });

  // Actions: covers transmission_complete (≠Done), needs_human, and a redaction sample
  // (fake dev_ctl_/path in the summary — must render as [REDACTED] in the UI).
  const mkAction = (summary: string, status: string) => db.controlAction.create({
    data: {
      id: randomUUID(), sessionId, workroomId, actorAgentId: agentId, kind: 'other',
      summary, reversibility: 'reversible', riskLevel: 'low', requiresApproval: false,
      status, clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  await mkAction('运行集成测试套件（read-only）', 'transmission_complete');
  await mkAction('等待人工确认：是否继续发布到 TestFlight', 'needs_human');
  await mkAction('轮换调试 token dev_ctl_FAKE0000000000000000000000000000 并清理 /var/folders/xx/T/mio-secret-abc123', 'fired');

  // Mint a read-only dev_ctl token bound to this workroom.
  const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const tok = await db.controlDevToken.create({
    data: { tokenHash, orgId, workroomId, scope: 'read_only', expiresAt },
  });

  console.log('');
  console.log('=== demo fixture provisioned (token shown ONCE — copy now, DM only) ===');
  console.log(`  base_url:     https://mio.wdao.chat  (or local server URL)`);
  console.log(`  token:        ${rawToken}`);
  console.log(`  workroom_id:  ${workroomId}`);
  console.log(`  org_id:       ${orgId}`);
  console.log(`  token_id:     ${tok.id}`);
  console.log(`  scope:        read_only`);
  console.log(`  expires_at:   ${expiresAt.toISOString()} (TTL ${ttlHours}h)`);
  console.log(`  seeded:       2 tasks (in_progress/todo) + 3 actions (transmission_complete/needs_human/redaction-sample)`);
  console.log('');
  console.log('  Fill CodeLight Settings -> Dev Demo: base_url + token + workroom_id.');
  console.log('  When done:  tsx --env-file=.env scripts/demo-fixture.ts cleanup');
  console.log('');
}

async function cleanup(): Promise<void> {
  const orgs = await db.controlOrg.findMany({ where: { slug: { startsWith: SLUG_PREFIX } }, select: { id: true } });
  if (orgs.length === 0) { console.log('cleanup: no demo fixtures found.'); return; }
  const orgIds = orgs.map((o) => o.id);
  const workrooms = await db.controlWorkroom.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
  const wrIds = workrooms.map((w) => w.id);

  const tok = await db.controlDevToken.deleteMany({ where: { workroomId: { in: wrIds } } });
  const act = await db.controlAction.deleteMany({ where: { workroomId: { in: wrIds } } });
  const task = await db.controlTask.deleteMany({ where: { workroomId: { in: wrIds } } });
  const sess = await db.controlSession.deleteMany({ where: { workroomId: { in: wrIds } } });
  const wr = await db.controlWorkroom.deleteMany({ where: { orgId: { in: orgIds } } });
  const agent = await db.controlAgent.deleteMany({ where: { orgId: { in: orgIds } } });
  const org = await db.controlOrg.deleteMany({ where: { id: { in: orgIds } } });
  console.log(`cleanup: deleted orgs=${org.count} workrooms=${wr.count} agents=${agent.count} sessions=${sess.count} tasks=${task.count} actions=${act.count} dev_tokens=${tok.count}`);
}

async function list(): Promise<void> {
  const orgs = await db.controlOrg.findMany({ where: { slug: { startsWith: SLUG_PREFIX } }, select: { id: true, slug: true } });
  console.log(`demo fixtures: ${orgs.length} org(s)`);
  for (const o of orgs) {
    const wrs = await db.controlWorkroom.findMany({ where: { orgId: o.id }, select: { id: true } });
    for (const w of wrs) {
      const t = await db.controlTask.count({ where: { workroomId: w.id } });
      const a = await db.controlAction.count({ where: { workroomId: w.id } });
      const tok = await db.controlDevToken.count({ where: { workroomId: w.id, revokedAt: null, expiresAt: { gt: new Date() } } });
      console.log(`  org=${o.slug} workroom=${w.id} tasks=${t} actions=${a} active_tokens=${tok}`);
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const ttlArg = process.argv[3];
  if (cmd === 'provision') {
    const ttl = ttlArg ? Number.parseInt(ttlArg, 10) : 2;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24) { console.error('ttlHours must be 1..24'); process.exit(1); }
    await provision(ttl);
  } else if (cmd === 'cleanup') {
    await cleanup();
  } else if (cmd === 'list') {
    await list();
  } else {
    console.error('Usage: demo-fixture.ts <provision [ttlHours] | cleanup | list>');
    await db.$disconnect();
    process.exit(1);
  }
  await db.$disconnect();
}

main().catch(async (e) => { console.error('demo-fixture failed:', e); try { await db.$disconnect(); } catch { /* */ } process.exit(1); });
