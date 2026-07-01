/**
 * splitMentions — partition a raw `mentions` array (as sent by clients) into:
 *   - agentMentions: uuid-shaped ids → ControlAgent.id, stored in control_messages.mentions (uuid[])
 *   - userMentions:  everything else → assumed to be cuid User.id, stored in user_mentions (text[])
 *
 * Why: the live `mentions` Postgres column is uuid[] and can ONLY hold agent ids.
 * Real-person mentions use cuid user ids and must be routed to the text[] column.
 * Clients send ONE flat `mentions` array of opaque ids; the server classifies by shape.
 *
 * A cuid looks like "clx2k9...", a uuid like "550e8400-e29b-41d4-a716-446655440000".
 * Anything not uuid-shaped is treated as a human (cuid) mention. This is intentionally
 * permissive — a malformed id simply lands in user_mentions where it matches nothing.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function splitMentions(raw: unknown): { agentMentions: string[]; userMentions: string[] } {
  if (!Array.isArray(raw)) return { agentMentions: [], userMentions: [] };
  const agentMentions: string[] = [];
  const userMentions: string[] = [];
  for (const m of raw) {
    if (typeof m !== 'string' || m.length === 0) continue;
    if (UUID_RE.test(m)) agentMentions.push(m);
    else userMentions.push(m);
  }
  // Dedupe while preserving order.
  return {
    agentMentions: [...new Set(agentMentions)],
    userMentions: [...new Set(userMentions)],
  };
}
