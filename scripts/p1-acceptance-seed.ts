/**
 * p1-acceptance-seed.ts — CodeLight P1 (#132/#134/#135) happy-path acceptance fixture.
 *
 * Seeds a SMALL, clearly-tagged set of demo data into an EXISTING org/workroom (default:
 * prod org "Mio" / its workroom) so a CodeLight build with a read-only dev_ctl_ token can
 * screenshot the real-data happy path: Home (attention/active) → TaskList → TaskDetail.
 *
 * WHY a dedicated script (vs scripts/demo-fixture.ts #66): demo-fixture creates its OWN
 * isolated demo org and cleans up by org-slug prefix. PM chose to seed into the EXISTING
 * org Mio / workroom 5908c8a6 (the daemon-bound workroom — most realistic). So cleanup here
 * must delete ONLY the demo-tagged rows and NEVER the daemon's real session/machine/binding.
 * Everything is tagged: tasks title startsWith 'demo-', actions clientIdempotencyKey
 * startsWith DEMO_PREFIX, agent name = DEMO_AGENT_NAME, session displayName = DEMO_SESSION_NAME.
 *
 * KNOWN BACKEND GAP (surfaced 2026-05-22, NOT fixable by seeding):
 *   The Evidence pushed page reads ControlAction.output_summary and the Runtime Log page
 *   reads raw_log_redacted, but GET /actions(/:id) returns NEITHER field (and ControlAction
 *   has no such column). So those two pushed pages render their EMPTY state on real data
 *   regardless of seed. Home / TaskList / TaskDetail (readiness + action summary + status +
 *   needs_human + #59 runtime_warnings) / Thread Context DO render. Fixing Evidence/RuntimeLog
 *   needs a backend change (data source + schema + endpoint), tracked separately.
 *
 * Usage (run where MioServer's .env points at the target DB — i.e. on the box for prod):
 *   tsx --env-file=.env scripts/p1-acceptance-seed.ts provision [ttlHours]   # seed + mint dev_ctl_ (token shown ONCE)
 *   tsx --env-file=.env scripts/p1-acceptance-seed.ts cleanup                # revoke + delete ALL demo rows (markers only)
 *   tsx --env-file=.env scripts/p1-acceptance-seed.ts list                   # list demo rows (no secrets)
 *
 * Override target (defaults to prod org Mio / workroom 5908c8a6):
 *   ORG_ID=<uuid> WORKROOM_ID=<uuid> tsx --env-file=.env scripts/p1-acceptance-seed.ts provision
 *
 * SECURITY: raw dev_ctl_ token printed ONCE, never persisted (only sha256 hash). read_only
 * scope, short TTL (default 24h, max 168h here), bound to the one workroom. DM only — never paste it publicly.
 */

import { randomBytes, createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';

const ORG_ID = process.env.ORG_ID ?? 'bb285310-bdf8-4d5d-aa8e-110dc671c457';      // org "Mio"
const WORKROOM_ID = process.env.WORKROOM_ID ?? '5908c8a6-26bd-4849-86e3-6711c21282bf';

const TOKEN_PREFIX = 'dev_ctl_';
const DEMO_PREFIX = 'demo-acceptance-';       // action clientIdempotencyKey marker
const DEMO_TITLE_PREFIX = 'demo-';            // task title marker
const DEMO_AGENT_NAME = 'demo-acceptance-agent';
const DEMO_SESSION_NAME = 'demo-acceptance-session';

async function assertTargetExists(): Promise<void> {
  const wr = await db.controlWorkroom.findUnique({ where: { id: WORKROOM_ID }, select: { orgId: true } });
  if (!wr) throw new Error(`workroom not found: ${WORKROOM_ID}`);
  if (wr.orgId !== ORG_ID) throw new Error(`orgId mismatch: workroom ${WORKROOM_ID} belongs to ${wr.orgId}, not ${ORG_ID}`);
}

async function provision(ttlHours: number): Promise<void> {
  await assertTargetExists();

  // Idempotency: clean any prior demo rows first so re-running yields a consistent set.
  await cleanupRows();

  // Demo agent (owner) + demo session (actions belong to a session).
  const agentId = randomUUID();
  await db.controlAgent.create({
    data: { id: agentId, orgId: ORG_ID, name: DEMO_AGENT_NAME, displayName: 'Demo Ops Agent', role: 'ops', status: 'online' },
  });
  const sessionId = randomUUID();
  await db.controlSession.create({
    data: { id: sessionId, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: null, mode: 'daemon', runtime: 'claude', displayName: DEMO_SESSION_NAME, status: 'running' },
  });

  // ── Task A: needs_human (attention section) ──
  const taskA = await db.controlTask.create({
    data: { id: randomUUID(), workroomId: WORKROOM_ID, title: `${DEMO_TITLE_PREFIX}发布 CodeLight 到 TestFlight`, description: '把当前 build 上传到 TestFlight 并等待人工确认是否分发。', status: 'in_progress', ownerInstanceId: agentId },
  });
  const actA = await db.controlAction.create({
    data: {
      id: randomUUID(), sessionId, workroomId: WORKROOM_ID, taskId: taskA.id, actorAgentId: agentId,
      kind: 'deploy', summary: '上传完成，等待人工确认是否继续分发到 TestFlight。',
      reversibility: 'irreversible_abortable', riskLevel: 'medium', requiresApproval: false,
      status: 'needs_human', firedAt: new Date(Date.now() - 20 * 60_000),
      clientIdempotencyKey: `${DEMO_PREFIX}${randomUUID()}`,
    },
  });
  // #59 runtime_warnings surface (renders in TaskDetail via GET /actions/:id flatten).
  await db.controlActionReconciliation.create({
    data: {
      id: randomUUID(), actionId: actA.id, evidenceId: `demo-evidence-${randomUUID().slice(0, 8)}`,
      reasonCode: 'fire_response_lost_token_unrecoverable', machineId: randomUUID(),
      runtimeWarnings: [
        { code: 'CLAUDE_DELEGATION_CONFIG_NOT_PROVISIONED', severity: 'warning', message: '受控委派配置未提供，已转人工复核，不静默继承上层登录。' },
      ],
    },
  });

  // ── Task B: active / running (active section) ──
  const taskB = await db.controlTask.create({
    data: { id: randomUUID(), workroomId: WORKROOM_ID, title: `${DEMO_TITLE_PREFIX}运行集成测试套件`, description: '在受控环境跑只读集成测试并回传结果。', status: 'in_progress', ownerInstanceId: agentId },
  });
  await db.controlAction.create({
    data: {
      id: randomUUID(), sessionId, workroomId: WORKROOM_ID, taskId: taskB.id, actorAgentId: agentId,
      kind: 'test', summary: '正在运行集成测试套件（只读）。', reversibility: 'reversible', riskLevel: 'low',
      requiresApproval: false, status: 'fired', firedAt: new Date(Date.now() - 3 * 60_000),
      clientIdempotencyKey: `${DEMO_PREFIX}${randomUUID()}`,
    },
  });

  // ── Task C: waiting review / transmission_complete + redaction sample ──
  const taskC = await db.controlTask.create({
    data: { id: randomUUID(), workroomId: WORKROOM_ID, title: `${DEMO_TITLE_PREFIX}轮换调试 token 并清理临时密钥`, description: '轮换调试 token 后清理临时文件，等待复核。', status: 'in_review', ownerInstanceId: agentId },
  });
  await db.controlAction.create({
    data: {
      id: randomUUID(), sessionId, workroomId: WORKROOM_ID, taskId: taskC.id, actorAgentId: agentId,
      kind: 'other',
      // Redaction sample: a fake dev_ctl_ token + a daemon-secret-shaped temp path. BOTH must render
      // as [REDACTED] in the UI. The path MUST match ControlPlaneRedactor's daemon-secret patterns
      // (/tmp/mio-* or /var/folders/.../T/mio-*) — a generic /Users/... path is NOT redacted by the client.
      summary: '已轮换调试 token dev_ctl_FAKE0000000000000000000000000000 并清理 /var/folders/zz/qm0n/T/mio-secret-tmp-abc123，等待复核。',
      reversibility: 'reversible', riskLevel: 'low', requiresApproval: false,
      status: 'transmission_complete', firedAt: new Date(Date.now() - 40 * 60_000),
      transmissionCompletedAt: new Date(Date.now() - 38 * 60_000),
      clientIdempotencyKey: `${DEMO_PREFIX}${randomUUID()}`,
    },
  });

  // Mint a read-only dev_ctl_ token bound to this workroom (same path as mintDevToken.ts).
  const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const tok = await db.controlDevToken.create({
    data: { tokenHash, orgId: ORG_ID, workroomId: WORKROOM_ID, scope: 'read_only', expiresAt },
  });

  console.log('');
  console.log('=== P1 acceptance fixture provisioned (token shown ONCE — copy now, DM only) ===');
  console.log(`  base_url:     https://mio.wdao.chat`);
  console.log(`  token:        ${rawToken}`);
  console.log(`  workroom_id:  ${WORKROOM_ID}`);
  console.log(`  org_id:       ${ORG_ID}`);
  console.log(`  token_id:     ${tok.id}`);
  console.log(`  scope:        read_only`);
  console.log(`  expires_at:   ${expiresAt.toISOString()} (TTL ${ttlHours}h)`);
  console.log(`  seeded:       3 tasks (in_progress×2 / in_review×1) + 3 actions (needs_human / fired / transmission_complete) + 1 reconciliation (#59 runtime_warnings) + redaction sample`);
  console.log('');
  console.log('  Cleanup when done:  tsx --env-file=.env scripts/p1-acceptance-seed.ts cleanup');
  console.log('');
}

/** Delete ONLY demo-tagged rows in the target workroom — never the daemon's real rows. */
async function cleanupRows(): Promise<{ recon: number; actions: number; tasks: number; sessions: number; agents: number; tokens: number }> {
  // Order matters (FK-safe): reconciliations → actions → tasks → sessions → agents → dev tokens.
  const demoActions = await db.controlAction.findMany({
    where: { workroomId: WORKROOM_ID, clientIdempotencyKey: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const demoActionIds = demoActions.map((a) => a.id);

  const recon = demoActionIds.length
    ? await db.controlActionReconciliation.deleteMany({ where: { actionId: { in: demoActionIds } } })
    : { count: 0 };
  const actions = await db.controlAction.deleteMany({ where: { workroomId: WORKROOM_ID, clientIdempotencyKey: { startsWith: DEMO_PREFIX } } });
  const tasks = await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID, title: { startsWith: DEMO_TITLE_PREFIX } } });
  const sessions = await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID, displayName: DEMO_SESSION_NAME } });
  const agents = await db.controlAgent.deleteMany({ where: { orgId: ORG_ID, name: DEMO_AGENT_NAME } });
  // dev_ctl_ tokens are only ever minted for CodeLight demos on this workroom; safe to remove all here.
  const tokens = await db.controlDevToken.deleteMany({ where: { workroomId: WORKROOM_ID } });

  return { recon: recon.count, actions: actions.count, tasks: tasks.count, sessions: sessions.count, agents: agents.count, tokens: tokens.count };
}

async function cleanup(): Promise<void> {
  const r = await cleanupRows();
  console.log(`cleanup: deleted reconciliations=${r.recon} actions=${r.actions} tasks=${r.tasks} sessions=${r.sessions} agents=${r.agents} dev_tokens=${r.tokens}`);
}

async function list(): Promise<void> {
  const tasks = await db.controlTask.count({ where: { workroomId: WORKROOM_ID, title: { startsWith: DEMO_TITLE_PREFIX } } });
  const actions = await db.controlAction.count({ where: { workroomId: WORKROOM_ID, clientIdempotencyKey: { startsWith: DEMO_PREFIX } } });
  const tokens = await db.controlDevToken.count({ where: { workroomId: WORKROOM_ID, revokedAt: null, expiresAt: { gt: new Date() } } });
  console.log(`demo fixtures in workroom ${WORKROOM_ID}: tasks=${tasks} actions=${actions} active_dev_tokens=${tokens}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const ttlArg = process.argv[3];
  if (cmd === 'provision') {
    const ttl = ttlArg ? Number.parseInt(ttlArg, 10) : 24;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 168) { console.error('ttlHours must be 1..168'); process.exit(1); }
    await provision(ttl);
  } else if (cmd === 'cleanup') {
    await cleanup();
  } else if (cmd === 'list') {
    await list();
  } else {
    console.error('Usage: p1-acceptance-seed.ts <provision [ttlHours] | cleanup | list>');
    await db.$disconnect();
    process.exit(1);
  }
  await db.$disconnect();
}

main().catch(async (e) => { console.error('p1-acceptance-seed failed:', e); try { await db.$disconnect(); } catch { /* */ } process.exit(1); });
