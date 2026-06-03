/**
 * Deterministic email masking for cross-account pairing prompts
 * (account-only identity refactor, 2026-06-03; CONTRACT §3).
 *
 * Keeps ONLY the first character of the local part and replaces the entire
 * remainder with a fixed literal `***` (three stars regardless of length, so
 * the local-part length is never leaked). Domain is kept verbatim. The raw
 * email is never sent to the client.
 *
 * Test vectors:
 *   laurentliu0918@gmail.com → l***@gmail.com
 *   kris@slock.dev           → k***@slock.dev
 *   a@b.com                  → a***@b.com
 */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    if (at < 0) {
        // Should never happen (User.email is a validated address). Mask whole.
        return (email[0] ?? '') + '***';
    }
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const first = local.length > 0 ? local[0] : '';
    return `${first}***@${domain}`;
}
