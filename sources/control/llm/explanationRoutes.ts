/**
 * #164 — server-assist explanation endpoint.
 *
 * GET /api/v1/workrooms/:workroomId/explanation?kind=<readiness|action_failure|task_summary>
 *   readiness:      &server_status=&read_status=&operator_status=   → deterministic template (#166)
 *   action_failure: &action_id=<uuid>                              → fetch action (scoped) → LLM/fallback
 *   task_summary:   &task_id=<uuid>                                 → fetch task (scoped)   → LLM/fallback
 *
 * Dual-auth (dev_ctl_ or machine_token), workroom-scoped. Feature-gated by a SERVER CONFIG flag
 * (config.serverLlmExplanationEnabled, default OFF — NOT per-org; per-org is a later DB upgrade).
 *
 * Phase 1: readiness is always deterministic (no LLM). action/task call the LLM provider IF one is
 * configured; until the (domestic-API) provider adapter is wired (#165), getExplanationProvider()
 * returns null → generateExplanation returns the deterministic fallback. The security boundary
 * (authorize-then-fetch, input/output redaction, output distrust) lives in generateExplanation.
 */
import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { config } from '@/config';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import {
  generateExplanation,
  type LLMProvider,
  type ExplanationStateInput,
} from './explanationService';
import {
  readinessExplanation,
  actionFailureFallback,
  taskSummaryFallback,
  type ReadStatus,
  type OperatorStatus,
  type ServerStatus,
} from './explanationCopy';
import { getDoubaoProvider } from './doubaoProvider';

/**
 * #169: the explanation provider is the 豆包 (Ark) adapter, but ONLY when key+model are configured.
 * getDoubaoProvider() returns null otherwise → generateExplanation falls back to deterministic copy.
 * This preserves #164's default-OFF safety: feature flag on + provider unconfigured = safe fallback.
 */
function getExplanationProvider(): LLMProvider | null {
  return getDoubaoProvider();
}

const ISO = () => new Date().toISOString();
const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function explanationRoutes(app: FastifyInstance) {
  app.get('/api/v1/workrooms/:workroomId/explanation', async (request, reply) => {
    // ── Dual-auth + workroom scope ──
    const auth = await authorizeControlRead(request);
    if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });

    const { workroomId } = request.params as { workroomId: string };
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, workroomId);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }
    // dev mode: devTokenInWorkroomScope already matched the path workroom in authorizeControlRead.
    const viewerId = auth.mode === 'dev' ? auth.devToken.id : auth.machine.id;

    // ── Feature gate (server config; default OFF). Off → never fetch, never call provider. ──
    if (!config.serverLlmExplanationEnabled) {
      return { feature_enabled: false, explanation_text: null, is_fallback: false, generated_at: null };
    }

    const q = request.query as Record<string, string | undefined>;
    const kind = q.kind;

    // ── readiness: deterministic template (no provider, no fetch) ──
    if (kind === 'readiness') {
      const text = readinessExplanation({
        serverStatus: (q.server_status as ServerStatus) || 'connected',
        readStatus: (q.read_status as ReadStatus) || 'unknown',
        operatorStatus: (q.operator_status as OperatorStatus) || 'missing',
      });
      return { feature_enabled: true, explanation_text: text, is_fallback: true, generated_at: ISO() };
    }

    // ── action_failure: scoped fetch (minimal fields) → LLM/fallback ──
    if (kind === 'action_failure') {
      if (!isUuid(q.action_id)) return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'action_id (uuid) required' } });
      const action = await db.controlAction.findUnique({ where: { id: q.action_id }, select: { status: true, workroomId: true } });
      // No-leak: not-found OR cross-workroom → uniform 404 (never reveal cross-workroom existence).
      if (!action || action.workroomId !== workroomId) {
        return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
      }
      const state: ExplanationStateInput = {
        kind: 'action_failure',
        fields: { action_status: action.status },
        provenance: { viewerId, workroomId, authorized: true },
      };
      const result = await generateExplanation({
        state,
        provider: getExplanationProvider(),
        deterministicFallback: () => actionFailureFallback(action.status),
        featureEnabled: true,
      });
      return { feature_enabled: true, ...result };
    }

    // ── task_summary: scoped fetch (minimal) → LLM/fallback ──
    if (kind === 'task_summary') {
      if (!isUuid(q.task_id)) return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'task_id (uuid) required' } });
      const task = await db.controlTask.findUnique({ where: { id: q.task_id }, select: { status: true, title: true, workroomId: true } });
      if (!task || task.workroomId !== workroomId) {
        return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
      }
      const state: ExplanationStateInput = {
        kind: 'task_summary',
        fields: { task_status: task.status, task_title: task.title },
        provenance: { viewerId, workroomId, authorized: true },
      };
      const result = await generateExplanation({
        state,
        provider: getExplanationProvider(),
        deterministicFallback: () => taskSummaryFallback(),
        featureEnabled: true,
      });
      return { feature_enabled: true, ...result };
    }

    return reply.code(400).send({ error: { code: 'INVALID_KIND', message: 'kind must be readiness | action_failure | task_summary' } });
  });
}
