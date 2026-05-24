# Slock S7 — Monitoring Consolidation (fold legacy `/v1` into the control plane)

- Date: 2026-05-24
- Status: Draft spec / decomposition (from a full two-stack map; pending review + user sign-off on the destructive phases)
- Owner: Laurent (ying)
- Branch: `feat/server-control-plane` (MioServer)
- 关联：S1–S6 已建好控制面。S7 是收尾——把遗留 `/v1` 监控栈并入 `/api/v1`，统一单连接，最终下线 `/v1`。延续 [[project-codelight-slock-pivot]]。

## 0. 目标
MioServer 现在**同进程并存两套栈**：
- **遗留 `/v1`**：`Session`/`SessionMessage` + 设备 JWT/签名鉴权（`auth/crypto.ts`）+ Socket.IO `/v1/updates`（设备域广播）。~45 条路由（pairing/sessions/devices/push/subscription/admin）。CodeLight **现在仍在用**（SocketClient.swift `/v1/updates` + `/v1/sessions|devices|pairing|subscription`）。
- **控制面 `/api/v1`**：machine/dev_ctl_/op_sess_/conn_ 鉴权 + `/api/v1/ws/control`（workroom 域，write-before-broadcast）。~90 条路由（S1–S6）。

S7 把前者并入后者：统一鉴权（单 `conn_` 连接凭据）、单 WS、`Session`→控制面会话、`SessionMessage`→`ControlMessage`，最终删 `/v1`。

## 1. ⚠️ 风险与纪律（关键）
S7 不同于 S1–S6：**它动真实遗留数据 + 用户在用的监控**。
- **D2/D3 是破坏性数据迁移**（`Session`/`SessionMessage` 搬进控制面 + 删表）——一旦做错会丢历史 / 弄坏 CodeLight 现役监控。**这两步必须：先备份、双跑校验、保留回滚、且在用户知情下执行**。不在上下文吃紧时仓促做。
- **D4 合并两个 Socket.IO**、**D5/D8 下线 `/v1` 路由**：会改变 CodeLight 现役行为——必须先把 CodeLight 迁到控制面（D7）再下线，否则断掉用户在用的功能。
- 因此 S7 的执行顺序是 **加法在前、减法在后**：先让控制面能承接监控（additive，零破坏），把 CodeLight 切过去，验证无回归，**最后**才迁数据 / 删 `/v1`。

## 2. 分解（phase，加法→减法）
按风险/依赖排序。每个 phase 自己出 plan + 走 subagent-driven 执行 + 我独立验证。

### Phase A（加法、零破坏）— 控制面承接"监控"读
- **A1 统一鉴权入口**：让遗留客户端能用 `conn_` 凭据（`ControlConnectionCredential` 已存在）换取控制面读权，而不必两套 token。additive：不动 `/v1` 鉴权，只新增 conn_ 路径。
- **A2 监控只读端点**：控制面已有等价物（`ControlSession`/`ControlAction`/`ControlApproval`/`ControlEventLog`）。补齐 CodeLight 监控所需的只读端点（若缺），让监控 UI 能**只从 `/api/v1` 读**。零破坏（`/v1` 仍在）。
- 验收：CodeLight 能用单 `conn_` + `/api/v1` 读到监控所需数据；`/v1` 不受影响。

### Phase B（客户端迁移、零服务端破坏）
- **B1 CodeLight 监控切控制面**：把 SocketClient/旧 HTTP 调用从 `/v1/updates`+`/v1/*` 改到 `/api/v1/ws/control`+`/api/v1/*`（read 侧）。pairing/launch/subscription 暂留 `/v1`（见 Phase D）。
- **B2 单 WS**：CodeLight 只连 `/api/v1/ws/control`（去掉 `/v1/updates` 连接）。
- 验收：CodeLight 监控功能在控制面上等价工作；`/v1/updates` 无人连。

### Phase C（破坏性数据迁移 — ⚠️ 需备份+用户知情）
- **C1 `Session`→`ControlSession`**：加 `workroomId`（每设备自动建"个人 workroom"或归入现有），backfill 现存 session。双跑校验（计数/抽样比对），保留旧表一段时间。
- **C2 `SessionMessage`→`ControlMessage`**：搬进每 workroom 的"主"频道，seq 化。双跑校验。
- **C3 订阅/推送强制点迁移**：subscription gate 从遗留 socket handshake 移到控制面会话创建/连接交换。`/v1/push-*` 推送投递本身正交，可保留。
- 验收：控制面持有全部历史会话/消息；抽样比对一致；回滚脚本就绪。

### Phase D（减法 — 下线 `/v1`）
- **D1 pairing/launch 迁移**：`/v1/pairing/*`→控制面 operator pairing（#153 已原生）；`/v1/sessions/launch`→task/action fire。
- **D2 路由下线**：遗留 `/v1/*` 加 410/307 或直接删（确认无消费者后）。删 `socketServer.ts` `/v1/updates`、`auth/crypto.ts`、遗留 Prisma 模型。
- **D3 `main.ts` 单栈**：只剩 `attachControlPlaneWs`；删 `startSocket`。
- 验收：进程零 `/v1`；CodeLight 全控制面；测试全绿。

## 3. 不做 / 范围注意
- 推送投递（APNs `/v1/push-*`/`live-activity-*`）正交于"监控并入"，**S7 不强行迁**（可保留或单独处理）。
- Phase C/D 破坏性，**默认不在本轮自动执行**；先做 A/B（零破坏），C/D 待用户明确点头 + 备份就绪。

## 4. 测试 / 验收
- 每 phase：服务端 `*.spec.ts`（新端点鉴权/形状）+ CodeLight 迁移后 build+test 绿 + 我独立验证。
- C 阶段额外：迁移 backfill 的计数/抽样比对断言 + 回滚演练。
- 终态：单栈、CodeLight 单连接、`/v1` 归零、全测试绿。

## 5. 推荐执行顺序
**A1 → A2 → B1 → B2 →（用户点头+备份）→ C1 → C2 → C3 → D1 → D2 → D3。**
A/B 全程零破坏、可随时停。C/D 破坏性，按风险纪律（§1）执行。
