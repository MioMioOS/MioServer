# MioServer S1 Spec：频道 + 消息 + 手机实时鉴权

- Date: 2026-05-23
- Status: Draft（superpowers brainstorming 产出，待 review）
- Owner: Laurent (ying)
- 关联：CodeLight Slock 前端（已建 mock-first）接 Live 数据层的服务端第一刀。前置审计见 DevForge codelight 项目 note + `CodeLight/docs/productization/codelight-slock-frontend-spec-2026-05-23.md` §2 后置项。

## 0. 目标

让 CodeLight Slock 前端的**聊天核心**能接真后端：在 MioServer `/api/v1` 上新增**真频道（ControlChannel）+ 消息读写 API + 实时广播 + 手机可订阅的 WS**，并打通手机鉴权（dev_ctl_/op_sess_ 的 WS 放行 + allowlist 扩展）。这是服务端数据层 S1（共 S1–S6，见前端 spec 的分解）。

## 1. 锁定的设计决策（brainstorming 已定）

- **频道 = 新 `ControlChannel` 表**；**workspace = workroom**（一个连接锁单 workspace；多 workspace 切换后置）。
- **消息 / 任务加 `channel_id`**（本 spec 只做消息的 channel_id；任务 channel_id = S3）。
- **DM = `type=dm` 的频道**（实现 = S4；本 spec 仅在 type 枚举里预留）。
- **发消息鉴权 = `op_sess_`（人=operator）新增命令 `send_message`**，经 `authorizeOperatorWrite` + **新消息写事务**（**不**走 action 专用的 `executeOperatorCommand`，详见 §4.3）；machine_token 亦可（agent 经 daemon 发）。
- **成员模型 = `ControlChannelMember` join 表**；public=workroom 成员隐式可见，private/dm=显式成员。
- **任务状态枚举对齐** = S3（本 spec 不动 task）。
- **服务端北极星（增量，2026-05-23 定）**：`/api/v1` 控制面 = **唯一 server**。现 `main.ts` 同进程还挂着遗留 `/v1` 监控栈（`Session`/`SessionMessage` + 加密 challenge/签名鉴权 `auth/crypto.ts` + Socket.IO `/v1/updates`），与控制面是两套平行模型/鉴权/实时。后续 **S7** 子项目把监控并入控制面（统一 connection token、单连接、`Session`→控制面会话），最终下线 `/v1`。**S1 不受影响、方向一致**（本就在控制面上建）。手机过渡期暂用 2 连接（监控走遗留、Slock 走 connection）。

## 2. 范围

### In scope（S1）
- Schema：新增 `ControlChannel`、`ControlChannelMember`；`ControlMessage` 加 `channelId`。
- 迁移：每个现有 workroom 建一条 `main/public` 频道，回填现有消息的 channelId。
- API：消息 `GET 列表（分页）`、`POST 发送`、`GET 单条`；频道 `GET 真列表`（取代合成 main）。
- 实时：发消息 → `message.created` 事件 publishAndBroadcast；**WS gateway 放行 dev_ctl_/op_sess_**。
- 鉴权：dev_ctl_ allowlist 扩展；operator 命令集加 `send_message`；connection access 铸的 op_sess_ 含该命令。

### Out of scope（各自后续 spec）
- 建频道 / 增删成员 / archive（写）= **S6**。
- 成员·agent 列表端点、线程 API = **S2**。
- 任务 channel_id + 状态枚举对齐 + 手机任务写 = **S3**。
- DM（type=dm 的建立与成员）= **S4**。
- Activity 流 / Saved / Search、真实 unread 计数（read cursor）= **S5**。
- 内嵌卡数据去规范化（S1 只回 type+id，客户端用现有 /actions、/approvals、/tasks 解析）。

## 3. Schema

### 3.1 `ControlChannel`（新）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| workroomId | uuid FK→ControlWorkroom | |
| name | string | |
| type | enum `main` `standard` `dm` | dm 留给 S4 |
| visibility | enum `public` `private` | |
| description | string? | |
| createdBy | string | actor id |
| archivedAt | datetime? | |
| createdAt | datetime | |
| lastActivityAt | datetime? | max(消息/活动时间)，列表排序用 |

索引：`(workroomId, archivedAt)`、`(workroomId, type)`。

### 3.2 `ControlChannelMember`（新）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| channelId | uuid FK | |
| memberId | string | agent/human/operatorSubject id |
| addedAt | datetime | |

UNIQUE(channelId, memberId)。**可见性规则**：`public` 频道对该 workroom 全体可见（无需成员行）；`private`/`dm` 频道仅 `ControlChannelMember` 内成员可见。

### 3.3 `ControlMessage`（改）
- 新增 `channelId`(uuid FK→ControlChannel, 迁移期 nullable→回填后 NOT NULL)。
- 其余字段保持：senderKind、senderId、content、mentions、embeddedCardType、embeddedCardId、threadReplyCount、lastThreadReplyAt、createdAt、(新)`seq`（每频道单调，用于分页/catch-up）。⚠️ **per-channel seq 是净新基建**：`publishControlEvent` 的 seq 是 workroom 级（`MAX(seq) … WHERE workroom_id`，`publishControlEvent.ts:77-81`），**不能直接复用**；需为消息建独立的每频道单调计数（FOR UPDATE on channel row + `UNIQUE(channelId, seq)` 兜底）。

### 3.4 迁移
1. 加表 + `ControlMessage.channelId` nullable。
2. 每个 `ControlWorkroom` 建一条 `ControlChannel{type:main, visibility:public, name: workroom.name}`。
3. 回填该 workroom 所有 `ControlMessage.channelId` = 其 main 频道。
4. `channelId` 置 NOT NULL。
5. 现有 `GET /workrooms/:id/channels`（合成 main）改为真表查询（至少返回这条 main 频道）。**注意：响应契约同时变更（见 §4.1，id→uuid + 补 attention_count + 加字段），需同步更新锁定测试 `workroomRoutes.channels.spec.ts`——这一步是契约变更，非纯兼容。**

## 4. API

所有路径 `/api/v1`。错误用既有 envelope `{error:{code,message}}`。读=双鉴权（machine_token OR dev_ctl_，经 `authorizeControlRead`）；发消息=op_sess_ OR machine_token。

### 4.1 频道列表（真表，**契约变更**——非兼容）
`GET /workrooms/:wid/channels` → `{ workroom_id, channels: [{ id, name, type, visibility, last_activity_at, unread_count, attention_count, member_count }] }`
- ⚠️ **这是契约变更，不是兼容**：现端点（`workroomRoutes.ts:230-242`）返回 `id:'main'`(字面串) + `attention_count`，且有锁定测试 `workroomRoutes.channels.spec.ts:73-83`。新契约：`id` 变成**真 uuid**、**保留 `attention_count`**（之前误删，补回）、新增 `visibility`/`member_count`。**必须同步更新该锁定测试**。唯一已知消费者是即将被替换的旧 CodeLight 客户端 + 新 Slock 前端（仍 mock），故可直接版本化，但**不得声称非破坏**。
- 消息端点的 `:cid` = 真 channel uuid（迁移保证每 workroom 有一条 main 频道，其 uuid 即原 'main' 的替身）。
- 可见性过滤：public 全可见；private/dm 仅成员（machine / dev_ctl_ / op_sess_ operatorSubject 视角）。
- `unread_count` S1 暂回 0（真实计数 = S5 read cursor）；`attention_count` 沿用现算法（needs_human actions + pending approvals），按频道聚合。
- 鉴权：双读。

### 4.2 消息列表
`GET /workrooms/:wid/channels/:cid/messages?after_seq=<n>&limit=<=100` → `{ channel_id, messages: [{ id, seq, sender_kind, sender_id, sender_display_name, content, mentions, embedded_card_type, embedded_card_id, thread_reply_count, created_at }], has_more }`
- seq 升序分页；缺省返回最近 limit 条。
- 私有频道非成员 → 404（uniform，不泄露存在性）。
- 鉴权：双读 + 频道可见性校验。

### 4.3 发消息
`POST /workrooms/:wid/channels/:cid/messages`
body: `{ content, mentions?: string[], embedded_card_type?, embedded_card_id?, client_idempotency_key }`
→ `{ id, seq, created_at, idempotent }`
- 鉴权：`op_sess_`（命令 `send_message`）或 machine_token（agent）。dev_ctl_ 硬拒。
  **不复用 `executeOperatorCommand`（那是 action 专用：CAS `controlAction` 状态）。** 而是用 `authorizeOperatorWrite(request, {command:'send_message', workroomId})`（`operatorSessionAuth.ts:89`，接受任意 command+workroom）做鉴权 + 反枚举校验，然后走一条**新的消息写事务**（不经 operatorCommandTransaction）。
- 事务：写 `ControlMessage`（per-channel `seq` 分配用独立的 FOR UPDATE / unique 约束，**非复用** event-log 的 workroom 级 seq，见 §3.3）→ post-commit `publishAndBroadcast('message.created')`。
- 幂等：`client_idempotency_key`——用 `ControlMessage` 上新增 unique 列，或写一条 `ControlOperatorAuditLog{actionId:null, commandKey:'send_message', clientIdempotencyKey}`（该表 actionId 可空）。重放返回既有。
- 频道成员校验：private/dm 非成员发 → 403。
- 安全：content 入库前不解密敏感；mentions 仅 id；广播 payload 不含敏感（见 §6）。

### 4.4 单条
`GET /messages/:id` → 单条消息（含所属 channel_id），双读 + 可见性校验。给 thread 父消息/深链。

## 5. 实时

- 发消息 post-commit：`publishAndBroadcast({ workroomId, eventId, topic:'message.created', payload:{ channel_id, message_id, seq, sender_kind, sender_id, preview } })`。复用 `publishControlEvent`（write-before-broadcast，`publishControlEvent.ts`）+ `workroomBroadcaster.broadcast`（`actionRoutes.ts:74` 的 `publishAndBroadcast` 为模板）。
  - ⚠️ **`preview` 是 WS payload 里第一次出现自由文本**（现有 payload 全是 id+受控枚举，`actionRoutes.ts:227` 明令"无自由文本"）。**钉死**：`preview` = `redactControlText(content)`（`sources/control/redaction/redactControlText.ts`）后**截断至 ≤120 字符**；绝不含 token/path/credential。若嫌越界，退路：payload 不带 preview、客户端收到 `message.created` 后用 `GET /messages/:id` 拉正文（多一跳但零文本入 payload）。实现时二选一，默认带脱敏截断 preview。
- 客户端：订 workroom WS → 按 `payload.channel_id` 过滤 → 取/追加；catch-up 走 `GET …messages?after_seq`。
- **WS 手机放行（关键，`wsGateway.ts:58-86`）**：
  - **线协议改动（必须）**：现 subscribe 硬读 `msg.machine_token` 且缺失即 `MISSING_FIELDS`（`wsGateway.ts:58-62`）——dev/op token 进不来。改为通用字段：`{ type:'subscribe', workroom_id, token }`（`token` 容纳任意类）。`MISSING_FIELDS` 改判 `workroom_id` + `token`。
  - **多类鉴权**：依次 `verifyMachineToken(token)` → `verifyDevControlToken(token)` → `verifyOperatorSession(token)`。任一有效后，再做 **workroom-scope 校验**——现无 `(token,workroomId)→bool` 的通用 helper（`devTokenInWorkroomScope` 是按 path-regex、`operatorSessionAllows` 需 command 参数），**需新建一个按 token 类判 workroom 归属的 helper**（§8）。通过 → `workroomBroadcaster.subscribe`；全失败 → error + disconnect。
  - **不变式**：仅鉴权通过后才订阅；断开清理订阅；WS 路径无 DB 写。

## 6. 鉴权 / allowlist / 安全

- dev_ctl_ GET allowlist（`devTokenAuth.ts:69-76`）新增正则：`^/api/v1/workrooms/[^/]+/channels/[^/]+/messages$`、`^/api/v1/messages/[^/]+$`。（`/workrooms/:id/channels` 已在。）
- **加 `send_message` operator 命令（非"默认加"，是三处改动）**：`mintOperatorSession` fail-closed 拒绝 `V1_OPERATOR_COMMANDS=['acknowledge_needs_human','mark_reviewed']` 外的命令（`operatorSessionMint.ts:79-88`），且 `OperatorCommandKey` 是闭合 union（`operatorCommandTransaction.ts:46`）。需：(1) 把 `send_message` 加进 `V1_OPERATOR_COMMANDS`；(2) 扩 `OperatorCommandKey` union；(3) 确保 `/connections/access` 铸的 op_sess_ 含 `send_message`。消息发送的反枚举顺序：先 `authorizeOperatorWrite`（验 session+命令+workroom，404/403 uniform）→ 幂等 → 写消息事务（见 §4.3，不经 executeOperatorCommand）。
- 安全红线（沿用现有）：响应/事件/WS payload **不含** token、credential、storage_ref、长内部 UUID 之外的敏感；private/dm 频道存在性对非成员返回 404；跨 workroom 零泄露；message preview 脱敏 + 截断。

## 7. 测试

- 迁移：每 workroom 生成 main 频道 + 回填消息 channelId；旧 `GET channels` **契约变更**，更新锁定测试 `workroomRoutes.channels.spec.ts` 断言新 shape（id→uuid + attention_count + visibility/member_count）。
- 频道列表：public 全可见、private 仅成员、归档过滤。
- 消息列表：分页 after_seq/limit、私有非成员 404。
- 发消息：op_sess_ 通 / machine 通 / dev_ctl_ 拒；幂等重放；private 非成员 403；事件 write-before-broadcast；seq 单调。
- WS：dev_ctl_ 订阅通、op_sess_ 订阅通、machine 订阅通、非法/过期拒+断开、跨 workroom scope 拒。
- allowlist：新 GET 命中、写路径 dev_ctl_ 硬拒。
- 安全：响应/广播无敏感泄露；跨 workroom 404。

## 8. 已定/已知任务（原未决，review 后收敛）

- ✅ seq = **per-channel 净新计数**（FOR UPDATE on channel + `UNIQUE(channelId,seq)`），不复用 event seq（§3.3）。
- ✅ preview = `redactControlText` + 截断 ≤120；或退路不带 preview 走 `GET /messages/:id`（§5）。
- 🔨 **新建 WS workroom-scope helper**：现无 `(token, workroomId)→bool` 通用 helper（`devTokenInWorkroomScope` 按 path-regex、`operatorSessionAllows` 需 command）。需为 machine/dev/op 三类各自实现"该 token 是否归属此 workroom"的判定，供 WS subscribe 用（§5）。这是 S1 的一个明确实现单元。
- 仍开放：消息 `embedded_card` 的最终去规范化策略（S1 只回 type+id，客户端解析；若实测多一跳太重，S2/S3 再评估去规范化）。

## 9. 验收（S1）

- 手机用 `conn_`→`dev_ctl_`/`op_sess_` 能：列真频道、按频道拉消息（分页）、发消息（op_sess_）、订 WS 收到自己/他人 `message.created` 实时到达。
- 迁移后旧数据（消息）可读；`GET channels` 契约已更新（id→uuid + attention_count 保留 + 新字段），锁定测试 `workroomRoutes.channels.spec.ts` 同步更新通过。
- 私有频道隔离、跨 workroom 隔离、无敏感泄露，测试覆盖。
- 前端把 `MockMessageRepository`/`MockChannelRepository` 换成 Live 版后，#slockai 频道聊天端到端跑通（前端零 UI 改动，仅换 repository 实现）。
