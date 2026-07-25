# SquillaRouter 智能路由：设计文档

本文档说明把 OpenSquilla 的智能模型路由移植进 OpenClaw 的整体设计：做了什么、
怎么做、架构与流程、触发机制（虚拟路由模型 id + profile）、中央算法（**真实 V4 Phase 3
管线**）、以及中控（`tokenhub`）的边界。

**当前边界（本次重构后）：插件是纯透传客户端，零判定逻辑；一切启发式判断——包括
KV-cache 粘滞——都在中央服务；只有中央调不通时，插件才用 profile 的默认档。**

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
  只在会话选中**虚拟路由模型 id** 时触发（见 §3）。
- **成本要真降**：换模型会丢掉 provider 侧 KV-cache，短续轮硬切「更便宜」的模型反而
  更贵，所以必须有 KV-cache 粘滞——但粘滞现在由**中央**执行（见 §4.5）。
- **决策集中**：路由智能集中在中央一处，改策略一处生效，并能给自学习集中供料。
- **插件零判定**：插件不做任何路由判断。它只负责触发门、把这轮的事实报给中央、把返回的
  档位查表落地；中央不可达时服务该 profile 的默认档。
- **库不存明文**：接口可传原文（内部系统），但决策库**不落任何消息文本**，只存派生数据。
- **可追踪**：出问题能查，靠 `decisionId` 把「端上明文」和「中央无明文轨迹」关联起来。
- **协议通用**：中央算法可整体替换，客户端协议只认抽象档位 + decisionId，不绑定算法。

---

## 2. 演进历程

1. **启发式层移植（PoC）**：把 OpenSquilla 无依赖的规则层移到插件，验证端到端可行。
2. **KV-cache 粘滞**：短续轮阻止下调档位（保住热缓存），升档放行。
3. **中央化**：路由智能搬到独立部署的**中央服务**（Python，`services/squilla_central/server.py`），
   插件退化为瘦客户端；接口传明文，库不存明文，每次返回 `decisionId`。
4. **MySQL + 通用协议**：决策库换成 MySQL（PyMySQL）；`/v1/route` 响应改为通用契约
   `{decisionId, tier, confidence, policyVersion, meta}`，算法专属细节收进不透明 `meta`。
5. **插件瘦身（第一轮）**：删掉插件里重复中央规则层的完整启发式，换成粗略兜底；客户端只读
   `tier` + `decisionId`；插件配置全走 `openclaw.json`。
6. **虚拟 id 触发 + 多 profile**：`profiles` 以虚拟路由模型 id 为键，命中才路由；每个
   profile 带自己的档位→模型表；中央感知 `profile`（决策轨迹 + stats）。
7. **完整移植真实 V4 Phase 3**：中央的分类器从「零训练锚点相似度」占位换成 **OpenSquilla
   训练好的 V4 Phase 3 集成模型**（BGE-ONNX + LightGBM + MLP，经 `V4Phase3Strategy`）。
   删掉外部 embedding 端点与锚点占位；BGE 改为 bundle 内 ONNX 进程内推理。
8. **插件纯透传（本次）**：把插件里**剩下的全部判定**——档位就近（snap）、图片轮处理、
   KV-cache 粘滞、粗略兜底猜档——统统搬到中央。插件删掉 `session-store.ts`、
   `applySticky`、`fallbackTier`、`resolveRoute`；请求体新增 `availableTiers` 与
   `hasImage`。中央粘滞的「上一轮档位」从决策库读（`idx_decisions_session`），多实例/
   重启都正确。**通用协议形状不变。**

代码位置：

| 侧 | 文件 | 职责 |
|---|---|---|
| 插件 | `extensions/squilla-router/index.ts` | 触发门 → 调中央 → 查表落地覆盖；失败时用 `defaultTier` |
| 插件 | `extensions/squilla-router/central-client.ts` | 调 `/v1/route`（带 `profile`/`availableTiers`/`hasImage`），只解析 `tier` + `decisionId` |
| 插件 | `extensions/squilla-router/router.ts` | `matchProfile`、`availableTiers`、`targetForTier`、配置解析 |
| 中央 | `services/squilla_central/server.py` | 分类（V4Classifier / 启发式兜底）→ snap → 粘滞 → 落库 → 通用响应；MySQL 存储 |
| 中央算法 | `opensquilla/squilla_router/v4_phase3.py` + `models/v4.2_phase3_inference/**` | 真实 V4：390 维特征 + LGBM+MLP 集成 + 校准 + 后处理（含 LFS 权重 bundle） |

第 8 步之后，插件侧仅剩三个纯函数：`matchProfile`（触发门）、`availableTiers`（把配置的
档位列表报给中央）、`targetForTier`（档位→模型查表）。没有一个包含路由判断。

---

## 3. 触发机制：虚拟路由模型 id

**什么时候用智能路由？—— 用户选它的时候。**

- 运维在 `openclaw.json` 里定义若干**虚拟路由模型 id**（`profiles` 的键，形如
  `provider/modelId`）。它们不对应任何真实模型，只是路由的开关兼配置选择器。
- 会话把模型切到某个虚拟 id（如 `squilla/auto`）即开启智能路由；切回任何真实模型即关闭。
  **真实模型的会话，插件一行逻辑都不执行**。
- 实现：`before_model_resolve` 钩子 ctx 自带会话当前请求的 `modelProviderId`/`modelId`
  （OpenClaw 核心已传，**零核心改动**）。`matchProfile` 先按 `provider/modelId` 全名匹配，
  再按裸 modelId 匹配（OpenClaw 的 modelId 本身可能含 `/`）。
- 虚拟 id 在钩子里就被替换成真实模型，**永远到不了模型解析**——所以命中 profile 后插件
  必须无条件给出覆盖（含中央宕机时）。
- **多 profile**：不同虚拟 id 绑定不同的 4 档模型组合（省钱型/高质量型/合规型），同一网关
  同时提供；中央按 `profile` 字段区分统计与（未来）策略。

配置示例（`openclaw.json` 里插件配置位于 `plugins.entries.<pluginId>.config`，`pluginId`
即 `openclaw.plugin.json` 的 `id`；`config` 下的字段由插件 `configSchema` 定义）：

```json
{
  "plugins": {
    "entries": {
      "squilla-router": {
        "config": {
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
          "central": {
            "url": "http://router-box:8710/v1/route",
            "tenantId": "team-a",
            "apiKey": "sk-...",
            "timeoutMs": 2000
          }
        }
      }
    }
  }
}
```

注意配置里**已经没有 `sticky` 块**：粘滞归中央，用中央的 `SQUILLA_STICKY*` 环境变量控制。
`defaultTier` 在启动时被钉到该 profile 真正配置了的档位上（优先取等于或更强的，绝不静默
降级），运行期不再做任何就近计算。

---

## 4. 中央算法：真实 V4 Phase 3 管线 + 全部判定

中央的分类器是 OpenSquilla 训练好的 V4 Phase 3 集成模型（经适配器 `V4Phase3Strategy`
调用其 `InferenceCore`）。中央服务里 `classifier` 是唯一分类接缝：生产是 `V4Classifier`，
测试注入 fake，`None` 则退到无依赖启发式。

### 4.1 一次预测的内部流程（`InferenceCore.predict`）

```
消息 →① 390 维特征装配 →② 两个头各自打分 →③ 概率融合 →④ 后处理 → route_class(R0-R3) → tier(c0-c3)
```

**① 390 维特征**（`inference/features.py` 拼 8 段）：

| 区间 | 通道 | 维数 | 来源 |
|---|---|---|---|
| `[0:51]` | HC 手工特征 | 51 | 当前消息的计数类信号（长度/代码块/标点/关键词） |
| `[51:153]` | TF-IDF + SVD | 102 | TF-IDF → SVD 降维，零填充到 102 |
| `[153:163]` | context | 10 | 请求上下文元数据 |
| `[163:179]` | history 统计 | 16 | 上几轮路由决策统计 |
| `[179:243]` | BGE 当前用户 | 64 | 当前消息 BGE embedding，PCA→64 |
| `[243:307]` | BGE 历史用户 | 64 | 历史用户消息 BGE，PCA→64 |
| `[307:371]` | BGE 上轮助手 | 64 | 上轮助手回复 BGE，PCA→64 |
| `[371:383]` | 助手 HC | 12 | 上轮助手信号（拒答/追问/用量） |
| `[383:385]` | continuation | 2 | 短续接线索 |
| `[385:390]` | reasoning | 5 | 推理密集线索 |

BGE 走 **bundle 内的 ONNX 模型**进程内推理（不再需要外部 embedding 端点）。

**② 两个头**（`inference/heads.py`）：LightGBM 主模型（+可选 aux）出一组类别概率；MLP
（ONNX）出 logits，经温度/校准得另一组概率。
**③ 融合**（`ensemble.py`）：按 per-class alpha 加权融合两个头的概率。
**④ 后处理**（`postprocess.py`）：margin/难度/flag/sticky 等规则，产出最终 `route_class`
（R0-R3）、`difficulty`、`margin`、`flags`。适配器把 R0-R3 映射到 c0-c3（1:1）。

### 4.2 我们只喂当前轮

中央决策库不存明文，也就没有会话历史可喂给 V4 的历史通道（上轮用户/助手文本、路由历史）。
因此这些通道（约 163/390 维）为空——即 V4 处理「首轮」时的特征质量。**这是刻意的隐私取舍**：
换取「明文只存在于请求体（用后即弃）」的干净契约。若将来要补历史特征，需要中央持有短时的
per-session 明文环（内存、不落库、TTL），是可选增强，非本次范围。

### 4.3 BGE 固定进程内 ONNX（否决外部 emb）

- **BGE 就在 bundle 内、进程内跑 ONNX，纯 CPU**（`bge_onnx.py` 硬编码
  `CPUExecutionProvider`，取 CLS + L2 归一，512 维）。bge-small INT8 对单条短消息编码
  在 CPU 上是毫秒级、低 QPS 够用，**不需要也未启用 GPU**。
- **不接外部 embedding 端点**（曾评估、明确否决）：训练好的 PCA（512→64）和 LGBM/MLP 头是
  **焊死在这个 INT8 BGE 输出空间上**的（`feature_schema_version` 对这几个产物取哈希防漂移）。
  所以 BGE 不是可替换的「通用 embedding 服务」，而是模型的第一层。换外部端点只有两种结果：
  要么端点必须是**同一个模型**（收益仅是把已经很快的 CPU 编码挪到另一台机器，却凭空多一跳
  网络和一个故障面，还要严守逐位一致契约），要么是**不同模型**——那会让向量落在分布外、
  PCA+头静默失效、选档乱掉。两者都不值当，故完整移植就用进程内 ONNX，简单且正确。

### 4.4 分类之后：snap（缺档向上）

客户端 profile 可能只配了 c0-c3 的一个子集。请求体里的 `availableTiers` 就是「这个 profile
真正能服务的档位」，中央用 `snap_to_available` 把模型选出的档位落到其中：**同档优先 → 向上
找 → 都没有才向下**。向上优先是为了「缺档不静默降级」——宁可贵一点，也不要因为运维少配了
一档就把一个难任务悄悄发给弱模型。

snap 放在中央而不是插件，是因为插件必须零判定：这样落库的 `final_tier` 就是真正服务的档位。

### 4.5 KV-cache 粘滞（`apply_sticky`）

换模型会丢掉 provider 侧的 prompt cache，短续轮切到「更便宜」的模型往往**更贵**（整个上下文
要重新未命中地付一遍）。所以：**短续轮（`len(message) <= maxUserLen`，默认 200）不允许比
上一轮更低的档位**；升档放行（升档同样炸缓存，但真变难的一轮值得）。

- 「上一轮档位」不再来自插件进程内存，而是 `MySqlStore.last_tier()`——按
  `idx_decisions_session` 取该 `(tenant, sessionKey)` 最新一条的 `final_tier`。这样多实例
  部署、进程重启、会话在不同 OpenClaw 实例间漂移，粘滞都仍然正确。
- 开关：`SQUILLA_STICKY`（默认开）、`SQUILLA_STICKY_MAX_USER_LEN`（默认 200）。
- 记录：`stuck` 列标记本轮是否被粘滞按住；`classifier_tier` 保留模型自己的选择做诊断。

### 4.6 图片轮

插件报 `hasImage`，中央决定：图片轮**跳过文本分类器**（文本复杂度说明不了视觉需求），直接
服务 `availableTiers` 里最强的一档（最可能有视觉能力），band 记为 `image`。

### 4.7 降级与部署要求

- **降级**：V4 bundle/依赖不可用时，中央退到无依赖的 band 启发式（`classify_heuristic`），
  snap 与粘滞照常执行，路由照常应答。`SQUILLA_V4=0` 可强制启发式。
- **部署**：V4 路径需要 `opensquilla[recommended]`（numpy / lightgbm / onnxruntime /
  scikit-learn / joblib）+ Git-LFS 模型 bundle（`git lfs pull`，权重约 lgbm 40MB、
  BGE-ONNX 24MB）。`PYTHONPATH=src` 让服务能 import opensquilla 包。
- **自学习**：`/v1/feedback` 收点赞点踩；V4 可 opt-in 输出它实际消费的 390 维特征做离线
  重训（`feature_schema_version` 保证只和同一特征基的样本混训）。

### 4.8 纯透传对自学习的意义

插件透传之前，中央落库的是「中央想要的档位」，而端上可能再 snap/粘滞一次——落库档位与
**实际服务的模型**可能不一致，训练标签因此带噪。现在客户端逐字应用返回值，于是：

- `decisions.final_tier` == 实际服务的档位 → 可直接作训练标签；
- `decisions.classifier_tier` == 模型自己的选择 → 做诊断与「后处理改了多少」的度量；
- `stuck` 标出被粘滞按住的轮次 → 这些轮的档位不是模型判断的结果，训练取样时可据此筛除。

---

## 5. 系统架构

见 [`design/architecture.drawio`](design/architecture.drawio)。

三个部署单元 + 一个中控：

- **OpenClaw 实例（fleet）**：`squilla-router` 插件（**纯透传**）。只有触发门、把
  `availableTiers`/`hasImage` 报上去、档位→模型查表、进程内覆盖。明文只在端上 transcript。
- **中央路由服务（Python）**：拥有一切决策。`V4Classifier`（真实 V4 集成模型，含 bundle 内
  BGE-ONNX）→ snap → KV-cache 粘滞 → 落库 → 返回抽象档位；分类器不可用时退启发式。
- **MySQL**：`decisions`（含 `profile` / `classifier_tier` / `stuck` 列）/ `feedback`，
  **无明文列**，位于隐私边界内；同时是粘滞的「上一轮档位」来源。
- **V4 模型 bundle**：`models/v4.2_phase3_inference/`（LGBM/MLP-ONNX/BGE-ONNX/PCA/TFIDF/SVD，
  Git LFS），随中央服务部署在同一台机器，进程内加载。
- **tokenhub（中控）**：**只向中央服务**下发版本化策略配置；**不下发到插件**。详见 §7。

---

## 6. 单轮请求流程

见 [`design/request-flow.drawio`](design/request-flow.drawio)。

插件侧（`index.ts`，全流程无一处判断路由该选哪档）：

0. **触发门**：`matchProfile(ctx.modelProviderId, ctx.modelId)` 未命中 → 直接返回。命中 →
   取该 profile，此后必须返回覆盖。
1. **调中央**：`routeRemote` POST `/v1/route`，带 `{tenantId, sessionKey, profile, message,
   attachmentCount, hasImage, availableTiers}`；拿回 `tier` + `decisionId`。
2. **失败即默认档**：中央缺配置/超时/报错 → `tier = profile.defaultTier`，节流告警。
3. **查表落地**：`targetForTier(profile, tier)` —— 纯查表（中央已保证档位可服务）。
4. **记账**：debug 日志带 `profile`、`source`、`tier`、`decisionId`。
5. 返回 `{modelOverride, providerOverride?}`。

中央侧（`server.py` `Central._route`）：

1. 读 `hasImage` / `availableTiers`（缺省视为全 4 档）。
2. **图片轮** → `bypass_outcome(最强可用档, "image")`；否则 `classifier.classify(message)`；
   分类器为 None → `classify_heuristic`。
3. **snap**：`snap_to_available(final_tier, available)`（缺档向上，不静默降级）。
4. **粘滞**：`last_tier = store.last_tier(tenant, session)` → `apply_sticky(desired,
   last_tier, len(message), sticky)`。
5. **落库（无明文）**：`final_tier` 记真正服务的档，另存 `classifier_tier` + `stuck`。
6. **返回** `{decisionId, tier, confidence, policyVersion, meta}`，meta 含 routeClass /
   band / flags / margin / difficulty / `classifierTier` / `stuck`。

---

## 7. 中控（tokenhub）—— 只喂中央，边界很窄

**中控只做一件事：向中央服务下发版本化的路由策略配置。** 不参与单轮决策，永不进热路径，
也**不下发任何东西到插件**。插件配置一律走 `openclaw.json`。中央对 tokenhub **fail-open**
（拉不到就用 last-known-good），后台定时刷新 + 单槽快照，`_route` 只读快照。决策轨迹记
`policyVersion`，可复现/可回滚。V4 落地后，「策略」自然从锚点/阈值演进为「模型 bundle 版本 +
后处理阈值 + 粘滞参数」；bundle 本身较大，走部署发布而非 tokenhub 热下发，tokenhub 只下发
轻量后处理/阈值/粘滞/默认档参数。详见
[`design/config-distribution.drawio`](design/config-distribution.drawio)。

> 取舍：tokenhub 不下发到插件，改 fleet 的 profile/模型映射要逐个改 `openclaw.json`——刻意
> 保持插件侧零外部配置依赖、启动即定；集中改用配置管理/发布流程推 `openclaw.json`。
> 好处是「热改的东西」（策略、阈值、粘滞）与「冷改的东西」（哪个虚拟 id 对应哪些真实模型）
> 各有一个明确的所有者，互不重叠。

---

## 8. 隐私与可追踪契约

- **明文只存在两处**：请求体（内部网传输，用后即弃）、客户端会话记录（端上）。
- **决策库无明文**：`decisions` 表没有文本列，只存 profile、字符数、flags、4 类概率、
  margin、`base→gated→final` 档位轨迹、`classifier_tier`/`stuck`、route_class/difficulty、
  版本号、延迟。
- **decisionId 关联**：每次决策返回 `decisionId`，插件打进 debug 日志（与端上明文并排）。
  查问题四步：`/v1/stats` 看分布（档位/band/**profile**/评分）→
  `/v1/decisions?sessionKey` 找 turn → `/v1/decisions/{id}` 看完整轨迹（含
  `classifierTier` vs `finalTier` 与 `stuck`，一眼看出是模型选的还是被粘滞按住的）→
  需要原文则去端上日志 grep `decisionId`。

---

## 9. 失败模式与降级

| 失败点 | 行为 | 用户可见影响 |
|---|---|---|
| 中央超时/宕机 | 插件服务 profile 的 `defaultTier`，节流告警 | 该 profile 退化为单一固定档，不阻塞 |
| V4 bundle/依赖不可用 | 中央退无依赖 band 启发式；snap/粘滞照常 | 路由变粗，客户端无感 |
| MySQL 挂 | 决策落库失败（路由本身仍返回）；粘滞读不到上一轮 → 不粘滞 | 轨迹缺失，路由可用，可能多一次 cache miss |
| tokenhub 挂 | 中央保留 last-known-good 策略快照 | 无 |
| 会话首轮 / 无历史 | `last_tier` 为空 → 不粘滞，自由路由 | 无 |
| 完全没配 `central` | 每轮都走 `defaultTier`（等价于把虚拟 id 钉死成一个模型），启动日志告警 | 智能路由静默失效，属运维配置错误 |
| 配置了虚拟 id 但插件禁用/无 profile | 虚拟 id 走正常模型解析并报错 | 运维配置错误，启动日志有告警 |

原则：路由链路上每个外部依赖都必须能**优雅降级**，绝不让配置/中控/库/模型的故障阻断出词。
注意插件侧的降级现在是**一个常量**（`defaultTier`），不是一套本地猜测规则——本地猜测就是
判定逻辑，而判定逻辑只允许有一个所有者。

---

## 10. 安全

- 中央接口用 `SQUILLA_CENTRAL_TOKEN` bearer 校验；插件用 `central.apiKey`。
- 中央拉 tokenhub 需鉴权（token 从环境/凭据注入，不写进仓库）。
- 不落明文、不打印密钥；MySQL 凭据走 `SQUILLA_MYSQL_*` env，不入库、不入日志。
- 模型标识符不写进 commit / 代码注释 / 文档产物。

---

## 11. 未决问题

1. tokenhub 的实际拉取 API 形状（路径、鉴权、返回信封）需对接后确认，才能落地中央侧
   `configSource`。
2. V4 历史通道目前为空（中央不持有明文历史）。若要补，需设计内存-only、TTL、不落库的
   per-session 明文环，或改由端上在另一个钩子提供历史——权衡隐私 vs 特征完整性。
3. V4 模型 bundle 走 Git LFS + 部署发布；本沙箱无法拉权重/装 ML 依赖，故真实 V4 推理为
   **部署验证**，代码用注入 fake 分类器 + 启发式兜底路径覆盖，并已验证「LFS 指针 → 降级」。
4. fleet 的 profile→模型映射靠 `openclaw.json`；大规模改动依赖外部配置管理/发布流程。
5. 粘滞每轮多一次 `last_tier` 查询（走 `idx_decisions_session` 的单行索引查询）。目前
   规模下可忽略；若 QPS 上来，可在中央加**进程内单槽 session→tier 缓存**（有明确所有者与
   TTL），而不是把状态退回插件。
