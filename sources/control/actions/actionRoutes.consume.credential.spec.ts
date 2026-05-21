/**
 * consume credential resolution — route-level tests (Phase 5D, task #18).
 *
 * Tests the full 5D credential resolution logic in POST /actions/:id/token/consume:
 *   CAS consume → ACTION_KIND_REQUIRES_CREDENTIAL check → scope validation → CredentialStore.resolve
 *
 * External HTTP contract (anti-enumeration):
 *   ALL credential failures → 403 TOKEN_NOT_CONSUMABLE (unified, same as CAS rejection)
 *   Subprocess/daemon only learns "consume failed", not which specific reason.
 *   Internal reason: action.status (failed | needs_human) + access_log.reason_code
 *
 * Coverage (13 tests — route-level with mocked DB + FixtureCredentialStore):
 *   1.  No credential required (kind not in set) → 200, empty bundle, no DB access for cred
 *   2.  Required (publish_ios), no alias → 403 TOKEN_NOT_CONSUMABLE, action=failed
 *   3.  Required, alias, credential not found in DB → 403 TOKEN_NOT_CONSUMABLE, action=needs_human
 *   4.  Workroom not in scope (workroom mode) → 403 TOKEN_NOT_CONSUMABLE, action=failed
 *   5.  Action kind not in allowed_action_kinds → 403 TOKEN_NOT_CONSUMABLE, action=failed
 *   6.  Credential revoked → 403 TOKEN_NOT_CONSUMABLE, action=failed
 *   7.  Credential expired → 403 TOKEN_NOT_CONSUMABLE, action=failed
 *   8.  store_unavailable → 403 TOKEN_NOT_CONSUMABLE, action=needs_human
 *   9.  credential_not_found in store → 403 TOKEN_NOT_CONSUMABLE, action=needs_human
 *  10.  No credential store configured → 403 TOKEN_NOT_CONSUMABLE, action=needs_human
 *  11.  Full success → 200, bundle item: key=alias, value=secret, kind=inject-kind (env_var)
 *  12.  No-leak: event payloads on failure do NOT contain the secret value (controlled enum only)
 *  13.  Org-scoped credential (scopeMode='org') bypasses workroom check → success
 *
 * SEMANTIC INVARIANT (product contract):
 *   `failed`      = policy/auth denial — retrying won't help even if config is fixed
 *                   (workroom scope, action kind, revoked, expired, no alias on action)
 *   `needs_human` = configuration/transient error — operator can fix and human reviews
 *                   (alias not registered, store_unavailable, config_invalid)
 *
 * SECURITY INVARIANTS UNDER TEST:
 *   - reason_code in event payloads is a controlled enum, NOT a secret value
 *   - secretValue NEVER appears in event payloads, logs, or mock captures
 *   - CredentialStoreError.reason drives needs_human vs failed routing
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { actionRoutes } from './actionRoutes';
import { FixtureCredentialStore, CredentialStoreError } from '@/control/credentials/credentialStore';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.fn();
const mockPublishControlEvent = vi.fn();
const mockBroadcast = vi.fn();

// DB mocks
const mockTokenUpdateMany = vi.fn();      // CAS consume
const mockTokenFindFirst = vi.fn();       // tokenRecord fetch
const mockActionFindUnique = vi.fn();     // action fetch (kind + credentialAliasRef + workroom.orgId)
const mockActionUpdateMany = vi.fn();     // status transition on credential failure (safe CAS updateMany)
const mockCredentialFindUnique = vi.fn(); // credential lookup
const mockAccessLogCreate = vi.fn();      // audit log write
const mockCredentialUpdate = vi.fn();     // lastUsedAt update

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...a: unknown[]) => mockVerifyMachineToken(...a),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/control/events/publishControlEvent', () => ({
  publishControlEvent: (...a: unknown[]) => mockPublishControlEvent(...a),
}));

vi.mock('@/control/ws/workroomBroadcaster', () => ({
  workroomBroadcaster: {
    broadcast: (...a: unknown[]) => mockBroadcast(...a),
  },
}));

vi.mock('@/storage/db', () => ({
  db: {
    controlActionToken: {
      updateMany: (...a: unknown[]) => mockTokenUpdateMany(...a),
      findFirst: (...a: unknown[]) => mockTokenFindFirst(...a),
    },
    controlAction: {
      // Used by fire, cancel, etc. — non-consume routes; provide stubs
      create: vi.fn(),
      findUnique: (...a: unknown[]) => mockActionFindUnique(...a),
      // updateMany: used for the credential failAction safe CAS AND by other routes
      updateMany: (...a: unknown[]) => mockActionUpdateMany(...a),
      update: vi.fn(),  // not used in consume credential path
    },
    controlApproval: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    controlActionApprovalConsumption: { create: vi.fn() },
    controlActionReconciliation: { create: vi.fn() },
    controlWorkroom: { findUnique: vi.fn() },
    controlCredential: {
      findUnique: (...a: unknown[]) => mockCredentialFindUnique(...a),
      update: (...a: unknown[]) => mockCredentialUpdate(...a),
    },
    controlCredentialAccessLog: {
      create: (...a: unknown[]) => mockAccessLogCreate(...a),
    },
    $transaction: vi.fn(),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_ACTION_TOKEN = 'act_tok_testcred_abc123xyz456def789ghi012jkl';
const ACTION_ID = 'act-cred-1';
const SESSION_ID = 'sess-cred-1';
const WORKROOM_ID = 'wroom-cred-1';
const MACHINE_ID = 'machine-cred-1';
const ORG_ID = 'org-cred-1';
const CREDENTIAL_ID = 'cred-id-1';
const STORAGE_REF = 'ref:asc_key_prod';
const SECRET_VALUE = 'test_secret_asc_api_key_value_abc123';

/** Default fired action — publish_ios kind (credential-required). */
const FIRED_ACTION_WITH_CRED = {
  kind: 'publish_ios',
  credentialAliasRef: 'asc-key',
  workroomId: WORKROOM_ID,
  workroom: { orgId: ORG_ID },
};

/** Default token record — consumed (CAS success path). */
const TOKEN_RECORD = {
  sessionId: SESSION_ID,
  workroomId: WORKROOM_ID,
  machineId: MACHINE_ID,
};

/** Valid credential — workroom-scoped, allows publish_ios, not revoked/expired. */
const VALID_CREDENTIAL = {
  id: CREDENTIAL_ID,
  kind: 'asc_api_key',
  alias: 'asc-key',
  storageRef: STORAGE_REF,
  scopeMode: 'workroom',
  scopeWorkroomIds: [WORKROOM_ID],
  allowedActionKinds: ['publish_ios'],
  revoked: false,
  expiresAt: null,
};

// ── App setup ─────────────────────────────────────────────────────────────────

/**
 * Build Fastify app with the given credentialStore (or undefined for no-store tests).
 * Registered once per describe block via beforeAll.
 */
async function buildApp(store?: FixtureCredentialStore): Promise<FastifyInstance> {
  const a = fastify();
  // Wrap to avoid Fastify plugin-type inference issues with options
  await a.register((instance, _opts, done) => {
    actionRoutes(instance, { credentialStore: store }).then(() => done()).catch(done);
  });
  await a.ready();
  return a;
}

// ── Helper: make a consume request ───────────────────────────────────────────

function consumeRequest(app: FastifyInstance, token = FAKE_ACTION_TOKEN, actionId = ACTION_ID) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/actions/${actionId}/token/consume`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    payload: {},
  });
}

// ── Standard "CAS succeeds" mock setup ───────────────────────────────────────

function setupCasSuccess() {
  // CAS: token not yet consumed, not expired → count=1
  mockTokenUpdateMany.mockResolvedValue({ count: 1 });
  // tokenRecord fetch after CAS
  mockTokenFindFirst.mockResolvedValue(TOKEN_RECORD);
  // publishControlEvent + broadcast stubs
  mockPublishControlEvent.mockResolvedValue({
    id: 'evt-1', eventId: 'evt-uuid', workroomId: WORKROOM_ID,
    seq: '1', topic: 'stub', payloadJson: {}, createdAt: new Date(), idempotent: false,
  });
  mockCredentialUpdate.mockResolvedValue({});
  mockAccessLogCreate.mockResolvedValue({ id: 'log-1' });
  mockActionUpdateMany.mockResolvedValue({ count: 1 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 5D consume — credential resolution route-level tests', () => {
  let app: FastifyInstance;
  let store: FixtureCredentialStore;

  beforeAll(async () => {
    store = new FixtureCredentialStore({ [STORAGE_REF]: SECRET_VALUE });
    app = await buildApp(store);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    setupCasSuccess();
  });

  // ── 1. No credential required ─────────────────────────────────────────────

  it('1. kind not in ACTION_KIND_REQUIRES_CREDENTIAL → 200 empty bundle (no credential lookup)', async () => {
    // deploy is NOT in the required set
    mockActionFindUnique.mockResolvedValue({
      kind: 'deploy',
      credentialAliasRef: null,
      workroomId: WORKROOM_ID,
      workroom: { orgId: ORG_ID },
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.consumed).toBe(true);
    expect(body.action_id).toBe(ACTION_ID);
    expect(body.session_id).toBe(SESSION_ID);
    expect(body.workroom_id).toBe(WORKROOM_ID);
    expect(body.secret_bundle).toEqual({ version: 1, items: [] });

    // Credential lookup must NOT be called for non-required kinds
    expect(mockCredentialFindUnique).not.toHaveBeenCalled();
  });

  // ── 2. Required, no alias ─────────────────────────────────────────────────

  it('2. publish_ios with no credential_alias_ref → 403 TOKEN_NOT_CONSUMABLE, action=failed', async () => {
    mockActionFindUnique.mockResolvedValue({
      kind: 'publish_ios',
      credentialAliasRef: null,    // ← no alias
      workroomId: WORKROOM_ID,
      workroom: { orgId: ORG_ID },
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TOKEN_NOT_CONSUMABLE');

    // Action must be transitioned to 'failed'
    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // Event topic must be action.failed
    expect(mockPublishControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'action.failed' }),
    );
    // Event payload: controlled enum only — no secret values
    const eventCall = mockPublishControlEvent.mock.calls[0][0];
    expect(eventCall.payload.reason_code).toBe('credential_denied');
    expect(JSON.stringify(eventCall.payload)).not.toContain(SECRET_VALUE);
  });

  // ── 3. Credential not found in DB ─────────────────────────────────────────
  // Alias not registered = operator configuration error → needs_human (not failed).
  // Operator can register the credential; action needs human review.

  it('3. alias not registered for org → 403 TOKEN_NOT_CONSUMABLE, action=needs_human', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue(null);  // not found

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

    // needs_human (not failed) — config error, operator can fix
    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'needs_human' }) }),
    );
    expect(mockPublishControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'action.needs_human' }),
    );
    // No access log when credential not found (no credentialId to reference)
    expect(mockAccessLogCreate).not.toHaveBeenCalled();
  });

  // ── 4. Workroom not in scope ──────────────────────────────────────────────

  it('4. workroom not in scope_workroom_ids → 403 TOKEN_NOT_CONSUMABLE, action=failed', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      scopeMode: 'workroom',
      scopeWorkroomIds: ['wroom-different'],  // ← wrong workroom
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // Access log written with success=false
    expect(mockAccessLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ success: false, reasonCode: 'credential_denied' }),
      }),
    );
  });

  // ── 5. Action kind not in allowed_action_kinds ────────────────────────────

  it('5. action kind not in allowed_action_kinds → 403 TOKEN_NOT_CONSUMABLE, action=failed', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      allowedActionKinds: ['deploy_web'],  // ← does not include publish_ios
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  // ── 6. Credential revoked ─────────────────────────────────────────────────

  it('6. revoked=true → 403 TOKEN_NOT_CONSUMABLE, action=failed', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      revoked: true,
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  // ── 7. Credential expired ─────────────────────────────────────────────────

  it('7. expiresAt in the past → 403 TOKEN_NOT_CONSUMABLE, action=failed', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      expiresAt: new Date('2020-01-01'),  // ← clearly expired
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

    expect(mockActionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  // ── 8. store_unavailable ──────────────────────────────────────────────────

  it('8. CredentialStore throws store_unavailable → 403 TOKEN_NOT_CONSUMABLE, action=needs_human', async () => {
    // Override store to throw store_unavailable
    const failingStore = new FixtureCredentialStore();
    // resolve will throw credential_not_found normally; override to store_unavailable
    vi.spyOn(failingStore, 'resolve').mockRejectedValue(
      new CredentialStoreError('store_unavailable', 'Test vault connection failed'),
    );

    const testApp = await buildApp(failingStore);
    setupCasSuccess();
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue(VALID_CREDENTIAL);

    try {
      const res = await consumeRequest(testApp);

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('TOKEN_NOT_CONSUMABLE');

      // Action transitions to needs_human (recoverable, not terminal)
      expect(mockActionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_human' }) }),
      );
      expect(mockPublishControlEvent).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'action.needs_human' }),
      );
      // Access log written: success=false, store_unavailable
      expect(mockAccessLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            reasonCode: 'credential_store_unavailable',
          }),
        }),
      );
    } finally {
      await testApp.close();
    }
  });

  // ── 9. credential_not_found in store ─────────────────────────────────────

  it('9. CredentialStore throws credential_not_found → 403 TOKEN_NOT_CONSUMABLE, needs_human', async () => {
    const failingStore = new FixtureCredentialStore();  // empty — will throw not_found
    vi.spyOn(failingStore, 'resolve').mockRejectedValue(
      new CredentialStoreError('credential_not_found', 'Test: ref not in store'),
    );

    const testApp = await buildApp(failingStore);
    setupCasSuccess();
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue(VALID_CREDENTIAL);

    try {
      const res = await consumeRequest(testApp);

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

      expect(mockActionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_human' }) }),
      );
      expect(mockAccessLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            reasonCode: 'credential_configuration_invalid',
          }),
        }),
      );
    } finally {
      await testApp.close();
    }
  });

  // ── 10. No credential store configured ───────────────────────────────────

  it('10. no credentialStore configured → 403 TOKEN_NOT_CONSUMABLE, needs_human', async () => {
    // Build app WITHOUT a credentialStore
    const noStoreApp = await buildApp(undefined);
    setupCasSuccess();
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue(VALID_CREDENTIAL);

    try {
      const res = await consumeRequest(noStoreApp);

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

      // Should transition to needs_human (recoverable — operator must wire a store)
      expect(mockActionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'needs_human' }) }),
      );
    } finally {
      await noStoreApp.close();
    }
  });

  // ── 11. Full success ──────────────────────────────────────────────────────

  it('11. full success → 200, bundle item key/value/kind, access log success=true, lastUsedAt updated', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue(VALID_CREDENTIAL);

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.consumed).toBe(true);
    expect(body.action_id).toBe(ACTION_ID);
    expect(body.session_id).toBe(SESSION_ID);
    expect(body.workroom_id).toBe(WORKROOM_ID);

    // Bundle: exactly one item with key=alias, value=secret, kind from credential
    expect(body.secret_bundle.version).toBe(1);
    expect(body.secret_bundle.items).toHaveLength(1);
    const item = body.secret_bundle.items[0];
    expect(item.key).toBe('asc-key');          // credential.alias
    expect(item.value).toBe(SECRET_VALUE);     // resolved plaintext
    // inject kind: asc_api_key → 'file' (.p8 private key must be written to 0600 temp file)
    expect(item.kind).toBe('file');            // credentialInjectKind(credential.kind)

    // Access log: success=true, no reasonCode
    expect(mockAccessLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: CREDENTIAL_ID,
          actionId: ACTION_ID,
          machineId: MACHINE_ID,
          success: true,
          reasonCode: null,
        }),
      }),
    );

    // lastUsedAt updated on the credential
    expect(mockCredentialUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CREDENTIAL_ID },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );

    // No action.failed or action.needs_human event emitted on success
    const eventCalls = mockPublishControlEvent.mock.calls;
    for (const call of eventCalls) {
      expect(call[0].topic).not.toBe('action.failed');
      expect(call[0].topic).not.toBe('action.needs_human');
    }
  });

  // ── 12. No-leak: secret not in event payloads ─────────────────────────────

  it('12. failure events: reason_code is controlled enum, NOT secret value', async () => {
    // Trigger a scope failure so an event is emitted
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      revoked: true,  // ← scope failure
    });

    await consumeRequest(app);

    // Verify all emitted events contain only controlled enums, not secret values
    const eventCalls = mockPublishControlEvent.mock.calls;
    expect(eventCalls.length).toBeGreaterThan(0);

    for (const call of eventCalls) {
      const payloadStr = JSON.stringify(call[0].payload);
      // No secret value in any event
      expect(payloadStr).not.toContain(SECRET_VALUE);
      // reason_code must be a known controlled enum value
      if (call[0].payload.reason_code !== undefined) {
        expect(['credential_denied', 'credential_store_unavailable', 'credential_configuration_invalid'])
          .toContain(call[0].payload.reason_code);
      }
    }
  });

  // ── 13. org-scoped credential bypasses workroom check ────────────────────

  it('13. scopeMode=org: workroom not listed → still resolves (org-wide scope)', async () => {
    mockActionFindUnique.mockResolvedValue(FIRED_ACTION_WITH_CRED);
    mockCredentialFindUnique.mockResolvedValue({
      ...VALID_CREDENTIAL,
      scopeMode: 'org',
      scopeWorkroomIds: [],   // empty — irrelevant for org-wide scope
    });

    const res = await consumeRequest(app);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.secret_bundle.items).toHaveLength(1);
    expect(body.secret_bundle.items[0].value).toBe(SECRET_VALUE);
  });
});
