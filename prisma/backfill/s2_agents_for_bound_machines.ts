/**
 * S2 backfill: create a ControlAgent identity row for every already-bound machine.
 *
 * Background: from S2 onward, bind-org creates a ControlAgent for the machine so it
 * appears in the members list and resolves a display name on its messages. Machines
 * that were bound BEFORE this change have no ControlAgent — this script backfills them.
 *
 * For each ControlMachine with boundAt != null AND orgId != null that lacks a matching
 * ControlAgent (by {orgId, machineId}), create one:
 *   - machineId   = machine.id
 *   - orgId       = machine.orgId
 *   - displayName = machine.displayName?.trim() || 'Agent'
 *   - name        = same as displayName
 *   - role        = 'other'
 *   - status      = 'online'
 *
 * Idempotent: guarded by findFirst + the @@unique([orgId, machineId]) index. A second
 * run prints "0 created".
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.dev prisma/backfill/s2_agents_for_bound_machines.ts
 *
 * (Or set DATABASE_URL explicitly:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/codelight_test \
 *     npx tsx prisma/backfill/s2_agents_for_bound_machines.ts)
 */

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
    console.log('[s2_backfill] Starting ControlAgent backfill for bound machines…');

    const machines = await db.controlMachine.findMany({
        where: { boundAt: { not: null }, orgId: { not: null } },
        select: { id: true, orgId: true, displayName: true },
    });

    console.log(`[s2_backfill] Found ${machines.length} bound machine(s) to consider.`);

    let created = 0;
    let skipped = 0;

    for (const machine of machines) {
        // orgId is non-null by the query filter; assert for the type system.
        const orgId = machine.orgId!;

        const existing = await db.controlAgent.findFirst({
            where: { orgId, machineId: machine.id },
            select: { id: true },
        });

        if (existing) {
            skipped++;
            continue;
        }

        const displayName = machine.displayName?.trim() || 'Agent';
        await db.controlAgent.create({
            data: {
                orgId,
                machineId: machine.id,
                name: displayName,
                displayName,
                role: 'other',
                status: 'online',
            },
        });
        created++;
        console.log(`[s2_backfill]   machine ${machine.id} (org ${orgId}): created agent "${displayName}"`);
    }

    console.log(`[s2_backfill] Done. ${created} created, ${skipped} already had an agent.`);
}

main()
    .catch((err) => {
        console.error('[s2_backfill] ERROR:', err);
        process.exit(1);
    })
    .finally(() => {
        db.$disconnect();
    });
