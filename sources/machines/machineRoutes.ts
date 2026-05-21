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
}
