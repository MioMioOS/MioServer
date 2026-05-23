# MioServer S1 Implementation Plan — 频道 + 消息 + 手机实时鉴权

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans. Steps use checkbox (`- [ ]`). 实现者**必读对应源文件**按既有模式填 TS（本 plan 给确定部分的完整代码 + route/auth 的精确规格 + 引用 file:line）。

**Goal:** 在 MioServer `/api/v1` 上新增真频道（ControlChannel）+ 消息读写 API + message 实时广播 + 手机可订阅 WS，让 CodeLight Slock 前端聊天接 Live。

**Architecture:** Fastify + Prisma(PostgreSQL)。复用现有模式：`publishControlEvent`/`workroomBroadcaster` 写后广播、`authorizeControlRead` 双读、`authorizeOperatorWrite` 写鉴权。新增 per-channel seq、ControlChannel/Member 表、消息路由、WS 多类鉴权。

**Tech Stack:** TypeScript / Fastify / Prisma / PostgreSQL；测试 `npm test`(单元) + `npm run test:integration`(集成)，DB `npm run test:db:setup`。

**Spec:** `docs/slock-s1-channels-messages-spec-2026-05-23.md`（双轮 review 过）。

**⚠️ 执行约束**：分支 `feat/server-control-plane`（有现存未提交改动，**勿碰**，只 stage 本 plan 各 task 指定文件，**不要 `git add -A`**）。每 chunk 完成过 `plan-document-reviewer` 再下一块。

---

## File Structure

- Modify `prisma/schema.prisma` — 加 `ControlChannel`、`ControlChannelMember`；`ControlMessage` 加 `channelId`、`seq`、`clientIdempotencyKey`。
- New Prisma migration（`npx prisma migrate dev --name s1_channels_messages`）+ 数据回填脚本。
- New `sources/control/channels/channelRoutes.ts` — `GET /workrooms/:wid/channels`（真表，取代合成 main）。
- New `sources/control/messages/messageRoutes.ts` — `GET …/channels/:cid/messages`、`POST …/channels/:cid/messages`、`GET /messages/:id`。
- New `sources/control/messages/sendMessageTransaction.ts` — 发消息写事务（per-channel seq + 幂等 + 写库），供 route 调。
- New `sources/control/messages/channelSeq.ts` — per-channel 单调 seq 分配（FOR UPDATE + UNIQUE 兜底）。
- New `sources/control/channels/channelVisibility.ts` — 频道可见性判定（public 隐式 / private·dm 显式成员）。
- New `sources/control/auth/workroomScopeForToken.ts` — `(token, workroomId) → bool` 对 machine/dev/op 三类（WS subscribe 用）。
- Modify `sources/control/ws/wsGateway.ts` — subscribe 改通用 `token` 字段 + 多类鉴权 + 调上面 helper。
- Modify `sources/control/devTokens/devTokenAuth.ts` — allowlist 加消息 GET 正则。
- Modify `sources/control/operatorSessions/operatorSessionMint.ts` — `V1_OPERATOR_COMMANDS += 'send_message'`。
- Modify `sources/control/operatorSessions/operatorCommandTransaction.ts` — `OperatorCommandKey` union += `'send_message'`。
- 验证（多半无需改）connection 命令链：`operatorPairingRoutes.ts:97`(`[...V1_OPERATOR_COMMANDS]`)→`mintConnectionCredential`(`connectionCredential.ts:92/122`，调用点 `operatorPairingRoutes.ts:156`)→`connections/access`(`connectionRoutes.ts:60`) 透传——加进 `V1_OPERATOR_COMMANDS` 后自动带上 `send_message`（见 Chunk 4 Step 1.3）。
- Modify `sources/control/workrooms/workroomRoutes.channels.spec.ts` — 更新锁定断言为新 shape。
- Modify `sources/control/ws/wsGateway.spec.ts` — 现有 `machine_token` subscribe 用例迁到新 `token` 字段（Chunk 5）。
- Tests: 各 `*.spec.ts` 同目录 + 集成 spec。
- 实现注意（reviewer 提醒）：`wsGateway` 的 `disconnect` handler 应调 `unsubscribeAll`（plan 声称"断开清理"，实现前确认该清理段存在）；迁移前 `npx prisma validate` 兜底 `@db.Uuid`。

---

## Chunk 1: Schema + 迁移

**Files:** Modify `prisma/schema.prisma`；New migration。

- [ ] **Step 1: 加模型/字段到 `schema.prisma`**（紧邻现有 ControlMessage/ControlWorkroom，复用其命名风格 + `@@map`/`@map` 蛇形）

⚠️ **所有 uuid 主键/外键必须带 `@db.Uuid`**（现有 schema 全部如此，如 `ControlWorkroom.id`/`ControlMessage.id` `schema.prisma:328,410`；漏了会 text→uuid 外键不匹配、迁移失败）。`createdBy`/`memberId` 是 opaque actor id（可为 'system'/operatorSubject），保持普通 `String`。

```prisma
model ControlChannel {
  id             String   @id @default(uuid()) @db.Uuid
  workroomId     String   @map("workroom_id") @db.Uuid
  name           String
  type           String   // "main" | "standard" | "dm"
  visibility     String   // "public" | "private"
  description    String?
  createdBy      String   @map("created_by")          // opaque actor id（非 uuid 列）
  archivedAt     DateTime? @map("archived_at")
  createdAt      DateTime @default(now()) @map("created_at")
  lastActivityAt DateTime? @map("last_activity_at")
  workroom       ControlWorkroom @relation(fields: [workroomId], references: [id])
  members        ControlChannelMember[]
  messages       ControlMessage[]
  @@index([workroomId, archivedAt])
  @@index([workroomId, type])
  @@map("control_channels")
}

model ControlChannelMember {
  id        String   @id @default(uuid()) @db.Uuid
  channelId String   @map("channel_id") @db.Uuid
  memberId  String   @map("member_id")                // opaque actor id（agent/human/operatorSubject）
  addedAt   DateTime @default(now()) @map("added_at")
  channel   ControlChannel @relation(fields: [channelId], references: [id])
  @@unique([channelId, memberId])
  @@map("control_channel_members")
}
```

并在 `ControlMessage` 加：
```prisma
  channelId            String  @map("channel_id") @db.Uuid   // 迁移期先 String? @db.Uuid 再收紧（见 Step 3-4）
  seq                  BigInt  @default(0)                    // per-channel 单调；nextChannelSeq 每次显式赋值，默认 0 从不被依赖
  clientIdempotencyKey String? @map("client_idempotency_key")
  channel              ControlChannel @relation(fields: [channelId], references: [id])
  @@unique([channelId, seq])
  @@unique([channelId, clientIdempotencyKey])   // nullable：Postgres NULL 互不相等 → 无 key 的 machine 消息不冲突（见 Chunk 4）
```
（`ControlWorkroom` 加反向关系 `channels ControlChannel[]`。）

- [ ] **Step 2: 生成迁移（channelId 先可空）** — 把 `ControlMessage.channelId` 暂设 `String?`，`npx prisma migrate dev --name s1_channels_messages`。Expected: 迁移文件生成、表/列建好。

- [ ] **Step 3: 回填脚本** — New `prisma/backfill/s1_main_channels.ts`：对每个 `ControlWorkroom` 建一条 `ControlChannel{type:'main',visibility:'public',name:workroom.name,createdBy:'system', lastActivityAt: max(该 workroom 消息 createdAt) ?? workroom.createdAt}`（**必须 set lastActivityAt**，否则频道列表排序/Chunk2 取值缺失），再把该 workroom 所有 `ControlMessage.channelId` set 为它；给每条消息按 createdAt 升序回填 `seq`(1..n)。运行后验证无 channelId 为 null。

- [ ] **Step 4: 收紧 NOT NULL** — 把 `channelId` 改回 `String`（非空），再生成迁移 `s1_channelid_notnull`。Expected: 迁移通过（回填后无 null）。

- [ ] **Step 5: 测试** — New `sources/control/channels/schema.spec.ts`（或集成）：建 workroom→应有 main 频道；旧消息 channelId 已回填；`UNIQUE(channelId,seq)` 与 `UNIQUE(channelId,clientIdempotencyKey)` 生效（重复插入报错）。Run `npm run test:integration`。Expected: PASS。

- [ ] **Step 6: Commit**
```bash
git add prisma/schema.prisma prisma/migrations prisma/backfill/s1_main_channels.ts sources/control/channels/schema.spec.ts
git commit -m "feat(s1): ControlChannel/Member schema + ControlMessage channelId/seq + backfill"
```

---

## Chunk 2: 频道真列表（契约变更 + 更新锁定测试）

**Files:** New `sources/control/channels/channelRoutes.ts`、`channelVisibility.ts`；Modify `workroomRoutes.ts`(摘除合成 main)、`workroomRoutes.channels.spec.ts`(更新断言)。
**规格（implementer 按 `workroomRoutes.ts:181-243` 现有合成实现 + `authorizeControlRead`(`devTokenAuth.ts:139`) 模式填 TS）：**

- [ ] **Step 1: 更新锁定测试为新 shape（先红）** — 改 `workroomRoutes.channels.spec.ts:73-83`：断言 `id` 为 uuid（非 'main'）、含 `visibility`/`member_count`、**保留 `attention_count`**。Run → 现实现 FAIL。
- [ ] **Step 2: `channelVisibility.ts`** — `visibleChannels(viewer, workroomId)`：public 全返回；private/dm 仅 viewer 是 `ControlChannelMember`（viewer = machine / dev_ctl_ / op_sess_ operatorSubject）。
- [ ] **Step 3: `channelRoutes.ts` GET** — `GET /api/v1/workrooms/:wid/channels` 双读（`authorizeControlRead`）→ `visibleChannels` → 每条算 `last_activity_at`、`unread_count:0`、`attention_count`(沿用现算法：needs_human actions + pending approvals，按频道)、`member_count`。返回 §4.1 shape。移除 workroomRoutes 里的合成实现，路由改挂此文件。
- [ ] **Step 4: 测试转绿 + 补**：public/private 可见性、归档过滤、attention_count 正确、dev_ctl_ 越权 private 不可见。`npm run test:integration` PASS。
- [ ] **Step 5: Commit** `feat(s1): real channels list endpoint (contract change)`

---

## Chunk 3: 消息读 + per-channel seq

**Files:** New `messages/messageRoutes.ts`(GET 部分)、`messages/channelSeq.ts`；tests。
**规格（分页复用事件 catch-up 风格 `eventRoutes.ts`；seq 复用 FOR UPDATE 思路 `publishControlEvent.ts:77-81` 但作用到 channel）：**

- [ ] **Step 1（红）**：`messageRoutes.read.spec.ts` — 列表 after_seq/limit 升序、has_more；私有非成员 404；`GET /messages/:id` 双读 + 可见性。
- [ ] **Step 2:** `channelSeq.ts` — `nextChannelSeq(tx, channelId)`：`SELECT id FROM control_channels WHERE id=${channelId}::uuid FOR UPDATE` + `COALESCE(MAX(seq),0)+1 FROM control_messages WHERE channel_id=${channelId}::uuid`（**raw query 必须 `::uuid` 转型**，同 `publishControlEvent.ts:80`）；`UNIQUE(channelId,seq)` 兜底。
- [ ] **Step 3:** `GET /api/v1/workrooms/:wid/channels/:cid/messages?after_seq=&limit=`（≤100）+ `GET /api/v1/messages/:id`，双读 + `channelVisibility`，返回 §4.2 shape（含 sender_display_name 解析、embedded_card_type/id）。
- [ ] **Step 4（绿）** + 边界（私有 404、limit 上限）。`npm run test:integration` PASS。
- [ ] **Step 5: Commit** `feat(s1): message read endpoints + per-channel seq`

---

## Chunk 4: 消息写（authorizeOperatorWrite + 新事务 + 幂等 + 广播）+ operator 命令

**Files:** New `messages/sendMessageTransaction.ts`、`messageRoutes.ts`(POST)；Modify `operatorSessionMint.ts`、`operatorCommandTransaction.ts`、连接铸 token 处；tests。
**规格（鉴权用 `authorizeOperatorWrite`(`operatorSessionAuth.ts:89`)；广播用 `publishAndBroadcast` 模板 `actionRoutes.ts:74`；**不**用 `executeOperatorCommand`）：**

- [ ] **Step 1: operator 命令三处改动** — (1) `operatorSessionMint.ts:28/79` `V1_OPERATOR_COMMANDS += 'send_message'`（fail-closed 校验在 `:83-87`）；(2) `operatorCommandTransaction.ts:46` `OperatorCommandKey` union += `'send_message'`；(3) **多数情况下自动生效，只需验证**：pairing 创建处 `operatorPairingRoutes.ts:97` 用 `allowedCommands:[...V1_OPERATOR_COMMANDS]` 整体展开 → credential 创建 `mintConnectionCredential`(`connectionCredential.ts:92/122`，调用点 `operatorPairingRoutes.ts:156`) → `connections/access`(`connectionRoutes.ts:60`) 透传 → `mintOperatorSession`。所以 (1) 加进 `V1_OPERATOR_COMMANDS` 后，整条链**自动带上 `send_message`**。本子任务 = **验证**该链路 + 排查是否有别处硬编码了更窄的命令集（若有则补）。测试：含 send_message 的 mint 不再 fail-closed 拒绝。
- [ ] **Step 2（红）**：`messageRoutes.write.spec.ts` — op_sess_ 发通、machine 发通、dev_ctl_ 硬拒(403)、private 非成员 403、幂等重放返回既有、缺 idempotency key 400。
- [ ] **Step 3:** `sendMessageTransaction.ts` — 事务：校验频道成员 → `nextChannelSeq` → 写 `ControlMessage`（含 clientIdempotencyKey；P2002 幂等返回既有）→ 返回。**幂等语义**：op_sess_ 路径**必须**带 `client_idempotency_key`（缺 → 400，Step 2 测）；machine 路径可省（无 key → `@@unique([channelId,clientIdempotencyKey])` 因 NULL 互不相等而不冲突，符合预期）。
- [ ] **Step 4:** `POST …/channels/:cid/messages` route — 鉴权分支：`authorizeOperatorWrite(req,{command:'send_message',workroomId})` OR `verifyMachineToken`；dev_ctl_ 拒。调 `sendMessageTransaction` → **post-commit** `publishAndBroadcast({topic:'message.created', payload:{channel_id,message_id,seq,sender_kind,sender_id, preview: redactControlText(content).slice(0,120)}})`。
- [ ] **Step 5（绿）** + 广播 write-before-broadcast 断言（事件先落库）。`npm run test:integration` PASS。
- [ ] **Step 6: Commit** `feat(s1): send message (op_sess_/machine) + idempotency + broadcast`

---

## Chunk 5: WS 手机放行 + workroom-scope helper + allowlist

**Files:** New `auth/workroomScopeForToken.ts`；Modify `ws/wsGateway.ts`、`devTokens/devTokenAuth.ts`；tests。
**规格（wsGateway 现状我已读全：subscribe 硬要 `machine_token` 字段 `wsGateway.ts:58-86`）：**

- [ ] **Step 1: allowlist** — `devTokenAuth.ts:69-76` 加正则 `^/api/v1/workrooms/[^/]+/channels/[^/]+/messages$`、`^/api/v1/messages/[^/]+$`。测试：dev_ctl_ GET 这两类命中、POST 仍拒。
- [ ] **Step 2: `workroomScopeForToken.ts`** — `tokenInWorkroom(token, workroomId): Promise<{ok, mode}|null>`：依次 `verifyMachineToken`(查 org→workroom 归属，复用 `requireMachineAccessToWorkroom` 逻辑)、`verifyDevControlToken`(token.workroomId === wid)、`verifyOperatorSession`(session.workroomId === wid)。任一命中返回，否则 null。
- [ ] **Step 3（红 + 迁移现有锁定测试）**：⚠️ 线协议改字段会破现有用例——`wsGateway.spec.ts` 现有 subscribe 测试用 `machine_token` 字段（如 `:117` 的 MISSING_FIELDS、`:149` 的跨 org FORBIDDEN）。**必须把这些既有用例迁到新 `token` 字段**（否则会错误命中 MISSING_FIELDS），同 Chunk 2 的契约-锁定测试更新纪律。再新增：dev_ctl_ 订阅通、op_sess_ 订阅通、machine 通、非法/过期拒+断开、跨 workroom 拒、缺 `token`/`workroom_id` → MISSING_FIELDS。
- [ ] **Step 4: 改 `wsGateway.ts`** — subscribe 消息体 `{type,workroom_id,token}`（弃 `machine_token` 专用字段；`MISSING_FIELDS` 判 `workroom_id`+`token`）；`tokenInWorkroom(token, workroom_id)` 成功 → `workroomBroadcaster.subscribe`，失败 → error+disconnect。保持不变式（仅鉴权后订阅、断开清理、无 DB 写）。
- [ ] **Step 5（绿）** `npm run test:integration` + 相关单测 PASS。
- [ ] **Step 6: Commit** `feat(s1): phone WS auth (dev/op tokens) + workroom-scope helper + allowlist`

---

## 验收（S1 整体）

- `npm run build` 通过；`npm test` + `npm run test:integration` 全绿。
- 手机用 `conn_`→`dev_ctl_`/`op_sess_`：列真频道、按频道分页拉消息、发消息(op_sess_)、订 WS 收 `message.created` 实时。
- 迁移后旧消息可读；channels 锁定测试更新通过；私有/跨 workroom 隔离；无敏感泄露。
- 前端 `MockMessageRepository`/`MockChannelRepository`→Live 版后 #slockai 端到端通（前端零 UI 改动）。

## 执行交接
- 每 chunk 过 `plan-document-reviewer` 再下一块。
- 任何 DB 迁移在 test DB 先验（`npm run test:db:setup`）。
- 只 stage 各 task 指定文件，勿 `git add -A`，勿碰 feat 分支现存改动。
