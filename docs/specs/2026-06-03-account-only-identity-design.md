# Account-Only Identity & Account↔Computer Pairing — Design Spec

- 日期: 2026-06-03
- 状态: 已定稿(待实现)
- 影响范围: MioServer + CodeLight(iOS) + MioIsland(macOS) — 鉴权底座级改动
- 决策: **硬切**(产品未正式发布,不保留旧模型兼容期)

## 1. 背景与病根

当前一台设备上存在**两套独立身份**,且各自带"归属",会互相打架:

| 身份 | 是什么 | 存哪 | 归属字段 | 用途 |
|---|---|---|---|---|
| 账号身份 `user_sess_` | 邮箱登录会话 | 登录态 | — | workspace / workroom / enrollment approve |
| 设备身份 device keypair | ed25519 密钥对 | **iOS 钥匙串(重装不清)** | `Device.userId` | 监控 socket / redeem 配对 / 读 Mac sessions |

后果(已实际踩中): 手机登录态是账号 A(`laurentliu0918`),但设备密钥押在账号 B(`kris@slock.dev`,旧测试残留)。三个缺陷叠加放大:

1. 设备密钥比账号登录态更持久(钥匙串重装不清),本末倒置。
2. `/v1/auth` 的 hijack guard:设备属 B、会话是 A → 409 拒绝改绑,把"在自己手机换自己另一个号"误判为盗用,且无自愈。
3. 配对是 `DeviceLink`(设备↔设备),不是账号↔电脑 → 自己的手机看自己的 Mac 还要扫码;换手机要重扫。

## 2. 目标(用户三条需求)

1. 登录只在手机端;任何登录的账号都能扫同一台电脑。
2. 同一账号在不同手机登录,看到的一样,**不用重复扫**。
3. 一个账号能扫多台电脑。

## 3. 最终模型

> **身份只认账号(邮箱)。手机是账号的无状态视窗,不持有任何归属。配对 = 「账号↔电脑」的一条边,电脑同一时刻只属于一个账号。**

- 设备密钥**退役为非身份句柄**(仅作设备登记/APNs 推送目标,不再代表归属)。
- 监控可见性按 `userId` 计算,与具体手机无关 → 满足需求 2(换手机自动可见,无需重扫)。
- 同账号下可有多条边 → 满足需求 3。
- 电脑不被独占:任何账号都能扫;若已属他人,走"抢占提示"。

### 3.1 扫码三分支(服务端,鉴权用 `user_sess_`)

手机带 **账号会话** + 电脑配对码扫码,服务端按"电脑当前关联谁"分支:

1. **无人关联** → 建关联(当前账号 → 电脑)。完成。
2. **已关联的就是当前账号** → 幂等(可刷新),无提示。完成。
3. **已关联别的账号** → 返回 `ALREADY_LINKED_OTHER_ACCOUNT`,附**打码邮箱**(如 `l***@gmail.com`),**不直接改**。手机弹提示 →
   - 确认 → 手机带 `force=true` 再请求 → **抢占**(见 3.2)。
   - 取消 → 不动。

> 常态(扫自己电脑)零打扰;仅跨账号才提示。换手机看自己已关联的电脑**根本不触发扫码**——登录即自动拉取。

### 3.2 抢占动作(决策:监控 + workspace **都转**)

`force=true` 抢占时,在一个事务内:

1. 删除旧账号 ↔ 电脑 的**监控关联**。
2. 把该电脑对应的 **workspace(ControlWorkroom)owner membership 从旧账号迁到新账号**(workroom 改为可转移)。
3. 建新账号 ↔ 电脑 的监控关联。
4. 给**旧账号发通知**:"你的电脑 X 已被另一账号接管"(决策:失去 + 通知)。

### 3.3 提示文案(决策 1:B)

显示打码邮箱,便于用户识别是否是自己的另一个账号:
> 「此电脑已被 `l***@gmail.com` 关联,是否解除其关联并改绑到当前账号?」

打码规则:邮箱本地部分保留首字符,其余 `*`,保留域名。

## 4. 数据模型变更

- 新增 `AccountComputerLink { userId, computerId, createdAt }`,唯一约束 `(computerId)` —— **电脑唯一关联一个账号**(同一 computerId 至多一行)。`userId` 上加索引供可见性查询。
  - `computerId` 指向"电脑"实体。落地选型见 §6(复用现有 Mac 表 vs 新表)。
- `Device`(kind=ios):降级为**纯 APNs 推送目标 + 设备登记**。`userId` 仍记录当前登录账号(可自由重绑,无 hijack)。一个账号可多台。
- `Device`(kind=mac)/`ControlMachine`:电脑实体,**无独占 owner**;归属由 `AccountComputerLink` 表达。`/v1/auth/machine` 去掉"绑单一 org owner"那段(2026-06-03 临时实现,本次重构收敛)。
- `DeviceLink`(设备↔设备):**弃用**,数据迁移到 `AccountComputerLink`(见 §7)。

## 5. 鉴权与接口变更

- **`/v1/auth`**:删除 hijack-409;设备密钥不再代表身份。`Device.userId` 无条件重绑到当前 `user_sess_` 的用户。
- **扫码/redeem**(原 `/v1/pairing/code/redeem`):改用 **`user_sess_` 鉴权**;实现 §3.1 三分支 + `force` 抢占;不再走设备 JWT、不再 device↔device。
- **可见性**(原 `getAccessibleDeviceIds`):从基于 `DeviceLink` 改为"`AccountComputerLink.userId = 当前用户` 的全部电脑"。
- **读 sessions/presets/projects + 监控 socket(`/v1/updates`)**:统一 `user_sess_` 鉴权;订阅/广播按账号关联的电脑集合。
- **`/v1/auth/machine`**(Mac 推流身份):保留 machine_token 机器级鉴权用于推流(电脑无主);去掉 owner 绑定。
- **推送扇出**:电脑产生 session 活动 → 找到关联它的账号 → 推给该账号**所有手机**的 APNs。

## 6. 落地选型(实现期细化)

- "电脑"实体选 `Device(kind=mac)` 还是 `ControlMachine`:监控 session 当前由 MioIsland 以 `Device(kind=mac)` 推送(`Session.ownerDeviceId` 指向它),倾向以 `Device(kind=mac)` 为电脑主体,`computerId = Device.id`;`controlMachineId` 继续桥接 workspace 侧。终局可考虑两者合一。

## 7. 迁移(硬切)

1. 建 `AccountComputerLink` 表。
2. 现有 `DeviceLink(ios↔mac)` → 对每条,取 ios 设备的 `userId` 作为账号,mac 设备作为 computer,写入 `AccountComputerLink(userId, macDeviceId)`;同一 computer 多账号冲突时保留最近活跃者(其余丢弃,记录日志,不静默)。
3. 现有 `Device.userId` 残留错绑一并校正(已手工把本人手机从 kris 改绑到 laurentliu0918,迁移脚本需幂等覆盖此类)。
4. 弃用 `DeviceLink` 读写路径。
5. 老 build 直接不兼容(硬切)。

## 8. 风险

- 改的是鉴权底座,三端齐动,需联调。
- **防盗职责转移**:删 hijack 后,账号被盗 = 名下电脑全暴露 → 账号侧会话安全(登出 / 撤销 / 异常登录)必须补齐,不能裸奔。
- 抢占转 workspace owner 涉及 workroom 成员迁移,需保证事务原子性,避免半转移。
- 迁移期 DeviceLink→边表 的多账号冲突需明确取舍并 log,禁止静默截断。

## 9. 暂不做 / 待定

- 跨账号"主动分享"(一台电脑同时给多账号看)——本期不做,模型为单账号独占 + 抢占。若日后要,`AccountComputerLink` 去掉 `(computerId)` 唯一约束即可扩展。
- "电脑/机器"双表(`Device(mac)` 与 `ControlMachine`)合一——本期保持桥接,留作后续。

## 10. 验收口径

- 账号 A 扫电脑 C(无人关联) → C 出现在 A 的监控列表;A 的另一台手机登录后**无需扫码**也能看到 C(需求 2)。
- A 扫 C1、C2 → 两台都在列表(需求 3)。
- 账号 B 扫已属 A 的 C → 提示打码邮箱 → 确认抢占 → C 转到 B(监控+workspace),A 失去并收到通知;A 的手机不再看到 C(需求 1 + 决策 2/3)。
- 删除全部设备密钥身份残留后,不再出现"登录态与设备归属不一致"。
