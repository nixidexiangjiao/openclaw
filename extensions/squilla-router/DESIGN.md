# SquillaRouter 智能路由：设计文档

本文档说明把 OpenSquilla 的智能模型路由移植进 OpenClaw 的整体设计：做了什么、
怎么做、架构与流程、触发机制（虚拟路由模型 id + profile）、中央算法（**真实 V4 Phase 3
管线**）、以及中控（`tokenhub`）的边界。

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
  更贵，所以必须有 KV-cache 粘滞。
- **决策集中**：路由智能集中在中央一处，改策略一处生效，并能给自学习集中供料。
- **插件尽量薄**：插件里不放任何「路由智能」。它只做进程内必须做的事，加上中央宕机时
  的粗略兜底。
- **库不存明文**：接口可传原文（内部系统），但决策库**不落任何消息文本**，只存派生数据。
- **可追踪**：出问题能查，靠 `decisionId` 把「端上明文」和「中央无明文轨迹」关联起来。
- **协议通用**：中央算法可整体替换，客户端协议只认抽象档位 + decisionId，不绑定算法。

---

## 2. 演进历程

1. **启发式层移植（PoC）**：把 OpenSquilla 无依赖的规则层移到插件，验证端到端可行。
2. **KV-cache 粘滞**：`applySticky` —— 短续轮阻止下调档位（保住热缓存），升档放行。
3. **中央化**：路由智能搬到独立部署的**中央服务**（Python，`services/squilla_central/server.py`），
   插件退化为瘦客户端；接口传明文，库不存明文，每次返回 `decisionId`。
4. **MySQL + 通用协议**：决策库换成 MySQL（PyMySQL）；`/v1/route` 响应改为通用契约
   `{decisionId, tier, confidence, policyVersion, meta}`，算法专属细节收进不透明 `meta`。
5. **插件瘦身**：删掉插件里重复中央规则层的完整启发式，换成 ~10 行粗略兜底
   （`fallbackTier`）；客户端只读 `tier` + `decisionId`；插件配置全走 `openclaw.json`。
6. **虚拟 id 触发 + 多 profile**：`profiles` 以虚拟路由模型 id 为键，命中才路由；每个
   profile 带自己的档位→模型表；中央感知 `profile`（决策轨迹 + stats）。
7. **完整移植真实 V4 Phase 3**（本次）：中央的分类器从「零训练锚点相似度」占位换成
   **OpenSquilla 训练好的 V4 Phase 3 集成模型**（BGE-ONNX + LightGBM + MLP，经
   `V4Phase3Strategy`）。删掉外部 embedding 端点与锚点占位；BGE 改为 bundle 内 ONNX
   进程内推理。模型不可用（LFS 未拉 / 依赖缺失）时降级到无依赖的启发式，路由照常应答。
   **通用协议不变，插件零改动。**

代码位置：

| 侧 | 文件 | 职责 |
|---|---|---|
| 插件 | `extensions/squilla-router/index.ts` | 触发门（`matchProfile`）、`before_model_resolve` 接线、图片处理、兜底、粘滞、落地覆盖 |
| 插件 | `extensions/squilla-router/central-client.ts` | 调 `/v1/route`（带 `profile`），只解析 `tier` + `decisionId` |
| 插件 | `extensions/squilla-router/router.ts` | `matchProfile`、`fallbackTier`、`resolveRoute`、配置解析 |
| 插件 | `extensions/squilla-router/session-store.ts` | 每会话上一轮档位（TTL 30min，LRU 上限 2000） |
| 中央 | `services/squilla_central/server.py` | `classifier`（V4Classifier / 启发式兜底）→ 落库 → 通用响应；MySQL 存储 |
| 中央算法 | `opensquilla/squilla_router/v4_phase3.py` + `models/v4.2_phase3_inference/**` | 真实 V4：390 维特征 + LGBM+MLP 集成 + 校准 + 后处理（含 LFS 权重 bundle） |

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
  必须无条件给出覆盖（含图片轮、中央宕机时）。
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
          "sticky": { "enabled": true, "maxUserLen": 200 },
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

---

## 4. 中央算法：真实 V4 Phase 3 管线

中央的分类器现在是 OpenSquilla 训练好的 V4 Phase 3 集成模型（经适配器 `V4Phase3Strategy`
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
换取「明文只存在于请求体（用后即弃）」的干净契约。KV-cache 粘滞由端上单独处理，不依赖这些
历史特征。若将来要补历史特征，需要中央持有短时的 per-session 明文环（内存、不落库、TTL），
是可选增强，非本次范围。

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
  （真要换更好的 embedding，只能重训整条 V4 管线，属 OpenSquilla 离线训练任务。）

### 4.4 降级与部署要求

- **降级**：V4 bundle/依赖不可用时，中央退到无依赖的 band 启发式（`classify_heuristic`，
  与插件端兜底同源），路由照常应答。`SQUILLA_V4=0` 可强制启发式。
- **部署**：V4 路径需要 `opensquilla[recommended]`（numpy / lightgbm / onnxruntime /
  scikit-learn / joblib）+ Git-LFS 模型 bundle（`git lfs pull`，权重约 lgbm 40MB、
  BGE-ONNX 24MB）。`PYTHONPATH=src` 让服务能 import opensquilla 包。
- **自学习**：`/v1/feedback` 收点赞点踩；V4 可 opt-in 输出它实际消费的 390 维特征做离线
  重训（`feature_schema_version` 保证只和同一特征基的样本混训）。

---

## 5. 系统架构

见 [`design/architecture.drawio`](design/architecture.drawio)。

三个部署单元 + 一个中控：

- **OpenClaw 实例（fleet）**：`squilla-router` 插件（瘦客户端）。触发门、进程内覆盖、
  per-profile 档位→模型映射、KV-cache 粘滞、图片→最强档、粗略兜底。明文只在端上 transcript。
- **中央路由服务（Python）**：拥有一切决策。`V4Classifier`（真实 V4 集成模型，含 bundle 内
  BGE-ONNX）→ 落库 → 返回抽象档位；不可用时退启发式。
- **MySQL**：`decisions`（含 `profile` 列）/ `feedback`，**无明文列**，位于隐私边界内。
- **V4 模型 bundle**：`models/v4.2_phase3_inference/`（LGBM/MLP-ONNX/BGE-ONNX/PCA/TFIDF/SVD，
  Git LFS），随中央服务部署在同一台机器，进程内加载。
- **tokenhub（中控）**：**只向中央服务**下发版本化策略配置；**不下发到插件**。详见 §7。

> 注意：不再有独立的「外部 Embeddings 服务」——BGE 已在 V4 bundle 内以 ONNX 进程内运行。

---

## 6. 单轮请求流程

见 [`design/request-flow.drawio`](design/request-flow.drawio)。

插件侧（`index.ts`）：

0. **触发门**：`matchProfile(ctx.modelProviderId, ctx.modelId)` 未命中 → 直接返回。命中 →
   取该 profile，此后必须返回覆盖。
1. **图片轮**：含图片附件 → 不请求中央，取 profile 最强已配置档（最可能有视觉能力）。
2. **中央优先**（非图片轮）：`routeRemote` POST `/v1/route`（明文 + `profile`），拿回
   `tier` + `decisionId`。
3. **粗略兜底**：中央失败/超时 → `fallbackTier(...)`（长度/代码猜档，中段用 profile 的
   `defaultTier`）。
4. **落地**：`resolveRoute(profile, sticky, tier)` —— 就近取该 profile 的配置档位
   （缺档优先向上，不静默降级）+ 粘滞。
5. **粘滞**：`applySticky` —— 短续轮阻止下调（保 KV-cache），升档放行。
6. **记账**：`SessionTierStore.set`；debug 日志带 `profile`、`source`、`decisionId`。
7. 返回 `{modelOverride, providerOverride?}`。

中央侧（`server.py` `Central._route`）：

`classifier.classify(message)` → V4 predict（§4.1）→ `final_tier` + probabilities + margin +
route_class + difficulty → **落库（无明文，含 profile）** → 返回
`{decisionId, tier, confidence, policyVersion, meta}`（meta 含 routeClass/difficulty/flags/
margin）。classifier 为 None 时走 `classify_heuristic`。

---

## 7. 中控（tokenhub）—— 只喂中央，边界很窄

**中控只做一件事：向中央服务下发版本化的路由策略配置。** 不参与单轮决策，永不进热路径，
也**不下发任何东西到插件**。插件配置一律走 `openclaw.json`。中央对 tokenhub **fail-open**
（拉不到就用 last-known-good），后台定时刷新 + 单槽快照，`_route` 只读快照。决策轨迹记
`policyVersion`，可复现/可回滚。V4 落地后，「策略」自然从锚点/阈值演进为「模型 bundle 版本 +
后处理阈值」；bundle 本身较大，走部署发布而非 tokenhub 热下发，tokenhub 只下发轻量后处理/
阈值/默认档参数。详见 [`design/config-distribution.drawio`](design/config-distribution.drawio)。

> 取舍：tokenhub 不下发到插件，改 fleet 的 profile/模型映射要逐个改 `openclaw.json`——刻意
> 保持插件侧零外部配置依赖、启动即定；集中改用配置管理/发布流程推 `openclaw.json`。

---

## 8. 隐私与可追踪契约

- **明文只存在两处**：请求体（内部网传输，用后即弃）、客户端会话记录（端上）。
- **决策库无明文**：`decisions` 表没有文本列，只存 profile、字符数、flags、4 类概率、
  margin、`base→gated→final` 档位轨迹、route_class/difficulty、版本号、延迟。
- **decisionId 关联**：每次决策返回 `decisionId`，插件打进 debug 日志（与端上明文并排）。
  查问题四步：`/v1/stats` 看分布（档位/band/**profile**/评分）→
  `/v1/decisions?sessionKey` 找 turn → `/v1/decisions/{id}` 看完整轨迹 →
  需要原文则去端上日志 grep `decisionId`。

---

## 9. 失败模式与降级

| 失败点 | 行为 | 用户可见影响 |
|---|---|---|
| 中央超时/宕机 | 插件用粗略兜底（长度/代码猜档），节流告警 | 路由变粗，不阻塞 |
| V4 bundle/依赖不可用 | 中央退无依赖 band 启发式，照常落库 | 路由变粗，客户端无感 |
| MySQL 挂 | 决策落库失败（路由本身仍返回）；需告警 | 轨迹缺失，路由可用 |
| tokenhub 挂 | 中央保留 last-known-good 策略快照 | 无 |
| 会话档位丢失 | 下一轮自由重路由 | 无（可能一次 cache miss） |
| 配置了虚拟 id 但插件禁用/无 profile | 虚拟 id 走正常模型解析并报错 | 运维配置错误，启动日志有告警 |

原则：路由链路上每个外部依赖都必须能**优雅降级**，绝不让配置/中控/库/模型的故障阻断出词。

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
