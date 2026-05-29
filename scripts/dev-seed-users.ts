/**
 * dev-seed-users.ts — Local dev seed for R1 test human accounts.
 *
 * Idempotently creates a small fixed set of test users, each with:
 *   - a bcrypt-hashed password (hashPassword, cost 12)
 *   - a friendly displayName
 *   - a personal workspace (ControlOrg + default ControlWorkroom + owner
 *     membership), via provisionPersonalWorkspace, so the account is usable
 *     end-to-end immediately (signin returns a non-empty workrooms[]).
 *
 * Idempotency:
 *   - users are upserted by unique email (re-running updates displayName +
 *     password hash, never duplicates).
 *   - provisionPersonalWorkspace is itself idempotent (keyed on a per-user org
 *     slug), so re-runs don't spawn extra orgs/workrooms.
 *
 * Usage:
 *   tsx scripts/dev-seed-users.ts            # reads DATABASE_URL from env
 *   tsx --env-file=.env.dev scripts/dev-seed-users.ts
 *
 * Output: prints each seeded email + password (these are DEV-ONLY throwaway
 * credentials) and the provisioned workroom id, then a copy-paste summary.
 *
 * SECURITY: passwords here are intentionally weak dev throwaways. NEVER point
 * this script at a production DATABASE_URL.
 */
import { db } from '@/storage/db';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { provisionPersonalWorkspace } from '@/control/workrooms/provisionPersonalWorkspace';

interface SeedAccount {
    email: string;
    password: string;
    displayName: string;
}

// Fixed dev roster. Simple shared password keeps local signin frictionless.
const SEED_ACCOUNTS: SeedAccount[] = [
    { email: 'kris@slock.dev', password: 'slock1234', displayName: 'Kris' },
    { email: 'alex@slock.dev', password: 'slock1234', displayName: 'Alex' },
    { email: 'sam@slock.dev', password: 'slock1234', displayName: 'Sam' },
    { email: 'jordan@slock.dev', password: 'slock1234', displayName: 'Jordan' },
];

async function main(): Promise<void> {
    const seeded: Array<{ email: string; password: string; workroomId: string }> = [];

    for (const acct of SEED_ACCOUNTS) {
        const passwordHash = await hashPassword(acct.password);

        const user = await db.user.upsert({
            where: { email: acct.email },
            create: {
                email: acct.email,
                passwordHash,
                displayName: acct.displayName,
            },
            update: {
                // Keep dev credentials + display name in sync on re-run.
                passwordHash,
                displayName: acct.displayName,
            },
        });

        const ws = await provisionPersonalWorkspace(db, user.id, {
            workroomName: `${acct.displayName}'s workspace`,
            orgName: `${acct.displayName}'s org`,
        });

        seeded.push({ email: acct.email, password: acct.password, workroomId: ws.workroomId });
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\nSeeded dev users (email / password):');
    for (const s of seeded) {
        console.log(`  ${s.email}  ${s.password}   (workroom ${s.workroomId})`);
    }
    console.log(`\n${seeded.length} accounts ready. Sign in via POST /v1/users/signin.\n`);

    await db.$disconnect();
}

const isDirectRun =
    process.argv[1]?.endsWith('dev-seed-users.ts') ||
    process.argv[1]?.endsWith('dev-seed-users.js');

if (isDirectRun) {
    main().catch(async (err) => {
        console.error('dev-seed-users failed:', err);
        try {
            await db.$disconnect();
        } catch {
            /* */
        }
        process.exit(1);
    });
}
