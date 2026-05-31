/**
 * provisionPersonalWorkspace — reusable primitive that gives a user a usable
 * "home" workspace: a personal ControlOrg + a default ControlWorkroom +
 * an owner UserWorkroomMembership, and pins User.defaultWorkroomId if unset.
 *
 * CONTEXT (corrected model): a real "workspace" (== ControlWorkroom) is normally
 * created COMPUTER-SIDE at machine enrollment when a Mac runs mio-agent — NOT
 * auto-provisioned for the user at signin. This helper is the shared primitive
 * that enrollment uses to mint that first workroom for a user. R1 also calls it
 * from scripts/dev-seed-users.ts so seeded test accounts are usable end-to-end.
 *
 * CALLABLE TWO WAYS (both supported, see Db type):
 *   - With a PrismaClient  → opens its own db.$transaction so the org + workroom
 *     + membership + defaultWorkroomId pin are atomic (a partial failure can
 *     never leave a half-provisioned user).
 *   - With a Prisma.TransactionClient (tx) → runs the same steps directly on the
 *     caller's transaction (the enrollment flow already owns an interactive
 *     transaction; nesting db.$transaction inside it is not allowed). The
 *     caller's transaction provides the atomicity guarantee.
 *
 * IDEMPOTENCY: keyed off a deterministic per-user org slug (`personal-<userId>`).
 * If that org already exists with a live workroom we return the existing ids
 * without creating a second org/workroom; if the org exists but its workroom is
 * missing/archived we self-heal by creating only the workroom + membership.
 * Safe to call repeatedly (re-runnable seed, re-enrollment, etc.).
 *
 * NOTE on uuid columns: ControlOrg.ownerUserId and ControlWorkroom.createdBy are
 * `@db.Uuid` but User.id is a cuid (not a uuid) and there is NO FK from these
 * columns to User. To stay schema-valid we generate a fresh uuid for those
 * columns (mirroring the existing dev-seed-slock.ts convention) rather than
 * forcing a cuid into a uuid column. The authoritative owner link is the
 * UserWorkroomMembership(role='owner') row, which references User.id correctly.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';

/** Either a full PrismaClient or an interactive-transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface ProvisionPersonalWorkspaceOptions {
    /** Workroom name; defaults to "Personal". */
    workroomName?: string;
    /** Human-facing org name; defaults to "Personal workspace". */
    orgName?: string;
    /**
     * Override the org slug (the idempotency key). Defaults to `personal-<userId>`.
     * Enrollment passes a PER-ENROLLMENT slug so each computer gets its OWN
     * workspace (1 computer = 1 workspace) instead of all machines sharing the
     * user's single personal workspace. A unique slug always provisions fresh.
     */
    orgSlug?: string;
}

export interface ProvisionPersonalWorkspaceResult {
    orgId: string;
    workroomId: string;
    /** false when an existing personal workspace was found and reused. */
    created: boolean;
}

/** Deterministic, collision-free slug for a user's personal org. */
function personalOrgSlug(userId: string): string {
    return `personal-${userId}`;
}

/** True when the given client is a full PrismaClient (has $transaction). */
function isFullClient(db: Db): db is PrismaClient {
    return typeof (db as PrismaClient).$transaction === 'function';
}

/**
 * Core work, parameterized over a transaction-capable client (`tx`). Assumes it
 * is running inside a transaction (either the caller's, or one we opened).
 */
async function run(
    tx: Prisma.TransactionClient,
    userId: string,
    opts: ProvisionPersonalWorkspaceOptions,
): Promise<ProvisionPersonalWorkspaceResult> {
    const slug = opts.orgSlug ?? personalOrgSlug(userId);

    const existingOrg = await tx.controlOrg.findUnique({ where: { slug } });
    if (existingOrg) {
        const existingWorkroom = await tx.controlWorkroom.findFirst({
            where: { orgId: existingOrg.id, archivedAt: null },
            orderBy: { createdAt: 'asc' },
        });
        if (existingWorkroom) {
            await pinDefaultIfUnset(tx, userId, existingWorkroom.id);
            return { orgId: existingOrg.id, workroomId: existingWorkroom.id, created: false };
        }
        // Org exists but workroom missing/archived → fall through and create only
        // the workroom + membership against the existing org (self-healing).
    }

    const orgName = opts.orgName ?? 'Personal workspace';
    const workroomName = opts.workroomName ?? 'Personal';

    const org =
        existingOrg ??
        (await tx.controlOrg.create({
            data: {
                id: randomUUID(),
                name: orgName,
                slug,
                // No FK to User; uuid column requires a uuid value. See file header.
                ownerUserId: randomUUID(),
                billingPlan: 'free',
            },
        }));

    const workroom = await tx.controlWorkroom.create({
        data: {
            id: randomUUID(),
            orgId: org.id,
            name: workroomName,
            visibility: 'private',
            // uuid column, no FK to User. See file header.
            createdBy: randomUUID(),
        },
    });

    await tx.userWorkroomMembership.upsert({
        where: { userId_workroomId: { userId, workroomId: workroom.id } },
        create: { userId, workroomId: workroom.id, role: 'owner' },
        update: {},
    });

    await pinDefaultIfUnset(tx, userId, workroom.id);

    return { orgId: org.id, workroomId: workroom.id, created: true };
}

/**
 * Pin User.defaultWorkroomId only when it is currently null — never clobber a
 * user's explicitly-chosen default. (Empty/null = no-op fallback, not "clear".)
 */
async function pinDefaultIfUnset(
    tx: Prisma.TransactionClient,
    userId: string,
    workroomId: string,
): Promise<void> {
    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { defaultWorkroomId: true },
    });
    if (user && user.defaultWorkroomId == null) {
        await tx.user.update({
            where: { id: userId },
            data: { defaultWorkroomId: workroomId },
        });
    }
}

export async function provisionPersonalWorkspace(
    db: Db,
    userId: string,
    opts: ProvisionPersonalWorkspaceOptions = {},
): Promise<ProvisionPersonalWorkspaceResult> {
    // Full client → own the transaction. Transaction client → run inline (the
    // caller's transaction already provides atomicity; Prisma forbids nesting
    // db.$transaction inside an interactive transaction).
    if (isFullClient(db)) {
        return db.$transaction((tx) => run(tx, userId, opts));
    }
    return run(db, userId, opts);
}
