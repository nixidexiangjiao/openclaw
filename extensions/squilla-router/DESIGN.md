# SquillaRouter 智能路由：设计文档

本文档说明把 OpenSquilla 的智能模型路由移植进 OpenClaw 的整体设计：做了什么、
怎么做、架构与流程、以及中控（`tokenhub`）的边界。

配套图（drawio 源文件，用 <https://app.diagrams.net> 打开）：

- 系统架构图：[`design/architecture.drawio`](design/architecture.drawio)
- 单轮请求流程图：[`design/request-flow.drawio`](design/request-flow.drawio)
- 配置下发（中控）流程图：[`design/config-distribution.drawio`](design/config-distribution.drawio)

> 命名澄清：本文的 **tokenhub** 指公司内部的**配置下发中控系统**，与仓库里已有的
> `extensions/tencent`（Tencent **TokenHub**，混元 hy3 的模型 provider 网关）**不是**
> 同一个东西。

---

## 1. 背景与目标

OpenSquilla 的 SquillaRouter 会给每一轮对话选一个「够用的最便宜模型」。目标是把这套
能力搬到 OpenClaw，让每轮 agent 运行前自动选档，既省成本又不牺牲难任务的质量。

约束（贯穿始终，不可回退）：

- **成本要真降**：换模型会丢掉 provider 侧 KV-cache，短续轮硬切「更便宜」的模型反而
  更贵，所以必须有 KV-cache 粘滞。
- **决策集中**：路由智能集中在中央一处，改策略一处生效，并能给自学习集中供料。
- **插件尽量薄**：插件里不放任何「路由智能」。它只做进程内必须做的事，加上中央宕机时
  的粗略兜底。
- **库不存明文**：接口可传原文（内部系统），但决策库**不落任何消息文本**，只存派生数据。
- **可追踪**：出问题能查，靠 `decisionId` 把「端上明文」和「中央无明文轨迹」关联起来。
- **协议通用**：中央的路由算法以后可能整体替换，客户端协议不能绑定某一种算法。

---

## 2. 这次做了什么（演进历程）

1. **启发式层移植（PoC）**：把 OpenSquilla 无依赖的规则层移到插件，验证端到端可行。
2. **KV-cache 粘滞**：`applySticky` —— 短续轮阻止下调档位（保住热缓存），升档放行。
3. **中央化**：路由智能全部搬到独立部署的**中央服务**（Python，
   `services/squilla_central/server.py`），插件退化为瘦客户端；接口传明文，库不存明文，
   每次返回 `decisionId`。中央算法是零训练锚点相似度（`classify_semantic`），预留为将来
   接入 V4 训练管线的替换接缝。
4. **MySQL + 通用协议**：决策库换成 MySQL（PyMySQL）；`/v1/route` 响应改为通用契约
   `{decisionId, tier, confidence, policyVersion, meta}`，算法专属细节收进不透明 `meta`。
5. **插件瘦身**（本次）：**删掉插件里那份完整启发式兜底**（它重复了中央的规则层、会漂移）。
   - 中央在时：一切走中央，插件只把抽象档位映射到模型。
   - 中央挂时：一个 **~10 行的粗略兜底**（按长度/有无代码猜档，中段用 `defaultTier`）。
   - 客户端响应解析收窄到**只读 `tier` + `decisionId`**；`resolveRoute` 只做「就近档位 +
     粘滞」，删掉了启发式专属的置信度门/band/flag。
   - 插件非测试代码从 ~671 行降到 ~478 行。

代码位置：

| 侧   | 文件                                          | 职责                                                                    |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 插件 | `extensions/squilla-router/index.ts`          | `before_model_resolve` 接线、图片短路、粗略兜底、粘滞、落地覆盖         |
| 插件 | `extensions/squilla-router/central-client.ts` | 调 `/v1/route`，只解析 `tier` + `decisionId`，失败即返回兜底信号        |
| 插件 | `extensions/squilla-router/router.ts`         | `fallbackTier`（粗略兜底）、`resolveRoute`（就近档位 + 粘滞）、配置解析 |
| 插件 | `extensions/squilla-router/session-store.ts`  | 每会话上一轮档位（TTL 30min，LRU 上限 2000）                            |
| 中央 | `services/squilla_central/server.py`          | 嵌入 → `classify_semantic` → 置信门/flag 升级 → 落库 → 响应；MySQL 存储 |

---

## 3. 系统架构

见 [`design/architecture.drawio`](design/architecture.drawio)。

三个部署单元 + 一个中控：

- **OpenClaw 实例（可多实例 / fleet）**：`squilla-router` 插件。只保留三类事：
  - 进程内必须做的：`before_model_resolve` 钩子拦截 + 返回 `modelOverride`；
  - 天然属于端上的：**档位→模型映射**、**KV-cache 粘滞**、**图片短路**；
  - 中央宕机时的**粗略兜底**（按长度/代码猜档，不是中央规则层的副本）。
  - 明文只在会话记录（transcript）里，端上。
- **中央路由服务（Python）**：拥有一切「决策」。嵌入消息、语义分类、置信门、flag 升级、
  落库、返回抽象档位。`classify_semantic` 是唯一的算法替换接缝。
- **MySQL**：`decisions` / `feedback` 两表，**无明文列**，位于隐私边界内。
- **Embeddings 服务**：任意 OpenAI 兼容端点（如 TEI + bge）。
- **tokenhub（中控）**：**只向中央服务**下发版本化策略配置；**不下发到插件**。详见 §5。

职责边界（与 OpenClaw 架构约束对齐）：

- 核心保持 plugin-agnostic，插件只通过 `openclaw/plugin-sdk/*` 的 `before_model_resolve`
  钩子接入。
- **插件配置全部来自 `openclaw.json`**（tiers / defaultTier / sticky / central 端点），
  它也是兜底路径的唯一配置来源。插件不感知 tokenhub。
- 插件不在热路径做任何 freshness polling；它连中控快照都没有——配置是启动时读一次的静态值。

---

## 4. 单轮请求流程

见 [`design/request-flow.drawio`](design/request-flow.drawio)。

插件侧（`index.ts`）：

1. **图片短路**：本轮含图片附件 → 不覆盖，保留会话原本的（视觉能力）模型，直接返回。
2. **中央优先**：`config.central` 存在 → `routeRemote` POST `/v1/route`（明文，内部网），
   拿回 `tier` + `decisionId`。
3. **粗略兜底**：中央失败/超时 → `fallbackTier(prompt, attachmentCount, defaultTier)`：
   很长→c3；有代码块/附件/较长→c2；很短→c0；其余→`defaultTier`（来自 openclaw.json）。
   （含节流告警，一分钟一条。）
4. **落地**：`resolveRoute` —— 就近取配置档位（缺档优先向上，不静默降级）+ 粘滞。
5. **粘滞**：`applySticky` —— 短续轮阻止下调（保 KV-cache），升档放行。
6. **记账**：`SessionTierStore.set` 记本轮档位；debug 日志带 `source`（central/fallback）与
   `decisionId`（与端上明文并排）。
7. 返回 `{modelOverride, providerOverride?}`。

中央侧（`server.py` `Central._route`）：

嵌入消息 → `classify_semantic`（锚点余弦 + margin 升级 + 欠路由安全网）→ 置信度门 →
flag 升级 → `final_tier` → **落库（无明文）** → 返回
`{decisionId, tier, confidence, policyVersion, meta}`。embedding 失败时中央侧还有启发式
兜底，照常落库，所以插件只有在**中央本身宕机**时才用它那份粗略兜底。

---

## 5. 中控（tokenhub）—— 只喂中央，边界很窄

### 5.1 结论

**中控只做一件事：向中央服务下发版本化的路由策略配置。** 它不参与单轮决策，永不进热路径，
也**不下发任何东西到插件**。插件配置一律走 `openclaw.json`。

### 5.2 为什么这么收

| 关注点                                                         | 处理                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 中央策略要能灰度/回滚（置信阈值、锚点、margin/安全网、默认档） | tokenhub 下发版本化策略包给中央，可灰度、可回滚                        |
| 决策可复现                                                     | 决策轨迹记 `policyVersion`，能回放某次路由用的是哪版策略               |
| 插件配置（tier→模型、sticky、central 端点）                    | 走 `openclaw.json`，由运维按实例管理；**不经 tokenhub**                |
| 新增运行时依赖必须能容忍它挂                                   | 中央对 tokenhub **fail-open**：拉不到就用 last-known-good              |
| 不能进热路径                                                   | 中央后台定时刷新 + **单槽快照**；`_route` 只读快照，绝不 per-turn 拉取 |

> 明确的取舍：因为 tokenhub 不下发到插件，**改 fleet 的档位→模型映射仍要逐个改
> `openclaw.json`**。这是刻意的——插件侧保持零外部配置依赖、启动即定，换来更简单、更可预测
> 的端上行为；需要集中改模型映射时用配置管理/发布流程推 `openclaw.json`，而不是让插件在
> 运行时拉中控。

### 5.3 tokenhub 下发的策略包（只给中央）

见 [`design/config-distribution.drawio`](design/config-distribution.drawio)。

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

### 5.4 集成方式（只在中央侧）

- 中央加一个 `configSource`（通用 HTTP 拉取器）：`GET <tokenhub>/config/policy?tenant=...`
  返回 `{version, payload}`。tokenhub 只是它的 URL/传输，与 tokenhub 私有 API 解耦。
- **刷新**：后台定时（如 30s）拉取 → 校验 → 通过则原子替换单槽快照；失败保留旧快照 +
  节流告警。
- **热路径**：`Central._route` 只读当前快照，不感知 tokenhub。
- **落地对象**：正是中央 `Central.__init__` 已经在用的内存策略对象，接缝很小。
- **兜底默认**：中央的 `SQUILLA_*` env 仍是引导来源与 tokenhub 不可达时的默认。

---

## 6. 隐私与可追踪契约

- **明文只存在两处**：请求体（内部网传输，用后即弃）、客户端会话记录（端上）。
- **决策库无明文**：`decisions` 表没有文本列，只存字符数、flags、4 类概率、margin、
  `base→gated→final` 三段档位轨迹、最近锚点及相似度、嵌入向量、版本号、延迟。
- **decisionId 关联**：每次决策返回 `decisionId`，插件打进 debug 日志（与端上明文并排）。
  查问题四步：`/v1/stats` 看分布 → `/v1/decisions?sessionKey` 找 turn →
  `/v1/decisions/{id}` 看完整轨迹+锚点画像 → 需要原文则去端上日志 grep `decisionId`。

---

## 7. 失败模式与降级

| 失败点        | 行为                                        | 用户可见影响              |
| ------------- | ------------------------------------------- | ------------------------- |
| 中央超时/宕机 | 插件用粗略兜底（按长度/代码猜档），节流告警 | 路由变粗，不阻塞          |
| Embeddings 挂 | 中央用自己的启发式兜底，照常落库            | 客户端无感                |
| MySQL 挂      | 决策落库失败（路由本身仍返回）；需告警      | 轨迹缺失，路由可用        |
| tokenhub 挂   | 中央保留 last-known-good 策略快照           | 无（策略不更新而已）      |
| 会话档位丢失  | 下一轮自由重路由                            | 无（可能一次 cache miss） |

原则：路由链路上的每个外部依赖都必须能**优雅降级**，绝不让配置/中控/库的故障阻断出词。

---

## 8. 安全

- 中央接口用 `SQUILLA_CENTRAL_TOKEN` bearer 校验；插件用 `central.apiKey`。
- 中央拉 tokenhub 需鉴权（token 从环境/凭据注入，不写进仓库）。
- 不落明文、不打印密钥；MySQL 凭据走 `SQUILLA_MYSQL_*` env，不入库、不入日志。
- 模型标识符不写进 commit / 代码注释 / 文档产物。

---

## 9. 未来 / 替换 V4

`classify_semantic` 是单一替换接缝：把它换成 OpenSquilla 训练好的 V4 管线（BGE + LightGBM

- MLP ensemble），只要仍返回 `final_tier`，store / 轨迹 / 端点 / 通用协议全不动。通用协议
  保证客户端不会因为换算法而改代码。自学习靠 `/v1/feedback` 收点赞点踩 + 决策库里的嵌入向量。

---

## 10. 未决问题

1. tokenhub 的实际拉取 API 形状（路径、鉴权、返回信封）需对接后确认，才能落地中央侧
   `configSource`。
2. 中央策略包里下发 `anchors` 会改变分类行为，需要灰度 + 回滚流程（版本化已支持，流程待定）。
3. fleet 的档位→模型映射靠 `openclaw.json` 管理；大规模改动依赖外部配置管理/发布流程，
   不在本插件范围内。
