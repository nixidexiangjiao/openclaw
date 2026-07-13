# SquillaRouter 智能路由：设计文档

本文档说明把 OpenSquilla 的智能模型路由移植进 OpenClaw 的整体设计：做了什么、
怎么做、架构与流程、以及是否需要一个中控（结论：**需要，但要收窄边界**，落在内部
`tokenhub` 配置下发系统）。

配套图（drawio 源文件，用 <https://app.diagrams.net> 打开）：

- 系统架构图：[`design/architecture.drawio`](design/architecture.drawio)
- 单轮请求流程图：[`design/request-flow.drawio`](design/request-flow.drawio)
- 配置下发（中控）流程图：[`design/config-distribution.drawio`](design/config-distribution.drawio)

> 命名澄清：本文的 **tokenhub** 指公司内部的**配置下发中控系统**，与仓库里已有的
> `extensions/tencent`（Tencent **TokenHub**，混元 hy3 的模型 provider 网关）**不是**
> 同一个东西。为避免混淆，集成时用 `configSource` 作为代码里的通用名，tokenhub 只是
> 它的一个传输实现。

---

## 1. 背景与目标

OpenSquilla 的 SquillaRouter 会给每一轮对话选一个「够用的最便宜模型」。目标是把这套
能力搬到 OpenClaw，让每轮 agent 运行前自动选档，既省成本又不牺牲难任务的质量。

约束（贯穿始终，不可回退）：

- **成本要真降**：换模型会丢掉 provider 侧 KV-cache，短续轮硬切「更便宜」的模型反而
  更贵，所以必须有 KV-cache 粘滞。
- **决策集中**：路由智能集中在一处，改策略一处生效，并能给自学习集中供料。
- **库不存明文**：接口可传原文（内部系统），但决策库**不落任何消息文本**，只存派生数据。
- **可追踪**：出问题能查，靠 `decisionId` 把「端上明文」和「中央无明文轨迹」关联起来。
- **协议通用**：中央的路由算法以后可能整体替换，客户端协议不能绑定某一种算法。

---

## 2. 这次做了什么（演进历程）

分几步落地，当前状态是第 4 步：

1. **启发式层移植（PoC）**：把 OpenSquilla 无依赖的规则层（分档 + flag + flag 升级）
   移到 `router.ts`，阈值与关键词表与源保持等价。纯函数、可离线跑。
2. **KV-cache 粘滞**：`applySticky` —— 短续轮阻止下调档位（保住热缓存），升档放行
   （难任务值得一次 cache miss）。`SessionTierStore` 记录每会话上一轮**实际服务**的档位。
3. **中央化**：路由智能全部搬到独立部署的**中央服务**（Python，
   `services/squilla_central/server.py`），插件退化为瘦客户端。接口传明文，库不存明文，
   每次返回 `decisionId`。中央算法用零训练的锚点相似度（`classify_semantic`），
   预留为将来接入 V4 训练管线的替换接缝。
4. **MySQL + 通用协议**（本次）：
   - 决策库从 sqlite3 换成 **MySQL**（PyMySQL：`%s` 占位符、`ON DUPLICATE KEY UPDATE`
     upsert、`ping(reconnect=True)`、InnoDB 建表），用 `SQUILLA_MYSQL_*` 环境变量配置。
   - `/v1/route` 响应改为**通用契约**：`{decisionId, tier, confidence, policyVersion, meta}`，
     算法专属细节（routeClass、band、flags、flagUpgraded、margin）全部收进不透明的
     `meta`，客户端**不解析**。客户端只依赖抽象 `tier` + `decisionId`，`confidence` 可选。
   - 这样中央算法整体替换时，客户端零改动。

代码位置：

| 侧   | 文件                                          | 职责                                                                    |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 插件 | `extensions/squilla-router/index.ts`          | `before_model_resolve` 接线、图片短路、兜底、粘滞、落地覆盖             |
| 插件 | `extensions/squilla-router/central-client.ts` | 调 `/v1/route`，解析**通用响应**，失败即返回兜底信号                    |
| 插件 | `extensions/squilla-router/router.ts`         | 本地启发式兜底、`resolveRoute`（就近档位 + 置信门 + 粘滞）、配置解析    |
| 插件 | `extensions/squilla-router/session-store.ts`  | 每会话上一轮档位（TTL 30min，LRU 上限 2000）                            |
| 中央 | `services/squilla_central/server.py`          | 嵌入 → `classify_semantic` → 置信门/flag 升级 → 落库 → 响应；MySQL 存储 |

---

## 3. 系统架构

见 [`design/architecture.drawio`](design/architecture.drawio)。

三个部署单元 + 一个中控：

- **OpenClaw 实例（可多实例 / fleet）**：`squilla-router` 插件。只保留三类必须在端上的能力：
  - 中央宕机也要活着的：**启发式兜底**；
  - 天然属于端上的：**档位→模型映射**、**KV-cache 粘滞**、**图片短路**；
  - 明文所在地：**会话记录**（transcript）。
- **中央路由服务（Python）**：拥有一切「决策」。嵌入消息、语义分类、置信门、flag 升级、
  落库、返回抽象档位。`classify_semantic` 是唯一的算法替换接缝。
- **MySQL**：`decisions` / `feedback` 两表，**无明文列**。位于隐私边界内。
- **Embeddings 服务**：任意 OpenAI 兼容端点（如 TEI + bge）。
- **tokenhub（中控）**：**版本化下发两份配置**（客户端路由包 + 中央策略包），定时拉取、
  失败回退到 last-known-good。详见 §5。

职责边界（与 OpenClaw 架构约束对齐）：

- 核心保持 plugin-agnostic，插件只通过 `openclaw/plugin-sdk/*` 的 `before_model_resolve`
  钩子接入。
- 插件不在热路径做 freshness polling；中控快照是**生命周期持有的单槽缓存**（后台刷新），
  热路径只读快照，符合「Process-local metadata caches ok when lifecycle-owned and
  bounded/single-slot」。

---

## 4. 单轮请求流程

见 [`design/request-flow.drawio`](design/request-flow.drawio)。

插件侧（`index.ts`）：

1. **图片短路**：本轮含图片附件 → 不覆盖，保留会话原本的（视觉能力）模型，直接返回。
2. **中央优先**：`config.central` 存在 → `routeRemote` POST `/v1/route`（明文，内部网）。
3. **兜底**：中央失败/超时 → `classifyTurn` 本地启发式（含节流告警，一分钟一条）。
4. **落地**：`resolveRoute` —— 就近取配置档位（缺档优先向上，不静默降级）；置信门对
   `band=central` 直通（中央已自带门控，信任其返回档位）。
5. **粘滞**：`applySticky` —— 短续轮阻止下调（保 KV-cache），升档放行。
6. **记账**：`SessionTierStore.set` 记本轮档位；debug 日志带 `decisionId`（与端上明文并排）。
7. 返回 `{modelOverride, providerOverride?}`。

中央侧（`server.py` `Central._route`）：

嵌入消息 → `classify_semantic`（锚点余弦 + margin 升级 + 欠路由安全网）→ 置信度门
（低置信 → defaultTier）→ flag 升级 → `final_tier` → **落库（无明文）** → 返回
`{decisionId, tier, confidence, policyVersion, meta}`。embedding 失败时中央侧还有启发式
兜底，照常落库，所以客户端只有在**中央本身宕机**时才回退到本地启发式。

---

## 5. 是否需要中控？—— 需要，但收窄

### 5.1 结论

**需要一个中控，但边界要窄。** 它只做**版本化配置下发**，不参与任何单轮决策，也永不
成为热路径依赖。落在内部 `tokenhub`。

### 5.2 为什么需要

| 痛点                                                | 无中控                                  | 有中控（tokenhub）                           |
| --------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| 改档位→模型映射（如 c2 从 glm-5.2 换 glm-6）        | 逐个改每个实例的 `openclaw.json` + 重启 | 改一份包 + 版本号，fleet 定时拉到            |
| 调路由策略（置信阈值、锚点、margin/安全网、默认档） | 改中央 env + 重启，不能灰度/回滚        | 版本化包，可灰度、可回滚                     |
| 决策可复现                                          | 只有 `policyVersion`                    | `policyVersion` + `configVersion` 双戳进轨迹 |
| per-tenant 差异化策略                               | 手工分发                                | tokenhub 按 tenant keying                    |

### 5.3 为什么要收窄（不做成什么都管的大中控）

- **配置面很贵**（OpenClaw 明确 gate 配置/env 面）：新增一个运行时依赖必须能容忍它挂。
  → **fail-open**：拉取失败时保留 last-known-good，tokenhub 宕机绝不阻塞路由。
- **不能进热路径**：→ 后台定时刷新 + **单槽快照**；每轮只读快照，绝不 per-turn 拉取。
- **不拥有决策**：路由决策留在中央服务；tokenhub 只喂「配置」，不喂「答案」。这样保住了
  「决策集中在中央」的原始诉求。

### 5.4 tokenhub 下发的两份配置

见 [`design/config-distribution.drawio`](design/config-distribution.drawio)。

**A. 客户端路由包**（下发给每个 OpenClaw 实例，按 tenant）：

```json
{
  "configVersion": "cfg-2026-07-12.3",
  "tiers": {
    "c0": { "model": "deepseek/deepseek-v4-flash" },
    "c1": { "model": "deepseek/deepseek-v4-pro" },
    "c2": { "model": "z-ai/glm-5.2" },
    "c3": { "model": "z-ai/glm-5.2", "provider": "zai" }
  },
  "defaultTier": "c1",
  "sticky": { "enabled": true, "maxUserLen": 200 }
}
```

**B. 中央策略包**（下发给中央服务，按 tenant）：

```json
{
  "policyVersion": "central-py-v2",
  "confidenceThreshold": 0.5,
  "defaultTier": "c1",
  "anchors": { "c0": ["..."], "c1": ["..."], "c2": ["..."], "c3": ["..."] },
  "marginUpgradeThreshold": 0.1,
  "underRouteSafetyThreshold": 0.45
}
```

两份都**版本化**；决策轨迹里同时记 `policyVersion` 和 `configVersion`，任何一次路由都能
回放它当时用的是哪版配置。

### 5.5 集成方式（代码接缝）

- 两侧各加一个 `configSource`（通用 HTTP 拉取器）：`GET <tokenhub>/config/<bundle>?tenant=...`
  返回 `{version, payload}`。tokenhub 只是它的 URL/传输，实现与 tokenhub 私有 API 解耦。
- **刷新**：后台定时（如 30s）拉取 → 校验（zod / 服务端 schema）→ 通过则原子替换单槽快照；
  失败则保留旧快照并节流告警。
- **热路径**：`before_model_resolve` / `Central._route` 只读当前快照，不感知 tokenhub。
- **落地为快照的对象**：正是现在 `parseRouterConfig` / 中央 `Central.__init__` 已经在用的
  内存配置对象——所以接缝很小：把「一次性从 openclaw.json/env 读」换成「快照被后台刷新」。

> 现在的静态配置（`openclaw.json` 的 `central`/`tiers`/`sticky`、中央的 `SQUILLA_*` env）
> 仍是**引导来源与兜底默认**：tokenhub 不可达时用它们。tokenhub 是可选增强，不是硬依赖。

---

## 6. 隐私与可追踪契约

- **明文只存在两处**：请求体（内部网传输，用后即弃）、客户端会话记录（端上）。
- **决策库无明文**：`decisions` 表没有文本列，只存字符数、flags、4 类概率、margin、
  `base→gated→final` 三段档位轨迹、最近锚点及相似度、嵌入向量、版本号、延迟。
- **decisionId 关联**：每次决策返回 `decisionId`，插件打进 debug 日志（与端上明文并排）。
  查问题四步：`/v1/stats` 看分布 → `/v1/decisions?sessionKey` 找turn →
  `/v1/decisions/{id}` 看完整轨迹+锚点画像 → 需要原文则去端上日志 grep `decisionId`。

---

## 7. 失败模式与降级

| 失败点        | 行为                                   | 用户可见影响              |
| ------------- | -------------------------------------- | ------------------------- |
| 中央超时/宕机 | 插件回退本地启发式，节流告警           | 路由质量略降，不阻塞      |
| Embeddings 挂 | 中央用自己的启发式兜底，照常落库       | 客户端无感                |
| MySQL 挂      | 决策落库失败（路由本身仍返回）；需告警 | 轨迹缺失，路由可用        |
| tokenhub 挂   | 两侧保留 last-known-good 快照          | 无（配置不更新而已）      |
| 会话档位丢失  | 下一轮自由重路由                       | 无（可能一次 cache miss） |

原则：路由链路上的每个外部依赖都必须能**优雅降级**，绝不让配置/中控/库的故障阻断出词。

---

## 8. 安全

- 中央接口用 `SQUILLA_CENTRAL_TOKEN` bearer 校验；插件用 `central.apiKey`。
- tokenhub 拉取需鉴权（token 从环境/凭据注入，不写进仓库）。
- 不落明文、不打印密钥；MySQL 凭据走 `SQUILLA_MYSQL_*` env，不入库、不入日志。
- 模型标识符不写进 commit / 代码注释 / 文档产物。

---

## 9. 未来 / 替换 V4

`classify_semantic` 是单一替换接缝：把它的实现从零训练锚点相似度换成 OpenSquilla 训练好的
V4 管线（BGE + LightGBM + MLP ensemble），只要仍返回 `final_tier`，store / 轨迹 / 端点 /
通用协议全都不动。通用协议（§2.4）已经保证客户端不会因为换算法而改代码。自学习靠
`/v1/feedback` 收点赞点踩，加上决策库里的嵌入向量作原料。

---

## 10. 未决问题

1. tokenhub 的实际拉取 API 形状（路径、鉴权、返回信封）需要对接后确认，才能落地
   `configSource` 实现。
2. 中央策略包里下发 `anchors` 会改变分类行为，需要灰度 + 回滚流程（版本化已支持，流程待定）。
3. 多中央实例时的一致性：都从 tokenhub 拉同一版，刷新窗口内可能短暂不一致（可接受，
   `configVersion` 可观测）。
