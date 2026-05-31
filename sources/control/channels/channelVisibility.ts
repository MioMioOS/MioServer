/**
 * Channel visibility filter for GET /workrooms/:wid/channels.
 *
 * VISIBILITY RULES (§4.1):
 *   public  → visible to ALL authenticated viewers for that workroom
 *              (no ControlChannelMember row needed)
 *   private / dm → visible ONLY when the viewer has an explicit ControlChannelMember row
 *
 * "viewer" is the opaque actor id passed in by the caller (Slice 7 actor-based callers
 * resolve it via `resolveActor` / `requireUser` / machine_token and pass `{ viewerId }`):
 *   user mode      → user.id
 *   machine mode   → machine.id
 *
 * (Slice 7 B3 removed the legacy `ControlReadAuth` overload — dev_ctl_ tokens no longer
 * exist, and the last machine-only callers were migrated to the `{ viewerId }` overload
 * in B2-a/c/d.)
 *
 * For S1 the migration only creates main/public channels, so the private branch has no data,
 * but the implementation is correct for when private channels appear (S6).
 */

import { db } from '@/storage/db';

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
 * - private/dm → only those where viewer (or one of its owned agents) is a ControlChannelMember
 *
 * `auth.viewerId` is the opaque actor id used to check membership. For user actors this
 * is `user.id`; for machine actors this is `machine.id`. **Slice 7.5 expansion:** when
 * the viewer is a machine, we ALSO consider channels where any agent owned by that
 * machine is a member. Without this, the daemon (auths as machine) can never read
 * messages in channels where its agent is the listed member — even though the daemon
 * is the runtime hosting that agent. Caller passes `viewerKind` so we know whether
 * to expand. Defaults to no expansion (backward-compatible for user callers).
 *
 * S1 migration creates main/public channels only, so the private branch has no data
 * yet; the expansion is correctness for S6+ private channels.
 */
export async function visibleChannels(
  auth: { viewerId: string; viewerKind?: 'user' | 'machine' },
  workroomId: string,
): Promise<VisibleChannel[]> {
  const { viewerId, viewerKind } = auth;

  // Build the set of member-ids that count as "this viewer" for private-channel
  // membership. For a machine viewer, expand to include all agents bound to that
  // machine (control_agents.machine_id = viewerId). For users, just [viewerId].
  let viewerIds: string[];
  if (viewerKind === 'machine') {
    const agents = await db.controlAgent.findMany({
      where: { machineId: viewerId },
      select: { id: true },
    });
    viewerIds = [viewerId, ...agents.map((a) => a.id)];
  } else {
    viewerIds = [viewerId];
  }

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
        where: { memberId: { in: viewerIds } },
        select: { memberId: true },
      },
    },
    orderBy: { lastActivityAt: 'desc' },
  });

  // A non-owner human (a "guest" invited to specific channels) sees ONLY the
  // channels they're explicitly a member of — NOT every public channel in the
  // workspace. Owners (and machine/agent viewers) get the full visibility rules
  // below. This scopes an invited collaborator to exactly the channel(s) they
  // were added to.
  let guestScoped = false;
  if (viewerKind !== 'machine') {
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: viewerId, workroomId } },
      select: { role: true },
    });
    guestScoped = mem != null && mem.role !== 'owner';
  }

  return channels.filter((ch) => {
    if (guestScoped) return ch.members.length > 0; // guest: only their channels
    if (ch.visibility === 'public') return true;
    // private or dm: viewer (or owned agent) must be an explicit member
    return ch.members.length > 0;
  });
}
