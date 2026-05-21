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
 */

import { db } from '@/storage/db';

interface MachineAccessOk {
  ok: true;
  workroomOrgId: string;
}

interface MachineAccessDenied {
  ok: false;
  status: 403 | 404;
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
 * Caches the workroom lookup in the same call to avoid double-queries when the
 * caller also needs the workroom record. For callers that need more workroom fields,
 * pass the workroom data you already have via the optional `workroomOverride` param.
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
