# SquillaRouter 智能路由：设计文档

本文档说明把 OpenSquilla 的智能模型路由移植进 OpenClaw 的整体设计：做了什么、
怎么做、架构与流程、触发机制（虚拟路由模型 id + profile）、以及中控（`tokenhub`）的边界。

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
能力搬到 OpenClaw，让选择了智能路由的会话每轮自动选档，既省成本又不牺牲难任务的质量。

约束（贯穿始终，不可回退）：

- **触发要显式**：OpenClaw 里模型很多，用户明确选了某个真实模型时**绝不劫持**。智能路由
  只在会话选中**虚拟路由模型 id** 时触发（见 §4）。
- **成本要真降**：换模型会丢掉 provider 侧 KV-cache，短续轮硬切「更便宜」的模型反而
  更贵，所以必须有 KV-cache 粘滞。
- **决策集中**：路由智能集中在中央一处，改策略一处生效，并能给自学习集中供料。
- **插件尽量薄**：插件里不放任何「路由智能」。它只做进程内必须做的事，加上中央宕机时
  的粗略兜底。
- **库不存明文**：接口可传原文（内部系统），但决策库**不落任何消息文本**，只存派生数据。
- **可追踪**：出问题能查，靠 `decisionId` 把「端上明文」和「中央无明文轨迹」关联起来。
- **协议通用**：中央的路由算法以后可能整体替换，客户端协议不能绑定某一种算法。

---

## 2. 演进历程

1. **启发式层移植（PoC）**：把 OpenSquilla 无依赖的规则层移到插件，验证端到端可行。
2. **KV-cache 粘滞**：`applySticky` —— 短续轮阻止下调档位（保住热缓存），升档放行。
3. **中央化**：路由智能全部搬到独立部署的**中央服务**（Python，
   `services/squilla_central/server.py`），插件退化为瘦客户端；接口传明文，库不存明文，
   每次返回 `decisionId`。中央算法是零训练锚点相似度（`classify_semantic`），预留为将来
   接入 V4 训练管线的替换接缝。
4. **MySQL + 通用协议**：决策库换成 MySQL（PyMySQL）；`/v1/route` 响应改为通用契约
   `{decisionId, tier, confidence, policyVersion, meta}`，算法专属细节收进不透明 `meta`。
5. **插件瘦身**：删掉插件里重复中央规则层的完整启发式，换成 ~10 行粗略兜底
   （`fallbackTier`）；客户端只读 `tier` + `decisionId`；插件配置全走 `openclaw.json`，
   tokenhub 只喂中央。
6. **虚拟 id 触发 + 多 profile**（本次）：
   - **触发门**：配置里的 `profiles` 以**虚拟路由模型 id** 为键（如 `squilla/auto`）。
     只有会话当前选中的模型命中某个键，本轮才路由；真实模型直通，插件不做任何事。
   - **多 profile**：可以配多个虚拟 id，每个带**自己的档位→模型表**和 `defaultTier`
     （例如 `squilla/auto` 走全档位省钱组合，`squilla/auto-max` 只在 c2/c3 强模型间选）。
   - **中央感知 profile**：`/v1/route` 请求增加 `profile` 字段（触发的虚拟 id）。中央把它
     落进决策轨迹（`decisions.profile` 列）并纳入 `/v1/stats` 聚合，后续可按 profile
     下发差异化策略。
   - **图片轮语义变化**：命中 profile 后插件**必须**覆盖（虚拟 id 无法真实解析），所以
     图片轮不再「放行」，而是路由到该 profile **最强的已配置档位**（最可能有视觉能力），
     且不请求中央（文本复杂度对视觉需求没有信息量）。

代码位置：

| 侧 | 文件 | 职责 |
|---|---|---|
| 插件 | `extensions/squilla-router/index.ts` | 触发门（`matchProfile`）、`before_model_resolve` 接线、图片处理、兜底、粘滞、落地覆盖 |
| 插件 | `extensions/squilla-router/central-client.ts` | 调 `/v1/route`（带 `profile`），只解析 `tier` + `decisionId`，失败即返回兜底信号 |
| 插件 | `extensions/squilla-router/router.ts` | `matchProfile`（触发门）、`fallbackTier`（粗略兜底）、`resolveRoute`（就近档位 + 粘滞）、配置解析 |
| 插件 | `extensions/squilla-router/session-store.ts` | 每会话上一轮档位（TTL 30min，LRU 上限 2000） |
| 中央 | `services/squilla_central/server.py` | 嵌入 → `classify_semantic` → 置信门/flag 升级 → 落库（含 profile 列）→ 响应；MySQL 存储 |

---

## 3. 触发机制：虚拟路由模型 id

**什么时候用智能路由？—— 用户选它的时候。**

- 运维在 `openclaw.json` 里定义若干**虚拟路由模型 id**（`profiles` 的键，形如
  `provider/modelId`）。它们不对应任何真实模型，只是路由的开关兼配置选择器。
- 用户/会话把模型切到某个虚拟 id（如 `squilla/auto`）即开启智能路由；切回任何真实模型
  即关闭。**真实模型的会话，插件一行逻辑都不执行**。
- 实现：`before_model_resolve` 钩子的 ctx 自带会话当前请求的
  `modelProviderId`/`modelId`（OpenClaw 核心已传，**零核心改动**）。`matchProfile` 先按
  `provider/modelId` 全名匹配，再按裸 modelId 匹配（OpenClaw 的 modelId 本身可能含 `/`）。
- 虚拟 id 在钩子里就被替换成真实模型，**永远到不了模型解析**——这也是为什么命中 profile
  后插件必须无条件给出覆盖（含图片轮、中央宕机时）。
- **多 profile 的用途**：不同虚拟 id 绑定不同的 4 档模型组合（省钱型/高质量型/合规型），
  同一网关同时提供；中央按 `profile` 字段区分统计与（未来）策略。

配置示例：

```json
{
  "profiles": {
    "squilla/auto": {
      "defaultTier": "c1",
      "tiers": {
        "c0": { "model": "deepseek/deepseek-v4-flash" },
        "c1": { "model": "deepseek/deepseek-v4-pro" },
        "c2": { "model": "z-ai/glm-5.2" },
        "c3": { "model": "z-ai/glm-5.2" }
      }
    },
    "squilla/auto-max": {
      "defaultTier": "c2",
      "tiers": {
        "c2": { "model": "z-ai/glm-5.2" },
        "c3": { "model": "z-ai/glm-5.2", "provider": "zai" }
      }
    }
  },
  "sticky": { "enabled": true, "maxUserLen": 200 },
  "central": { "url": "http://router-box:8710/v1/route", "tenantId": "team-a" }
}
```

---

## 4. 系统架构

见 [`design/architecture.drawio`](design/architecture.drawio)。

三个部署单元 + 一个中控：

- **OpenClaw 实例（可多实例 / fleet）**：`squilla-router` 插件。只保留四类事：
  - **触发门**：会话模型命中虚拟 id 才路由，否则直通；
  - 进程内必须做的：`before_model_resolve` 钩子拦截 + 返回 `modelOverride`；
  - 天然属于端上的：**per-profile 档位→模型映射**、**KV-cache 粘滞**、**图片→最强档**；
  - 中央宕机时的**粗略兜底**（按长度/代码猜档，不是中央规则层的副本）。
  - 明文只在会话记录（transcript）里，端上。
- **中央路由服务（Python）**：拥有一切「决策」。嵌入消息、语义分类、置信门、flag 升级、
  落库（含 profile）、返回抽象档位。`classify_semantic` 是唯一的算法替换接缝。
- **MySQL**：`decisions`（含 `profile` 列）/ `feedback` 两表，**无明文列**，位于隐私边界内。
- **Embeddings 服务**：任意 OpenAI 兼容端点（如 TEI + bge）。
- **tokenhub（中控）**：**只向中央服务**下发版本化策略配置；**不下发到插件**。详见 §6。

职责边界（与 OpenClaw 架构约束对齐）：

- 核心保持 plugin-agnostic，插件只通过 `openclaw/plugin-sdk/*` 的 `before_model_resolve`
  钩子接入；触发所需的会话模型信息（`ctx.modelProviderId`/`ctx.modelId`）是钩子上下文
  既有字段，无核心改动。
- **插件配置全部来自 `openclaw.json`**（profiles / sticky / central 端点），它也是兜底
  路径的唯一配置来源。插件不感知 tokenhub。
- 插件不在热路径做任何 freshness polling；配置是启动时读一次的静态值。

---

## 5. 单轮请求流程

见 [`design/request-flow.drawio`](design/request-flow.drawio)。

插件侧（`index.ts`）：

0. **触发门**：`matchProfile(ctx.modelProviderId, ctx.modelId)` 未命中 → 直接返回，
   本轮与本插件无关。命中 → 取该 profile，且**此后必须返回覆盖**。
1. **图片轮**：含图片附件 → 不请求中央，直接取 profile 最强已配置档（最可能有视觉能力）。
2. **中央优先**（非图片轮）：`routeRemote` POST `/v1/route`（明文 + `profile`，内部网），
   拿回 `tier` + `decisionId`。
3. **粗略兜底**：中央失败/超时 → `fallbackTier(prompt, attachmentCount, profile.defaultTier)`：
   很长→c3；有代码块/附件/较长→c2；很短→c0；其余→profile 的 `defaultTier`。
   （含节流告警，一分钟一条。）
4. **落地**：`resolveRoute(profile, sticky, tier)` —— 就近取该 profile 的配置档位
   （缺档优先向上，不静默降级）+ 粘滞。
5. **粘滞**：`applySticky` —— 短续轮阻止下调（保 KV-cache），升档放行。
6. **记账**：`SessionTierStore.set` 记本轮档位；debug 日志带 `profile`、`source`
   （central/fallback）与 `decisionId`（与端上明文并排）。
7. 返回 `{modelOverride, providerOverride?}`。

中央侧（`server.py` `Central._route`）：

读 `profile`（自由字符串，协议保持通用）→ 嵌入消息 → `classify_semantic`（锚点余弦 +
margin 升级 + 欠路由安全网）→ 置信度门 → flag 升级 → `final_tier` → **落库（无明文，
含 profile 列）** → 返回 `{decisionId, tier, confidence, policyVersion, meta}`。
embedding 失败时中央侧还有启发式兜底，照常落库，所以插件只有在**中央本身宕机**时才用
它那份粗略兜底。

---

## 6. 中控（tokenhub）—— 只喂中央，边界很窄

### 6.1 结论

**中控只做一件事：向中央服务下发版本化的路由策略配置。** 它不参与单轮决策，永不进热路径，
也**不下发任何东西到插件**。插件配置（含 profiles）一律走 `openclaw.json`。

### 6.2 为什么这么收

| 关注点 | 处理 |
|---|---|
| 中央策略要能灰度/回滚（置信阈值、锚点、margin/安全网、默认档） | tokenhub 下发版本化策略包给中央，可灰度、可回滚 |
| 决策可复现 | 决策轨迹记 `policyVersion`，能回放某次路由用的是哪版策略 |
| 插件配置（profiles、sticky、central 端点） | 走 `openclaw.json`，由运维按实例管理；**不经 tokenhub** |
| 新增运行时依赖必须能容忍它挂 | 中央对 tokenhub **fail-open**：拉不到就用 last-known-good |
| 不能进热路径 | 中央后台定时刷新 + **单槽快照**；`_route` 只读快照，绝不 per-turn 拉取 |

> 明确的取舍：因为 tokenhub 不下发到插件，**改 fleet 的 profile/模型映射要逐个改
> `openclaw.json`**。这是刻意的——插件侧保持零外部配置依赖、启动即定，换来更简单、更可预测
> 的端上行为；需要集中改时用配置管理/发布流程推 `openclaw.json`。

### 6.3 tokenhub 下发的策略包（只给中央）

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

决策轨迹里的 `profile` 列让「按 profile 下发差异化策略」成为顺理成章的下一步：策略包
可以从全局一份演进为按 profile 键控的多份，中央按请求的 `profile` 取对应策略，协议与
插件都不用动。

### 6.4 集成方式（只在中央侧）

- 中央加一个 `configSource`（通用 HTTP 拉取器）：`GET <tokenhub>/config/policy?tenant=...`
  返回 `{version, payload}`。tokenhub 只是它的 URL/传输，与 tokenhub 私有 API 解耦。
- **刷新**：后台定时（如 30s）拉取 → 校验 → 通过则原子替换单槽快照；失败保留旧快照 +
  节流告警。
- **热路径**：`Central._route` 只读当前快照，不感知 tokenhub。
- **兜底默认**：中央的 `SQUILLA_*` env 仍是引导来源与 tokenhub 不可达时的默认。

---

## 7. 隐私与可追踪契约

- **明文只存在两处**：请求体（内部网传输，用后即弃）、客户端会话记录（端上）。
- **决策库无明文**：`decisions` 表没有文本列，只存 profile、字符数、flags、4 类概率、
  margin、`base→gated→final` 三段档位轨迹、最近锚点及相似度、嵌入向量、版本号、延迟。
- **decisionId 关联**：每次决策返回 `decisionId`，插件打进 debug 日志（与端上明文并排）。
  查问题四步：`/v1/stats` 看分布（档位/band/**profile**/评分）→
  `/v1/decisions?sessionKey` 找 turn → `/v1/decisions/{id}` 看完整轨迹+锚点画像 →
  需要原文则去端上日志 grep `decisionId`。

---

## 8. 失败模式与降级

| 失败点 | 行为 | 用户可见影响 |
|---|---|---|
| 中央超时/宕机 | 插件用粗略兜底（按长度/代码猜档），节流告警 | 路由变粗，不阻塞 |
| Embeddings 挂 | 中央用自己的启发式兜底，照常落库 | 客户端无感 |
| MySQL 挂 | 决策落库失败（路由本身仍返回）；需告警 | 轨迹缺失，路由可用 |
| tokenhub 挂 | 中央保留 last-known-good 策略快照 | 无（策略不更新而已） |
| 会话档位丢失 | 下一轮自由重路由 | 无（可能一次 cache miss） |
| 配置了虚拟 id 但插件禁用/无 profile | 虚拟 id 走正常模型解析并报错 | 运维配置错误，启动日志有告警 |

原则：路由链路上的每个外部依赖都必须能**优雅降级**，绝不让配置/中控/库的故障阻断出词。
唯一的例外是最后一行：虚拟 id 本身依赖插件存活，这是触发机制的固有耦合，靠启动告警兜底。

---

## 9. 安全

- 中央接口用 `SQUILLA_CENTRAL_TOKEN` bearer 校验；插件用 `central.apiKey`。
- 中央拉 tokenhub 需鉴权（token 从环境/凭据注入，不写进仓库）。
- 不落明文、不打印密钥；MySQL 凭据走 `SQUILLA_MYSQL_*` env，不入库、不入日志。
- 模型标识符不写进 commit / 代码注释 / 文档产物。

---

## 10. 未来 / 替换 V4

`classify_semantic` 是单一替换接缝：把它换成 OpenSquilla 训练好的 V4 管线（BGE + LightGBM
+ MLP ensemble），只要仍返回 `final_tier`，store / 轨迹 / 端点 / 通用协议全不动。通用协议
保证客户端不会因为换算法而改代码。自学习靠 `/v1/feedback` 收点赞点踩 + 决策库里的嵌入
向量；`profile` 列让按 profile 的效果对比与差异化策略成为可能。

---

## 11. 未决问题

1. tokenhub 的实际拉取 API 形状（路径、鉴权、返回信封）需对接后确认，才能落地中央侧
   `configSource`。
2. 中央策略包里下发 `anchors` 会改变分类行为，需要灰度 + 回滚流程（版本化已支持，流程待定）。
3. 虚拟路由模型 id 目前只对直接设置会话模型的路径生效；若要出现在模型选择 UI/目录里，
   需要评估是否给插件加一个轻量 provider/catalog 声明（当前刻意不做，保持插件面最小）。
4. per-profile 策略下发（tokenhub 策略包按 profile 键控）是自然演进，待有真实差异化需求
   再做。
