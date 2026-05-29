# CodeLight ③ 连接池打爆 — aab2980 后续诊断

**日期：** 2026-05-29
**服务器：** ③ `code.7ove.online` / AWS Lightsail Tokyo `13.192.234.215`
**前序修复：** commit `aab2980` (fix(server): stop pm2 restart storm — upsert dedup + checkAccess try/catch)

## TL;DR

`aab2980` 部署后（5/29 01:50 UTC 重启生效）**崩溃 storm 确实停了**——进程稳定 13h+ 没崩，pm2 restart 数停在 262 不再涨。但**根因没根治**：连接池仍在间歇被打爆，duplicate-key 错误只腰斩没清零。

需要再补一刀：把非原子的 Prisma `upsert` 换成原子的 `INSERT ... ON CONFLICT DO NOTHING`，或者 catch P2002。

## 部署后实测（5/29 01:50 UTC 生效，测于 ~14:56 UTC）

| 指标 | 部署前 (~1.8h 窗口) | 部署后 (~13h 窗口) | 折算每小时 | 结论 |
|---|---|---|---|---|
| pm2 restart | 持续涨（+185/周）| 停在 262 | 0 新增 | ✅ 崩溃修好 |
| duplicate-key (SessionMessage) | 543 | 1944 | **297/h → 148/h** | ⚠️ 腰斩，未清零 |
| canAccessSession failed | 高频 | 仍发生（近 2000 行 err 里 394 条）| 仍在 | ⚠️ 连接池仍打爆 |
| pool timeout (P2024) | 有 | **最新一条 err 仍是 pool timeout** | 仍在 | ⚠️ 未解 |

> 注意：绝对数 543→1944 是因为部署后观测窗口长 7 倍，**按每小时算是从 ~297/h 降到 ~148/h**，约腰斩。

## 为什么 upsert 没根治

`aab2980` 用的写法：

```ts
const message = data.localId
  ? await db.sessionMessage.upsert({
      where: { sessionId_localId: { sessionId: data.sid, localId: data.localId } },
      create: { sessionId: data.sid, content: data.message, localId: data.localId, seq },
      update: {},
    })
  : await db.sessionMessage.create({ ... });
```

**Prisma 的 `upsert` 不是数据库原子操作**——它在应用层做 `SELECT`（存在吗）→ 然后 `INSERT` 或 `UPDATE` 两步。

Codex 格式客户端 / Mac retry 在极短时间内发同一个 `localId` 两次时：
1. 两个请求几乎同时进来
2. 两个 upsert 的 SELECT 阶段都查到"不存在"
3. 两个都走 INSERT 分支
4. 其中一个撞 `@@unique([sessionId, localId])` → P2002

所以 race 窗口只是变窄了（多了一次 SELECT 的时间差），没消除。撞约束的失败 INSERT 依然短暂占住 Prisma 连接池槽位，pool（limit=20）在 burst 时仍会 starve。

## 根治方案（二选一）

### 方案 A：Postgres 原生原子 upsert（推荐）

用 `INSERT ... ON CONFLICT DO NOTHING`，数据库层面单条原子语句，零 race：

```ts
// 需要拿回插入/已存在的行，用 RETURNING + 回查
const rows = await db.$queryRaw<Array<{ id: string; seq: number }>>`
  INSERT INTO "SessionMessage" ("id", "sessionId", "localId", "seq", "content", "createdAt")
  VALUES (${cuid()}, ${data.sid}, ${data.localId}, ${seq}, ${data.message}, now())
  ON CONFLICT ("sessionId", "localId") DO NOTHING
  RETURNING "id", "seq"
`;
// rows 为空 = 是重复（已存在），按幂等 no-op 处理，不要再 emit new-message
```

优点：一步到位，零 race，最省连接池。
注意：`ON CONFLICT DO NOTHING` 在冲突时不返回行，需要据此判断"这是重复消息"，跳过后续的 new-message 广播（避免重复推送）。

### 方案 B：保留 create，catch P2002

```ts
try {
  message = await db.sessionMessage.create({ data: { sessionId: data.sid, content: data.message, localId: data.localId, seq } });
} catch (err) {
  if (err?.code === 'P2002') {
    // 重复 localId — 幂等 no-op，按已存在处理，跳过 new-message 广播
    return;
  }
  throw err;
}
```

优点：改动小。缺点：仍然依赖"抛错再吞"，DB 层面还是会记一条 ERROR（Postgres log 噪音），只是不再占用额外往返。比 A 略逊。

## 还需要查的两件事（根因的根因）

1. **客户端为什么发重复**：Codex 格式 client（localId 形如 `codex-NNN-text-0`、`toolu_xxx`）在 stream 过程中重发同一条。是 stream rewrite 正常行为，还是 retry 逻辑没去重？如果能在**客户端**去重，server 压力直接消失。
2. **连接池是否需要再扩 / 加监控**：即便修好 duplicate，`canAccessSession` 仍偶发 pool timeout，说明高峰期 20 个连接可能本身就紧。建议：(a) 部署方案 A 后复测 pool timeout 是否归零；(b) 若仍有，考虑 `connection_limit=30` + 给 pg `max_connections` 留余量（当前 100，够）。

## 验证方法（改完后）

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@13.192.234.215
# 1. duplicate-key 应归零
sudo grep "$(date -u +%Y-%m-%d)" /var/log/postgresql/postgresql-*.log | grep -c "duplicate key.*SessionMessage"
# 2. pool timeout 应归零
grep -c "P2024\|canAccessSession failed" ~/.pm2/logs/codelight-server-error.log  # 看增量
# 3. restart 数保持不涨
pm2 status
```

## 相关

- 前序：`fb469f3`（pool 3→20 + 三处 try/catch + cache）、`2b6e95d`（chatContent refactor）、`aab2980`（本次 upsert + checkAccess）
- 服务器架构备忘：① is.wdao.chat = 测试机；③ code.7ove.online = 真实用户（本文件针对 ③）
