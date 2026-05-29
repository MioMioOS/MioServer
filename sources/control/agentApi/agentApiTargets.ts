/**
 * agentApiTargets — shared target resolver for /internal/agent-api/* endpoints.
 *
 * Resolves a `#channel-name` target string to a concrete (channelId, workroomId) pair,
 * using membership-anchored lookup so agents can only target channels they belong to.
 *
 * Slice 1 supports ONLY `#channel-name` targets:
 *   - `dm:@peer` and thread suffixes (`#c:abcd1234`) are out of scope → 400 TARGET_UNSUPPORTED.
 *   - Resolution is membership-anchored: a channel matches iff the agent has a
 *     ControlChannelMember row for it (regardless of the channel's visibility).
 *   - 0 matching channels  → 404 NOT_A_MEMBER
 *   - >1 matching channels → 409 AMBIGUOUS_CHANNEL
 *
 * Re-used by Task 1.3 (history route).
 */

import { db } from '@/storage/db';

// ── Result types ──────────────────────────────────────────────────────────────

export type ResolveTargetSuccess = {
  ok: true;
  channelId: string;
  workroomId: string;
};

export type ResolveTargetFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type ResolveTargetResult = ResolveTargetSuccess | ResolveTargetFailure;

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolve a `#channel-name` target to (channelId, workroomId) for the given agent.
 *
 * Only `#<name>` (no colon suffixes, no `dm:` prefix) is accepted in slice 1.
 * Resolution is membership-anchored: we find all ControlChannelMember rows where
 *   - memberId = agentId
 *   - channel.name = <name>
 *
 * 0 matches → { ok: false, status: 404, code: 'NOT_A_MEMBER' }
 * >1 matches → { ok: false, status: 409, code: 'AMBIGUOUS_CHANNEL' }
 * 1 match    → { ok: true, channelId, workroomId }
 */
export async function resolveAgentChannelTarget(
  target: string,
  agentId: string,
): Promise<ResolveTargetResult> {
  // Only `#<name>` is supported. Reject anything with a colon (thread suffix `#c:...`)
  // and anything starting with `dm:` or any other non-`#` prefix.
  const CHANNEL_RE = /^#[^:]+$/;
  if (!CHANNEL_RE.test(target)) {
    return {
      ok: false,
      status: 400,
      code: 'TARGET_UNSUPPORTED',
      message: 'Only #channel-name targets are supported in this version',
    };
  }

  const channelName = target.slice(1); // strip leading `#`

  // Membership-anchored lookup: find ControlChannelMember rows where the agent is a
  // member and the channel has the requested name. Include the channel to get workroomId.
  const members = await db.controlChannelMember.findMany({
    where: {
      memberId: agentId,
      channel: { name: channelName },
    },
    select: {
      channelId: true,
      channel: { select: { workroomId: true } },
    },
  });

  if (members.length === 0) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_A_MEMBER',
      message: 'Agent is not a member of any channel with that name',
    };
  }

  if (members.length > 1) {
    return {
      ok: false,
      status: 409,
      code: 'AMBIGUOUS_CHANNEL',
      message: 'Agent is a member of multiple channels with that name',
    };
  }

  const { channelId, channel } = members[0];
  return {
    ok: true,
    channelId,
    workroomId: channel.workroomId,
  };
}
