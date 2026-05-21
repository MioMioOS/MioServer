/**
 * Machine access guard for control plane routes.
 *
 * SECURITY CONSTRAINT (per 运维 + PM review):
 * All control plane workroom-scoped endpoints MUST call requireMachineAccessToWorkroom()
 * after verifying the machine token. Token validity alone is NOT sufficient for
 * workroom access — the machine's org must match the workroom's org.
 *
 * Rules enforced:
 * 1. machine.orgId must be non-null (machine must have bound an org via /bind-org).
 * 2. machine.orgId === workroom.orgId (cross-org access is denied with 403).
 *
 * Usage:
 *   const machine = await verifyMachineToken(request.headers.authorization);
 *   if (!machine) return reply.code(401).send({ ... });
 *   const access = await requireMachineAccessToWorkroom(machine, workroomId);
 *   if (!access.ok) return reply.code(access.status).send({ error: access.error });
 *   // proceed — machine is authorized for this workroom
 *
 * DO NOT write inline orgId checks in route handlers.
 * Use this helper so authorization logic stays in one place.
 *
 * For cursor scope authorization, use resolveCursorScopeAccess() which resolves
 * the owning workroom from a scope (workroom | thread | session) and then delegates
 * to requireMachineAccessToWorkroom(). Cursor endpoints MUST also force
 * user_id = machine.id so cursor rows are machine-scoped at write time.
 */

import { db } from '@/storage/db';

interface MachineAccessOk {
  ok: true;
  workroomOrgId: string;
}

interface MachineAccessDenied {
  ok: false;
  status: 400 | 403 | 404;
  error: { code: string; message: string };
}

type MachineAccessResult = MachineAccessOk | MachineAccessDenied;

interface MachineRecord {
  id: string;
  orgId: string | null;
}

/**
 * Check that a verified machine is authorized to access a specific workroom.
 *
 * Returns { ok: true, workroomOrgId } on success.
 * Returns { ok: false, status, error } on failure — caller must return the HTTP response.
 *
 * @param workroomOverride  INTERNAL-ONLY optimization. Pass this ONLY when the
 *   calling route has ALREADY queried the workroom record from DB and has its orgId.
 *   This skips a redundant DB lookup — it does NOT bypass authorization.
 *   The authorization check (machine.orgId === override.orgId) still runs.
 *   NEVER expose this parameter to external request inputs. It must always
 *   come from server-side DB data, never from client-supplied values.
 */
export async function requireMachineAccessToWorkroom(
  machine: MachineRecord,
  workroomId: string,
  workroomOverride?: { orgId: string },
): Promise<MachineAccessResult> {
  // Rule 1: machine must have bound an org
  if (!machine.orgId) {
    return {
      ok: false,
      status: 403,
      error: { code: 'MACHINE_NO_ORG', message: 'Machine has not bound an org. Call /bind-org first.' },
    };
  }

  // Rule 2: org must match
  const orgId = workroomOverride?.orgId ?? (await db.controlWorkroom.findUnique({
    where: { id: workroomId },
    select: { orgId: true },
  }))?.orgId;

  if (orgId === undefined) {
    return {
      ok: false,
      status: 404,
      error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' },
    };
  }

  if (machine.orgId !== orgId) {
    return {
      ok: false,
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
    };
  }

  return { ok: true, workroomOrgId: orgId };
}

/**
 * Resolve the workroom behind a cursor scope and verify the machine is authorized.
 *
 * Cursor scope types:
 *   workroom — scope_id IS the workroom_id. Checks directly.
 *   thread   — scope_id is a ControlThread.id. Resolves thread.workroomId, then checks.
 *   session  — scope_id is a ControlSession.id. Resolves session.workroomId + orgId, then checks.
 *
 * Returns { ok: true, workroomOrgId } on success.
 * Returns { ok: false, status, error } on failure — caller must return the HTTP response.
 *
 * IMPORTANT: Cursor write endpoints (PATCH /cursors) MUST ALSO force user_id = machine.id
 * so cursor rows are machine-scoped at write time. This function only handles scope/org access.
 */
export async function resolveCursorScopeAccess(
  machine: MachineRecord,
  scopeType: string,
  scopeId: string,
): Promise<MachineAccessResult> {
  if (scopeType === 'workroom') {
    // scope_id is directly the workroom_id — delegate to standard workroom guard.
    return requireMachineAccessToWorkroom(machine, scopeId);
  }

  if (scopeType === 'thread') {
    // Resolve owning workroom via the thread record.
    const thread = await db.controlThread.findUnique({
      where: { id: scopeId },
      select: { workroomId: true },
    });
    if (!thread) {
      return {
        ok: false,
        status: 404,
        error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found for cursor scope' },
      };
    }
    return requireMachineAccessToWorkroom(machine, thread.workroomId);
  }

  if (scopeType === 'session') {
    // Resolve owning workroom via the session record (use orgId shortcut to skip extra DB query).
    const session = await db.controlSession.findUnique({
      where: { id: scopeId },
      select: { workroomId: true, orgId: true },
    });
    if (!session) {
      return {
        ok: false,
        status: 404,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found for cursor scope' },
      };
    }
    // Pass session.orgId as workroomOverride to avoid a redundant DB lookup.
    // Authorization (machine.orgId === session.orgId) still runs inside requireMachineAccessToWorkroom.
    return requireMachineAccessToWorkroom(machine, session.workroomId, { orgId: session.orgId });
  }

  return {
    ok: false,
    status: 400,
    error: {
      code: 'INVALID_SCOPE_TYPE',
      message: `Unsupported cursor scope_type '${scopeType}'. Must be: workroom, thread, session`,
    },
  };
}
