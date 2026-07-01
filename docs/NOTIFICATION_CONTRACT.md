# Notification Contract (Task #121)

Keystone contract for cross-surface notifications. The MioServer backend OWNS this
contract; the mio-agent daemon, MioIsland (macOS), and CodeLight (iOS) clients
conform to it. Implemented in:
- `sources/control/notifications/notify.ts` (APNs payload)
- `sources/control/messages/messageRoutes.ts` (mention plumbing + activity feed)
- `sources/control/tasks/taskRoutes.ts` (task-done trigger)

## 1. Shared deep-link contract

Every push AND every activity-feed item carries enough to deep-link
`workspace → channel → thread → message`.

### APNs custom payload (`data`, sibling of `aps`)

All values are STRINGS (APNs requirement). `threadId` is OMITTED (not null) when absent.

| field        | type   | meaning                                                        |
|--------------|--------|---------------------------------------------------------------|
| `type`       | string | `"mention_ai"` \| `"mention_human"` \| `"task_done"`          |
| `workroomId` | string | workspace id (uuid)                                           |
| `channelId`  | string | channel id (uuid)                                            |
| `messageId`  | string | message to scroll to (uuid)                                  |
| `threadId`   | string | parentMessageId, present only for thread-reply / threaded ctx |
| `title`      | string | notification title (mirrors `aps.alert.title`)              |
| `body`       | string | notification body  (mirrors `aps.alert.body`)              |

The standard `aps` block (`alert.title`, `alert.body`, `sound`, `mutable-content`)
is also present and carries the same title/body.

### Activity-feed item (`GET /api/v1/workrooms/:wid/activity`)

```jsonc
{
  "id": "act_<messageId>",
  "message_id": "<uuid>",
  "handled": false,
  // deep-link fields (snake_case in JSON; same set as the APNs payload):
  "type": "mention_human",          // mention_human | mention_ai
  "workroom_id": "<uuid>",
  "channel_id": "<uuid>",
  "thread_id": null,                // parentMessageId | null
  "title": "You were mentioned",
  "body": "<message preview, ≤200 chars>"
}
```

Note: push payload uses camelCase keys (`workroomId`); the activity JSON uses the
server's snake_case convention (`workroom_id`). Field meanings are identical.

## 2. Mention plumbing (S2)

- Clients send ONE flat `mentions: string[]` array of opaque ids on message/reply create.
- The server classifies by SHAPE (`sources/control/messages/splitMentions.ts`):
  - **uuid** → AI agent (`ControlAgent.id`) → stored in `control_messages.mentions` (`uuid[]`).
  - **non-uuid (cuid)** → human (`User.id`) → stored in `control_messages.user_mentions` (`text[]`, added by migration `20260601000000_s2_human_mentions`).
- Human mentions reach the activity feed: a human viewer's `user.id` is matched against
  `user_mentions`. Agent mentions match `mentions` (machine/agent actors).

## 3. Push triggers (S4)

| trigger          | where (file:func)                                           | recipients                                  | gating                                                        |
|------------------|-------------------------------------------------------------|---------------------------------------------|--------------------------------------------------------------|
| human mention    | `messageRoutes.ts` POST `/messages` + POST `/threads/:id/reply` | mentioned human users' iOS devices          | master switch + staleness ONLY (mentions always notify)      |
| task done        | `taskRoutes.ts` PATCH `/tasks/:id` → `notifyTaskDoneForWorkroom` | all human OWNER members of task's workroom   | master switch + staleness + `notifyOnCompletion`             |

Device resolution: `User.id ──(Device.userId)──▶ Device[] ──(PushToken.deviceId)──▶ APNs token[]`.
`sendPushToDevice()` self-heals dead tokens. Sender is excluded from their own mention push.

Mentions are skipped on idempotent message replay (no double-notify). Task-done fires
only on the first transition INTO `done` (the `TASK_TERMINAL` guard blocks re-updates).

### For the daemon / MioIsland agents

The CURRENT task-done hook is the control-plane `PATCH /api/v1/tasks/:id` status→`done`
transition. If the daemon emits turn/session completion through a DIFFERENT event, hook
`notifyTaskDone()` (or `notifyMentionedUsers()`) from `sources/control/notifications/notify.ts`
at that emission point with a `DeepLinkTarget` (`{ workroomId, channelId, messageId, threadId? }`).

## 4. mark-all-read

`POST /api/v1/workrooms/:wid/activity/read-all` → marks all the caller's currently-matched
mention items in the workroom `handled=true`. Returns `{ ok: true, marked: <count> }`.
Per-message `POST .../activity/:messageId/handled` is unchanged.
