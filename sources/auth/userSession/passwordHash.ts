import * as bcrypt from 'bcrypt';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
}

// Anti-enumeration dummy: compare against this when the email is unknown so the
// signin path takes the same bcrypt-bound time as a real (wrong-password) check.
// Keeps timing of unknown-email signin within 5% of known-email per spec §10.
export const DUMMY_PASSWORD_HASH = '$2b$12$abcdefghijklmnopqrstuOH7e7N5C5j3DnL4cQwKvE.kP4mZQGAm.';
