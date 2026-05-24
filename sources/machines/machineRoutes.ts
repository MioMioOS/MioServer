/**
 * Machine registration API — daemon-design §4
 *
 * SECURITY:
 * - machine_token is generated server-side as a random 256-bit hex string
 * - Only SHA-256(machine_token) is stored in DB (token_hash)
 * - The raw machine_token is returned ONCE at registration; daemon stores it in Keychain
 * - Subsequent auth uses Bearer machine_token; server verifies hash(token) == stored hash
 *
 * Endpoints:
 *   POST /api/v1/machines/register     → create machine + return machine_token (once)
 *   POST /api/v1/machines/:id/bind-org → bind machine to an org
 *   POST /api/v1/auth/machines/refresh → refresh machine_token (proactive, 7d before expiry)
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import {
  mintOperatorSession,
  OperatorSessionMintError,
  OPERATOR_SESSION_DEFAULT_TTL_HOURS,
  OPERATOR_SESSION_MAX_TTL_HOURS,
} from '@/control/operatorSessions/operatorSessionMint';

const TOKEN_EXPIRY_DAYS = 90;
const TOKEN_REFRESH_THRESHOLD_DAYS = 7;

function generateMachineToken(): string {
  return randomBytes(32).toString('hex'); // 256-bit random token
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenExpiresAt(days = TOKEN_EXPIRY_DAYS): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Verify a Bearer machine_token from Authorization header.
 * Returns the machine record if valid, or null if invalid/expired.
 */
export async function verifyMachineToken(authHeader: string | undefined) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const hash = hashToken(token);

  const machine = await db.controlMachine.findFirst({
    where: {
      tokenHash: hash,
      tokenExpiresAt: { gt: new Date() },
    },
  });
  return machine;
}

export async function machineRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/machines/register
   * Called by `mio-agent login` on a new machine.
   * Returns machine_token exactly ONCE — daemon must store it in Keychain immediately.
   */
  app.post('/api/v1/machines/register', {
    schema: {
      body: z.object({
        machine_id: z.string().uuid(),
        display_name: z.string().optional(),
        platform: z.string().default('darwin'),
        arch: z.string().default('arm64'),
      }),
    },
  }, async (request, reply) => {
    const { machine_id, display_name, platform, arch } = request.body as {
      machine_id: string;
      display_name?: string;
      platform: string;
      arch: string;
    };

    // Check if machine already registered (idempotent re-registration)
    const existing = await db.controlMachine.findUnique({ where: { id: machine_id } });
    if (existing) {
      return reply.code(409).send({
        error: {
          code: 'MACHINE_ALREADY_REGISTERED',
          message: 'Machine already registered. Use /auth/machines/refresh to get a new token.',
        },
      });
    }

    const machine_token = generateMachineToken();
    const token_hash = hashToken(machine_token);

    const machine = await db.controlMachine.create({
      data: {
        id: machine_id,
        displayName: display_name,
        platform,
        arch,
        tokenHash: token_hash,
        tokenExpiresAt: tokenExpiresAt(),
      },
    });

    // Return machine_token ONCE — daemon must immediately store in Keychain
    return {
      machine_id: machine.id,
      machine_token,  // Raw token — only returned at registration
      token_expires_at: machine.tokenExpiresAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/machines/:id/bind-org
   * Bind a registered machine to an org.
   * Requires valid machine_token in Authorization header.
   */
  app.post('/api/v1/machines/:id/bind-org', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ org_id: z.string().uuid() }),
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { org_id } = request.body as { org_id: string };

    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }
    if (machine.id !== id) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Token does not match machine id' } });
    }

    // Verify org exists
    const org = await db.controlOrg.findUnique({ where: { id: org_id } });
    if (!org) {
      return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org not found' } });
    }

    const updated = await db.controlMachine.update({
      where: { id },
      data: { orgId: org_id, boundAt: new Date(), lastSeenAt: new Date() },
    });

    // Ensure an agent identity exists for this machine so it appears in the
    // members list and resolves a display name on its messages (S2 §1.2).
    // Idempotent: @@unique([orgId, machineId]) + this findFirst guard means a
    // repeat bind does not create a duplicate ControlAgent row.
    const existingAgent = await db.controlAgent.findFirst({
      where: { orgId: org_id, machineId: machine.id },
      select: { id: true },
    });
    if (!existingAgent) {
      const displayName = machine.displayName?.trim() || 'Agent';
      await db.controlAgent.create({
        data: {
          orgId: org_id,
          machineId: machine.id,
          name: displayName,
          displayName,
          role: 'other',
          status: 'online',
        },
      });
    }

    return {
      machine_id: updated.id,
      org_id: updated.orgId,
      bound_at: updated.boundAt?.toISOString(),
    };
  });

  /**
   * POST /api/v1/auth/machines/refresh
   * Proactive token refresh (call 7 days before expiry).
   * Rotates the token: old token is invalidated, new token returned.
   * Daemon must update Keychain with new token immediately.
   */
  app.post('/api/v1/auth/machines/refresh', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    // Check if refresh is warranted (within 7-day threshold)
    const daysUntilExpiry =
      (machine.tokenExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    if (daysUntilExpiry > TOKEN_REFRESH_THRESHOLD_DAYS) {
      return reply.code(200).send({
        machine_id: machine.id,
        machine_token: null,
        message: `Token still valid for ${Math.floor(daysUntilExpiry)} days. Refresh not required yet.`,
        token_expires_at: machine.tokenExpiresAt.toISOString(),
      });
    }

    // Rotate token
    const new_token = generateMachineToken();
    const new_hash = hashToken(new_token);

    const updated = await db.controlMachine.update({
      where: { id: machine.id },
      data: {
        tokenHash: new_hash,
        tokenExpiresAt: tokenExpiresAt(),
        lastSeenAt: new Date(),
      },
    });

    return {
      machine_id: updated.id,
      machine_token: new_token,  // New raw token — daemon must update Keychain immediately
      token_expires_at: updated.tokenExpiresAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/machines/:id/issue-operator-session   (#133 token onboarding)
   *
   * An already-authenticated Mac/daemon (machine_token) requests a scoped, short-lived
   * op_sess_ for a workroom in its bound org, then relays it to a paired phone
   * (QR / pairing code). The server issues ONLY to an authenticated machine — never to
   * an unauthenticated phone — and holds no secret (local-auth-only: the auth root is the
   * machine_token of the user's own Mac). The raw op_sess_ token is returned ONCE.
   *
   * Order (no-leak): auth (401) → machine/id match (403) → bound org (409) → workroom
   * belongs to org (404, uniform for not-found OR cross-org) → mint.
   */
  app.post('/api/v1/machines/:id/issue-operator-session', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        workroom_id: z.string().uuid(),
        operator_subject_id: z.string().optional(),
        ttl_hours: z.number().int().positive().max(OPERATOR_SESSION_MAX_TTL_HOURS).optional(),
      }),
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workroom_id, operator_subject_id, ttl_hours } = request.body as {
      workroom_id: string; operator_subject_id?: string; ttl_hours?: number;
    };

    // 1. AUTH FIRST (anti-enumeration): valid machine_token AND it must match :id.
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }
    if (machine.id !== id) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Token does not match machine id' } });
    }
    if (!machine.orgId) {
      return reply.code(409).send({ error: { code: 'MACHINE_NOT_BOUND', message: 'Machine is not bound to an org' } });
    }

    // 2. Workroom must belong to THIS machine's org. No-leak: not-found OR cross-org → 404.
    const workroom = await db.controlWorkroom.findUnique({ where: { id: workroom_id }, select: { orgId: true } });
    if (!workroom || workroom.orgId !== machine.orgId) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    // 3. Mint a scoped, short-lived op_sess_ (V1 commands by default). Raw token returned ONCE.
    try {
      const result = await mintOperatorSession({
        orgId: machine.orgId,
        workroomId: workroom_id,
        operatorSubjectId: operator_subject_id ?? `machine:${machine.id}`,
        issuedBy: `machine:${machine.id}`,
        ttlHours: ttl_hours ?? OPERATOR_SESSION_DEFAULT_TTL_HOURS,
      });
      await db.controlMachine.update({ where: { id: machine.id }, data: { lastSeenAt: new Date() } });
      return {
        op_sess_token: result.rawToken,   // raw — returned ONCE; relay to phone, never stored server-side
        workroom_id,
        org_id: machine.orgId,
        allowed_commands: result.allowedCommands,
        expires_at: result.expiresAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof OperatorSessionMintError) {
        return reply.code(422).send({ error: { code: 'MINT_FAILED', message: 'Operator session could not be issued' } });
      }
      throw err;
    }
  });
}
