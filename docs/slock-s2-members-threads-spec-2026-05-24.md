# Slock S2 — Members/Agents + Threads Spec

- Date: 2026-05-24
- Status: Draft (autonomous brainstorm; locked decisions below; pending spec-review loop)
- Owner: Laurent (ying)
- Branch: `feat/server-control-plane` (MioServer), `main` (CodeLight)
- 关联：延续 S1（频道+消息+实时，已上线）。让 **Members tab** 和 **消息 Threads** 从 mock 变真。延续 [[project-codelight-slock-pivot]]。

## 0. 目标
两件事，共用 S1 已建的全部基础设施（auth 双令牌、`publishControlEvent`+`workroomBroadcaster`、Prisma 迁移目录、co-located `*.spec.ts`、iOS `hybridLive`）：
- **A. Members/Agents**：让"你的 AI 同事团队"在 Members tab 真实显示（名字/角色/在线状态），并**顺带修掉发送人显示为 UUID 的 bug**（agent 消息 `sender_display_name=null`）。
- **B. Threads**：让消息线程（回复链 / 任务即线程）真实工作——读父消息、读回复列表、发回复。

Schema 几乎齐备（`ControlAgent`/`ControlThread`/`ControlChannelMember`/`ControlMessage.threadReplyCount` 已存在）。S2 主要是**补端点 + 补两处缺口 + 接 iOS Live**。

## 1. 锁定的设计决策
1. **一个 S2 spec，两个可独立交付的半部**：先 Members（价值高 + 修 UUID 名字 bug），后 Threads。Plan 里分成独立 chunk，各自可测可提交。
2. **Agent 行在 machine `bind-org` 时创建**：注册不建（注册时还没 org）；bind-org 时建一条 `ControlAgent`（`machineId` FK、`orgId`、`displayName` 取自 machine 或默认、`name` 同、`role` 默认 `"other"`、`status="online"`）。**幂等**：`ControlAgent.machineId` 现无 `@unique`，故新增 `@@unique([orgId, machineId])`（见 §3），用 `findFirst({orgId,machineId})` 不存在才 `create`（或基于新 unique 的 upsert）；避免并发 bind 建重复行。该 unique 也为 §1.3 的 machineId 解析提供索引。
3. **发送人名字解析改成并集（additive，不替换）**：agent 消息 `senderId` 可能 = `ControlAgent.id`（agent 用自身 id 发，S1 锁定测试如此）**或** = `machine.id`（daemon 发，现解析不到→null）。故 `resolveSenderDisplayNames` 对 agent-kind sender 解析 `ControlAgent WHERE id IN(senderIds) OR machineId IN(senderIds)`，取匹配者。**保留** id 分支（S1 `messageRoutes.read.integration.spec.ts` 断言 `senderId==ControlAgent.id` 解析出名字，不能破），**新增** machineId 分支（修 daemon 发的 UUID 名字 bug）。id 分支仍需 uuid-shape 过滤（保 S1 P2023 修复）；machineId 列是 text，安全。
4. **回复用 `ControlMessage.parentMessageId`（新增可空列）**：`null`=顶层消息，非空=某父消息的回复。回复和顶层消息同表、共享频道 `seq` 空间。
5. **主频道消息列表排除回复**：`GET channel messages` 加 `WHERE parent_message_id IS NULL`（Slack 行为：回复只在线程里，不刷主时间线）。迁移安全：存量行 `parent_message_id` 为 null → 全部照常显示。agent 当前在主频道的回复是顶层（parentMessageId null），不受影响。
6. **Members = agents（本期）**：live members 端点返回 org 的 `ControlAgent`。humans 无独立表（human=operator subject `pairing:<uuid>`，无显示名），故 humans 本期为空（见 §8 范围外）。Members tab 的核心价值=看 AI 团队，本期满足。
7. **线程无 WS 实时（本期）**：iOS `ThreadRepository` 协议无 stream 方法，线程用"打开即拉"。但发回复仍 `publishControlEvent`（write-before-broadcast 一致性 + 为将来 live 线程 / 主列表 thread_reply_count 实时更新留口）。
8. **复用 S1 auth**：读=`authorizeControlRead`（machine_token / dev_ctl_）；写=`authorizeOperatorWrite`（op_sess_ `send_message` 命令）+ machine_token。dev_ctl_ 对写硬 403。新 GET 路径加入 dev_ctl_ allowlist。

## 2. 范围
**In scope（A. Members）**：
- schema：`ControlAgent` 加 `@@unique([orgId, machineId])`（幂等建行 + 解析索引）。
- machine bind-org 时建 ControlAgent（findFirst-then-create）+ 存量 backfill 脚本。
- `resolveSenderDisplayNames` 改成 id∪machineId 并集解析（修名字，保 S1 测试）。
- `GET /api/v1/workrooms/:wid/members`（新模块 `memberRoutes.ts`，**须在 `sources/api.ts` 注册**）。
- dev_ctl_ allowlist + workroom scope。
- iOS `LiveMemberRepository` + `hybridLive` 接入 + 测试。

**In scope（B. Threads）**：
- schema：`ControlMessage.parentMessageId` 可空列（无 FK，见 §3）+ 迁移；`SendMessageInput`/insert 加可选 `parentMessageId`。
- `GET channel messages` 加 `parent_message_id IS NULL` 过滤。
- thread 路由（折进现有已注册的 `messageRoutes.ts`，复用 `sendMessageTransaction`/`formatMessage`/`resolveSenderDisplayNames`）：`GET /api/v1/workrooms/:wid/threads/:parentId`、`GET …/replies`、`POST …/reply`。
- 回复事务：经**扩展后的 `sendMessageTransaction`**（同 seq 分配 + `(channelId, clientIdempotencyKey)` 幂等 + P2002 重放路径）建回复消息，**同事务内** upsert ControlThread + bump 父 threadReplyCount/lastThreadReplyAt；提交后 publish `thread.reply` event。
- dev_ctl_ allowlist + op_sess_ 命令复用 `send_message`（已是 V1 命令，无需改 allow-list）。
- iOS `LiveThreadRepository` + `hybridLive` 接入 + 测试。

**In scope（C. 修 POST 响应形状，解锁 iOS 写路径）**：
- S1 的 `POST …/messages` 与 S2 的 `POST …/reply` **均返回完整 message wire shape**（`formatMessage` 输出）+ `idempotent` 标志，取代原 `{id,seq,created_at,idempotent}` 瘦响应。原因：iOS `LiveMessageRepository.send`/`LiveThreadRepository.reply` 必须返回完整 `Message`，而把瘦响应解码进非可选字段的 `MessageDTO` 会抛 `DecodingError`→被吞成 `.offline`→VM 回滚乐观消息（即"手机发送"腿一直没真跑通的根因）。瘦响应的现有读者（CLI demo 脚本、server 测试）只用 `id`/`seq`，完整形状向后兼容。
- iOS `LiveMessageRepository.send` 与 `LiveThreadRepository.reply` 映射完整形状→`Message`。

**Out of scope（→ 后续）**：见 §8。

## 3. Schema 变更
两处：(1) `ControlMessage` 加可空 `parentMessageId`，(2) `ControlAgent` 加 `@@unique([orgId, machineId])`。

```prisma
model ControlMessage {
  // … 现有字段 …
  parentMessageId String?  @map("parent_message_id") @db.Uuid   // 新增：null=顶层，非空=回复
  @@index([parentMessageId])                                    // 按父查回复
}

model ControlAgent {
  // … 现有字段（machineId String? @map("machine_id") 已存在，text，非 @db.Uuid）…
  @@unique([orgId, machineId])   // 新增：machineId org 内唯一 → 幂等建行 + 给 §1.3 machineId 解析提供索引
}
```

迁移 `YYYYMMDDHHMMSS_s2_message_parent_and_agent_machine_unique`：
```sql
ALTER TABLE "control_messages" ADD COLUMN "parent_message_id" uuid;
CREATE INDEX "control_messages_parent_message_id_idx" ON "control_messages"("parent_message_id");
-- machineId 可空：部分唯一索引仅约束非空行（多个 machineId=NULL 的 agent 不冲突）
CREATE UNIQUE INDEX "control_agents_org_id_machine_id_key"
  ON "control_agents"("org_id","machine_id") WHERE "machine_id" IS NOT NULL;
```
- 存量行 `parent_message_id` 默认 NULL（安全，无需回填）。
- `parent_message_id` **无 FK**（沿用控制面"自引用不建 Prisma relation"惯例）；父消息被删会留孤儿回复——S2 范围外（控制面目前无删消息路径）。
- 部分唯一索引（`WHERE machine_id IS NOT NULL`）避免约束到无 machineId 的 agent 行。

**`SendMessageInput` 扩展**（`sendMessageTransaction.ts`）：加可选 `parentMessageId?: string`，insert 写入该列。其余（seq 分配、`(channelId, clientIdempotencyKey)` 幂等、P2002 重放）不变——回复因此与主消息走完全相同的并发安全路径。

**ControlAgent backfill**（脚本 `prisma/backfill/s2_agents_for_bound_machines.ts`）：对每个 `boundAt IS NOT NULL` 且 `orgId` 非空、且无对应 ControlAgent 的 ControlMachine，建一条 ControlAgent（`machineId=machine.id`、`orgId=machine.orgId`、`displayName=machine.displayName ?? "Agent"`、`name` 同、`role="other"`、`status="online"`）。幂等：靠新 `@@unique([orgId, machineId])` + `findFirst` 守卫。

## 4. API
所有路径前缀 `/api/v1`。错误体沿用 S1 `{ error: { code, message } }`。

### 4.1 GET /workrooms/:wid/members
- Auth：`authorizeControlRead`（machine_token 或 dev_ctl_，workroom scope）。machine path 另跑 `requireMachineAccessToWorkroom`（跨 org 的 machine → 403）；dev path 靠 `authorizeControlRead` 的 `devTokenInWorkroomScope`（wid≠token.workroomId → 403）。
- **org 推导**：从 `:wid` 查 `ControlWorkroom.orgId`，返回 `ControlAgent WHERE orgId = thatOrg`（不直接信 token 的 orgId，统一从 workroom 推）。
- 返回：
```json
{ "members": [
  { "id": "<agent uuid>", "kind": "agent", "display_name": "Mio",
    "role": "ops", "status": "online", "machine_id": "<uuid>" }
] }
```
- 排序：status online 优先，再按 display_name。humans 本期不含（空）。
- dev_ctl_ allowlist 新增 `^/api/v1/workrooms/[^/]+/members$`。

### 4.2 GET /workrooms/:wid/threads/:parentId
- Auth：`authorizeControlRead`。404 若父消息不存在或父所在频道对调用方不可见（复用频道可见性）。
- 返回线程元信息（无 ControlThread 行则派生 reply_count=0）：
```json
{ "id": "<parentId>", "parent_message_id": "<parentId>",
  "reply_count": 3, "last_reply_at": "ISO|null", "task_id": null }
```
（`task_id` 预留，S3 任务即线程时填；本期恒 null。）

### 4.3 GET /workrooms/:wid/threads/:parentId/replies
- Query：`after_seq=<n>`（默认 0）、`limit<=100`（默认 100）。
- Auth：`authorizeControlRead`。
- 返回回复消息（同 S1 message wire shape，含 `parent_message_id`）：
```json
{ "parent_message_id": "<parentId>", "messages": [ /* Message DTO */ ], "has_more": false }
```
- 查询：`ControlMessage WHERE parentMessageId=:parentId AND seq>:after_seq ORDER BY seq ASC LIMIT :limit`。`has_more` 用 `take: limit+1` 同 S1。
- dev_ctl_ allowlist 新增两条：`^/api/v1/workrooms/[^/]+/threads/[^/]+/replies$` 和 `^/api/v1/workrooms/[^/]+/threads/[^/]+$`。（`/messages/:id`（4.2 的 parentMessage(id) 复用）**S1 已在 allowlist**，无需再加。）

### 4.4 POST /workrooms/:wid/threads/:parentId/reply
- Auth：op_sess_（command `send_message`）或 machine_token；dev_ctl_ → 403。
- Body：`{ content: string, client_idempotency_key: string(op_sess_必填), mentions?: string[] }`。
- 派生 sender：op_sess_→`{kind:'user', id:operatorSubjectId}`；machine→`{kind:'agent', id:machine.id}`（同 S1 messageRoutes）。
- 事务（**单 DB `$transaction` 内**，经扩展后的 `sendMessageTransaction`）：
  1. 校验父消息存在、取其 `channelId`（父不存在 → 404）。
  2. 建回复 `ControlMessage`（`channelId=父channelId`、`parentMessageId=parentId`、`nextChannelSeq` 分配 seq[该调用对频道行 `FOR UPDATE`，天然串行化并发首回复]、`senderKind/senderId`、`clientIdempotencyKey`）。`(channelId, clientIdempotencyKey)` 冲突→返回既有行（idempotent:true，走 S1 P2002 重放路径）。
  3. **同事务内** upsert `ControlThread`（`parentMessageId` @unique）：
     - create 分支：`{ parentMessageId, workroomId, replyCount: 1, lastReplyAt: now }`（注意 create 是 `replyCount:1`，不是 increment）。
     - update 分支：`{ replyCount: { increment: 1 }, lastReplyAt: now }`。
     - 因步骤 2 已对频道行 `FOR UPDATE`，同一父的并发首回复被串行化，不会双双 create 撞 P2002。
  4. 同事务内父 `ControlMessage`：`{ threadReplyCount: { increment: 1 }, lastThreadReplyAt: now }`。
- 提交后 `publishControlEvent`（topic `thread.reply`，payload `{channel_id, parent_message_id, message_id, seq, sender_kind, sender_id, preview}`）+ `workroomBroadcaster.broadcast`（write-before-broadcast；幂等命中不广播）。
- 返回：**完整 message wire shape**（`formatMessage` 输出，含 `parent_message_id`）+ `idempotent`（见 §2 In scope C）。

## 5. 实时
- 仅 `thread.reply` 事件（4.4）。iOS 本期不消费（线程"打开即拉"），但事件入 journal 并广播，便于将来 live 线程 / 主频道 thread_reply_count 实时更新。
- 主频道 `message.created` 行为不变（顶层消息）。

## 6. iOS Live 接线
- **`LiveMemberRepository`**（`Slock/Live/`）：
  - `members(workspaceId)` → `GET /workrooms/:wid/members` → map `MemberDTO`→`Member(kind:.agent, displayName, roleDescription:role, runtime: 见下映射)`。
  - **status→`AgentRuntimeState` 映射（该 enum 只有 .online/.working/.paused，无 .offline）**：`online→.online`、`busy→.working`、`drain|offline→.paused`、**default→.paused**。本期服务端只写 `online`，但映射须全覆盖+有 default，不留半截（presence 落地后即生效）。
  - `member(id)` → 从 members 过滤（MVP）。
  - 走 `api.get`（devToken）。错误映射同其它 Live repo。
- **`LiveThreadRepository`**（`Slock/Live/`）：
  - `thread(parentMessageId)` → `GET …/threads/:parentId` → `ThreadConversation`。
  - `parentMessage(id)` → `GET /messages/:id`（复用 S1；已在 dev_ctl_ allowlist）。
  - `replies(threadId)` → `GET …/threads/:threadId/replies` → `[Message]`（map 同 `LiveMessageRepository.mapDTO`，含 senderDisplayName）。
  - `reply(threadId, body)` → `POST …/threads/:threadId/reply`（opToken + idempotency key）→ map **完整 wire shape**→`Message`（依赖 §2 In scope C；否则瘦响应解码崩）。
- **`LiveMessageRepository.send`**：同步改为 map 完整 wire shape→`Message`（§2 In scope C，修"手机发送"腿）。
- **`hybridLive`**（`LiveConfig.swift`）：`members` 和 `threads` 换成上面两个 Live 实现（其余不变）。
- 不改 `Member`/`ThreadConversation`/`Message`/`AgentRuntimeState` 模型（字段够；`Message.senderDisplayName` 已加）。

## 7. 测试
**MioServer**（co-located `*.spec.ts`，复用 S1 测试夹具/auth stub/test DB）：
- members 路由：agent 列表映射、org 从 wid 推导、auth（machine 通过 + 跨 org machine 403、dev_ctl_ 通过 + 越 workroom 403）、dev_ctl_ allowlist。
- bind-org：建 ControlAgent（幂等：重复 bind 不重复建，靠 `@@unique([orgId,machineId])` + findFirst）。
- resolveSenderDisplayNames（**additive**）：(a) **保留** S1 断言——`senderId==ControlAgent.id` 解析出名字（不能破 `messageRoutes.read.integration.spec.ts`）；(b) **新增**——`senderId==ControlAgent.machineId`（daemon 发）解析出名字；(c) 无任何匹配 → null；(d) 非 uuid senderId 不崩（保 P2023：id 分支仍 uuid-shape 过滤）。
- thread 路由：GET thread（有/无 ControlThread 行→派生 reply_count=0）、GET replies（分页 after_seq + has_more）、POST reply（op_sess_ + machine、幂等键重放、父不存在 404、dev_ctl_ 403）。
- 回复事务：父 threadReplyCount/lastThreadReplyAt + ControlThread.replyCount 同步递增（首回复 create replyCount=1、二次 increment 到 2）；publish thread.reply 事件。
- **POST message/reply 返回完整 wire shape**（含 sender_kind/sender_id/content/parent_message_id），更新 S1 POST 测试对响应形状的断言。
- GET channel messages：排除回复（parentMessageId 非空不出现在主列表）；has_more 在过滤后仍正确。
**CodeLight**（`CodeLightTests/Slock/`，`StubURLProtocol`；动手前先打开现有 `LiveMessageRepositoryTests.swift` 核对 `StubURLProtocol` 夹具签名再仿写）：
- `LiveMemberRepository`：members 映射（kind/role/status→runtime，含 status 全分支 + default）、空列表、401→authExpired、403→空、网络错→offline。
- `LiveThreadRepository`：thread/replies/reply 映射、reply 用 opToken + idempotency、错误映射。
- `LiveMessageRepository.send`（回归 §2-C）：完整 wire-shape POST 响应正确解码成 `Message`（旧瘦响应会崩——加一条断言锁住完整形状）。

## 8. 范围外（→ 后续）
- **humans 成员**：无 humans 表（human=operator subject 无显示名）；Members tab humans 区本期空，待 operator 身份 / S4 DM。
- **真实在线状态**：status 在 bind 时置 online，非心跳驱动；准确 presence（lastSeenAt/心跳）后续。
- **线程 WS 实时推送到 iOS**：本期"打开即拉"；live 线程后续（事件已广播，留口）。
- **任务即线程**（thread.task_id）：S3。
- **频道成员增删 / Stop-all-agents 写操作**：S6 写操作补全。
- **agent 自报名字/角色**：bind 时取 machine.displayName 或默认；agent 自定义资料后续。

## 9. 验收
- 单测全绿（server 新路由各分支 + iOS 两个 Live repo）。
- Live 模拟器：Members tab 显示真实 agent（有名字/角色/在线点），消息发送人显示真名（非 UUID）；打开某消息 thread 看到真实回复、发一条回复后可见。
- dev_ctl_ 只读、op_sess_ 才能发回复；越权/越 workroom 403；父不存在 404。
- 主频道列表不含线程回复；存量数据不受迁移影响。
