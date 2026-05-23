/**
 * Channel visibility filter for GET /workrooms/:wid/channels.
 *
 * VISIBILITY RULES (§4.1):
 *   public  → visible to ALL authenticated viewers for that workroom
 *              (no ControlChannelMember row needed)
 *   private / dm → visible ONLY when the viewer has an explicit ControlChannelMember row
 *
 * "viewer" is the operatorSubject from authorizeControlRead:
 *   machine mode   → machine.id
 *   dev mode       → devToken.id   (dev tokens are workroom-scoped; we trust authorizeControlRead
 *                                    already enforced workroom scope before calling this)
 *   (op_sess_ mode is handled by the read endpoints via authorizeControlRead,
 *    which currently only supports machine + dev; WS subscription is Chunk 5)
 *
 * For S1 the migration only creates main/public channels, so the private branch has no data,
 * but the implementation is correct for when private channels appear (S6).
 */

import { db } from '@/storage/db';
import type { ControlReadAuth } from '@/control/devTokens/devTokenAuth';

/** Prisma ControlChannel row shape (subset we query). */
export interface VisibleChannel {
  id: string;
  name: string;
  type: string;
  visibility: string;
  description: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  workroomId: string;
}

/**
 * Return all non-archived channels visible to the viewer in the given workroom.
 *
 * - public  → all non-archived channels
 * - private/dm → only those where viewer is a ControlChannelMember
 *
 * viewerId: the opaque actor id (machine.id or devToken.id) used to check membership.
 * For machine tokens, machine.id is used; it won't appear in ControlChannelMember rows
 * in S1 (since S6 writes those), so private channels will correctly be invisible to
 * machines unless they have an explicit member row.
 */
export async function visibleChannels(
  auth: ControlReadAuth & { ok: true },
  workroomId: string,
): Promise<VisibleChannel[]> {
  // Derive the viewer id — the opaque subject we check membership for.
  const viewerId = auth.mode === 'machine' ? auth.machine.id : auth.devToken.id;

  // Fetch all non-archived channels for the workroom in a single query.
  // Include members (channelId + memberId) so we can filter private channels in JS
  // without a second round-trip. For workrooms with many channels this is still
  // correct — private channels in S1 don't exist yet, so the payload is tiny.
  const channels = await db.controlChannel.findMany({
    where: {
      workroomId,
      archivedAt: null,
    },
    include: {
      members: {
        where: { memberId: viewerId },
        select: { memberId: true },
      },
    },
    orderBy: { lastActivityAt: 'desc' },
  });

  return channels.filter((ch) => {
    if (ch.visibility === 'public') return true;
    // private or dm: viewer must be an explicit member
    return ch.members.length > 0;
  });
}
