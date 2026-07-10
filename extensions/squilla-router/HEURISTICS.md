# SquillaRouter 启发式路由层：流程详解

本文档详细说明 `squilla-router` 插件的启发式路由流程。这是 OpenSquilla
SquillaRouter 的**无依赖规则子集**（不含 ML 模型），把每一轮消息分类到一个模型
档位并覆盖当轮使用的模型。

代码位置：

- 路由逻辑：`extensions/squilla-router/router.ts`
- 插件接线：`extensions/squilla-router/index.ts`

移植来源（阈值与关键词表保持等价）：

- 分档：OpenSquilla `src/opensquilla/engine/routing/heuristic.py`
- flags：v4 bundle `runtime_src/src/router/flags.py` + `router.runtime.yaml`
- flag 升级：v4 bundle `predictor.py` 的 `_apply_flag_overrides`

---

## 总览：一次路由的五个阶段

每一轮 agent 运行前，`before_model_resolve` 钩子触发，走完下面五步：

```
入口 (prompt, attachments)
  │
  ├─① 图片短路      ── 有图片附件 → 不覆盖，直接返回（保持会话原模型）
  │
  ├─② 分档 band     ── 按长度/代码块/附件把消息归入 5 个 band，得到基础 tier
  │
  ├─③ flag 计算     ── 从文本算出 5 个布尔 flag（高风险/调试/长上下文/仓库架构/严格格式）
  │
  ├─④ flag 升级     ── flag 命中则把 tier 往上抬（只升不降）
  │
  └─⑤ 落地解析      ── 置信度门 + 就近取配置档位 + KV-cache 粘滞 → 返回 modelOverride / providerOverride
```

对应的函数调用链：

```
index.ts  before_model_resolve 回调
  → classifyTurn()            // router.ts：② + ③ + ④
      → classifyBand()        // ②
      → computeFlags()        // ③
      → applyFlagUpgrades()   // ④
  → SessionTierStore.get()    // 读上一轮服务的档位（粘滞用）
  → resolveRoute()            // router.ts：⑤
      → nearestConfiguredTier()
      → applySticky()         // ⑤ 的 KV-cache 粘滞
  → SessionTierStore.set()    // 记录本轮服务的档位
```

会话状态（`session-store.ts`）：`SessionTierStore` 是有界的 per-session
内存表，记录每个会话上一轮**实际服务的档位**，TTL 30 分钟、按容量 LRU 淘汰。丢失
一条只是让下一轮自由重路由（安全，无用户可见数据）。

档位命名：`c0`（最便宜/最快）→ `c1` → `c2` → `c3`（最强）。对应 OpenSquilla 的
路由类 `R0`–`R3`。

---

## 阶段 ① 图片短路

```ts
if (event.attachments?.some((a) => a.kind === "image")) return;
```

启发式只看**文本复杂度**，对"这轮是否需要视觉能力"一无所知。如果贸然把带图的
轮次路由到一个便宜但不支持视觉的模型，会直接失败。所以只要附件里有图片，插件就
不做任何覆盖，让会话保持它原本配置的（应当支持视觉的）模型。

注意：只有 `kind === "image"` 才短路。其它类型的附件（文档、音频等）不短路，会
在阶段 ② 里作为"有附件"信号参与分档。

---

## 阶段 ② 分档 band（`classifyBand`）

从消息算两个表面特征：

- `charLen` = 消息字符数
- `fencedBlocks` = ` ``` ` 出现次数 / 2（成对的代码围栏数）

然后**按顺序**匹配，第一个命中的 band 胜出（强信号优先）：

| 顺序 | band               | 条件                                                   | 基础 tier | 置信度   |
| ---- | ------------------ | ------------------------------------------------------ | --------- | -------- |
| 1    | `heavy`            | `charLen ≥ 12000` **或** `fencedBlocks ≥ 3`            | c3        | 0.60     |
| 2    | `code_or_material` | 有代码围栏 **或** `charLen ≥ 2500` **或** 有非图片附件 | c2        | 0.60     |
| 3    | `short_plain`      | `charLen ≤ 240`                                        | c0        | 0.55     |
| 4    | `medium_plain`     | `charLen ≤ 1200`                                       | c1        | 0.55     |
| 5    | `borderline_plain` | 其余（1200 < charLen < 2500 的纯文本）                 | c1        | **0.40** |

阈值常量（`router.ts` 顶部）：

```
HEAVY_MIN_CHARS = 12_000
HEAVY_MIN_FENCED_BLOCKS = 3
CODE_OR_MATERIAL_MIN_CHARS = 2_500
SHORT_PLAIN_MAX_CHARS = 240
MEDIUM_PLAIN_MAX_CHARS = 1_200
```

**为什么置信度有 0.60 / 0.55 / 0.40 三档？** 这是为了对齐 OpenSquilla 的置信度门
（confidence gate，默认阈值 0.5）：

- `heavy` / `code_or_material` 用 0.60 —— 强信号，稳稳高于门限，路由确定生效。
- `short_plain` / `medium_plain` 用 0.55 —— 中等信号，仍高于门限但更谦虚。
- `borderline_plain` 用 **0.40**，**故意低于门限** —— 1200~2500 字符的纯文本长度
  信号太弱，与其瞎猜一个档位，不如在阶段 ⑤ 回落到操作者配置的 `defaultTier`。

---

## 阶段 ③ flag 计算（`computeFlags`）

从消息文本算出 5 个布尔 flag。这一层是 OpenSquilla 大量安全兜底逻辑的来源——
即使长度分档把某轮判成"简单"，只要命中风险信号就会在阶段 ④ 被强制抬高。

| flag           | 触发条件                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `highRisk`     | 命中高风险关键词：`生产`/`部署`/`回滚`/`迁移`/`删除`/`客户`/`法务`/`财务`/`deploy`/`rollback`/`migration`/`delete`/`overwrite`/`production`/`customer-facing` |
| `debug`        | 命中调试关键词（`error`/`bug`/`traceback`/`报错`/`根因`/`修复` 等）**或** 命中 traceback/stderr/FAILED 正则                                                   |
| `repoArch`     | 命中仓库/架构关键词：`repo`/`codebase`/`monorepo`/`architecture`/`重构`/`架构`/`module`/`dependency`                                                          |
| `strictFormat` | 命中严格格式关键词：`json`/`yaml`/`csv`/`schema`/`只返回`/`不要解释`/`按格式`                                                                                 |
| `longContext`  | 满足任一结构性阈值（见下）                                                                                                                                    |

`longContext` 的四个触发通道（任一即为 true）：

```
消息长度            ≥ 6000 字符
代码块总长度        ≥ 1500 字符
日志块总长度        ≥ 1500 字符   （连续 ≥3 行时间戳日志 / [INFO|WARN|ERROR|DEBUG] 行）
文件路径引用数量    ≥ 2 个        （形如 src/foo/bar.ts 的路径）
```

关键词匹配统一转小写做 `includes`。日志块和文件路径用正则检测（`LOG_BLOCK_RE`、
`FILE_PATH_RE`），代码块用 `CODE_BLOCK_RE` 统计总长度。这三个正则直接对应 v4
bundle 的 `flags.py`。

---

## 阶段 ④ flag 升级（`applyFlagUpgrades`）

拿阶段 ② 的基础 tier，按 flag 往上抬。**只升不降**——用 `Math.max` 保证升级后的
档位不会低于原档位。

```ts
let idx = TEXT_TIERS.indexOf(tier);
if (flags.highRisk) idx = max(idx, index("c2"));
if (flags.debug && flags.longContext) idx = max(idx, index("c2"));
if (flags.repoArch) idx = max(idx, index("c1"));
return TEXT_TIERS[idx];
```

三条规则（对齐 `predictor.py` 的 `_apply_flag_overrides`）：

1. **高风险 → 至少 c2**：任何提到生产/删除/部署的轮次都值得用更强模型，哪怕它
   是一句短命令。例如"把这个删掉直接上生产"会从 `short_plain`(c0) 被抬到 c2。
2. **调试 + 长上下文 → 至少 c2**：注意是**两个 flag 同时命中**。单独的 `debug`
   （比如"这个 error 怎么回事？"）**不会**升级——只有一句报错的短问题不需要强模型；
   但"报错 + 一大段日志/多个文件路径"就值得 c2。
3. **仓库架构 → 至少 c1**：架构类讨论不应落到最便宜的 c0。

`decision.flagUpgraded` 记录 tier 是否因升级而改变，阶段 ⑤ 的置信度门会用到它。

`strictFormat` 只参与 flag 计算，本 PoC 里不直接驱动档位升级（在 OpenSquilla 原版
里它影响的是提示词策略 P0/P2，本 PoC 未移植提示词层）。

---

## 阶段 ⑤ 落地解析（`resolveRoute`）

拿到 `decision` 后做三件事：置信度门、就近取配置档位、KV-cache 粘滞。

### 5.1 置信度门

```ts
const gatedTier =
  decision.band === "borderline_plain" && !decision.flagUpgraded
    ? config.defaultTier
    : decision.tier;
```

只有 `borderline_plain`（置信度 0.40，低于门限）**且没有被 flag 升级过**的轮次，
才回落到 `defaultTier`。这复刻了 OpenSquilla 置信度门"把低置信档位拍平回默认档"
的行为。一旦 flag 升级过，说明有强信号，就不回落——例如"production incident."
后面跟一大段模糊长文本，虽然是 borderline band，但 `highRisk` 已经把它抬到 c2，
门不再把它拍回默认档。

### 5.2 就近取配置档位（`nearestConfiguredTier`）

操作者不一定四档全配。解析规则：**优先同档，然后向上，最后向下**。

```
从目标档位开始，先在 [目标档 .. c3] 里找第一个已配置 model 的档位；
找不到再在 [目标档-1 .. c0] 里倒序找。
```

向上优先的意义：一个未配置的档位**绝不会导致静默降级**。例如只配了 c1 和 c3，
被分到 c2 的轮次会解析到 c3（向上），而不是掉到 c1。只有当目标档之上全部空缺时，
才向下取（例如只配了 c0，被分到 c3 的轮次解析到 c0）。

如果一个 model 都没配置，返回 `undefined`，插件不做覆盖。

### 5.3 KV-cache 粘滞（`applySticky`，重点）

**这是成本能不能真降下来的关键。** provider 端的 prompt cache 缓存的是对话前缀；
一旦本轮换了模型，新模型缓存全冷，会把整段历史当作**未缓存**输入重新计费。未缓存
输入通常是缓存命中价的数倍——所以每轮乱切模型，"路由到便宜模型"省下的单价，很可能
被"丢缓存重付全上下文"吃掉甚至倒亏。粘滞就是为此存在。

规则（对齐 OpenSquilla `predictor.py` 的 `_apply_sticky_tier`）：

```ts
const isContinuation = ctx.promptLen <= sticky.maxUserLen; // 短延续轮次
const isDowngrade = index(ctx.lastTier) > index(desiredTier); // 想往下降
if (isContinuation && isDowngrade) {
  return { tier: ctx.lastTier, stuck: true }; // 保持上一轮档位，护住热缓存
}
return { tier: desiredTier, stuck: false };
```

三个要点：

1. **只拦降级，不拦升级**。降级换便宜模型：省的单价抵不过丢缓存，拦。升级换强模型：
   难轮次确实需要更强能力，这次缓存代价值得付，放行。
2. **只在短延续轮次生效**（`promptLen ≤ maxUserLen`，默认 200 字符）。一句"继续"
   "好的接着改"是同一任务的延续，要留在热模型上；而一条长的新消息是真正的新工作，
   重路由（连带吃一次缓存 miss）是合理的。
3. **在"已解析档位"空间比较**。`lastTier`（上一轮实际服务的档位，一定是已配置档）
   和 `desiredTier`（本轮就近解析后的档，也一定已配置）都在同一空间，所以粘滞结果
   永远是已配置档，无需二次解析。

粘滞与置信度门是两套独立的"防抖"：门防的是**低置信瞎猜**，粘滞防的是**丢缓存**。
一句短的高风险轮次（"删库跑路"）仍会照常升级——粘滞不拦升级，缓存代价该付就付。

工程上，`lastTier` 来自 `SessionTierStore`（阶段 ⑤ 结束后 `set` 记录本轮
`resolvedTier`）。没有 session key 或首轮无历史时，粘滞不生效，按纯分类走。

### 5.4 返回覆盖

```ts
return {
  modelOverride: route.target.model,
  ...(route.target.provider ? { providerOverride: route.target.provider } : {}),
};
```

core 在 `src/agents/embedded-agent-runner/run/setup.ts` 消费这个返回值：
`providerOverride` 替换当轮 provider，`modelOverride` 替换当轮 modelId，然后才走
`resolveModel()`。不带 `provider` 的档位就沿用会话当前 provider。

---

## 配置读取（`parseRouterConfig`）

插件在 `register()` 时读一次 `api.pluginConfig`：

- `tiers.{c0..c3}.model` —— 必填字符串（空白串视为未配置，跳过）；`provider` 可选。
- `defaultTier` —— 取值 `c0..c3`，非法或缺省时回落 `c1`。
- `sticky.enabled` —— KV-cache 粘滞开关，默认 **true**；`sticky.maxUserLen` ——
  延续轮次的字符上限，默认 200。
- 如果一个可用档位都没有，返回 `undefined`，插件打 warn 并对本会话禁用路由。

> 关于粘滞默认开：OpenSquilla 出厂是**默认关**的，原因是它的 ML 头可能误报上一轮
> 路由。本插件记录的是自己实际服务的确切档位，不存在这个准确性问题，所以默认打开——
> 而且用户明确关心缓存成本，默认开更符合预期。

配置是进程生命周期内固定的，改配置需要重启 gateway。

---

## 一个完整例子

输入：`"把这个删除了直接部署到生产"`（一句短命令）

1. **① 图片短路**：无附件，继续。
2. **② 分档**：`charLen` 很短（≤240），无代码围栏 → `short_plain`，基础 tier = **c0**，置信度 0.55。
3. **③ flag**：命中"删除""部署""生产" → `highRisk = true`；其余 flag = false。
4. **④ 升级**：`highRisk` → tier 抬到 **c2**，`flagUpgraded = true`。
5. **⑤ 落地**：band 不是 borderline，不过门；c2 已配置 → 解析到 c2 → 返回该档 model。

最终：一句看似"简单"的短消息，因为触及生产删除的高风险信号，被路由到 c2 的强模型。

---

## 与 OpenSquilla 完整版的差距（PoC 范围）

本层刻意只移植无依赖的规则子集，以下未包含：

- **ML 分类**：BGE 语义嵌入 + LightGBM/MLP 集成（完整版靠它，规则层只是兜底）。
- **提示词策略 P0/P2**：注入 `[RESPONSE_POLICY: ...]` 提示、思考档位控制。
- **更完整的会话内历史信号**：深对话下限、基于 usage 的延续特征、多轮 margin 轨迹。
  本 PoC 的 per-session 状态只保留了最关键的 **KV-cache 粘滞**（阶段 ⑤.3，已实现）。
- **自学习飞轮**：特征捕获 + 离线重训。

这些能力对应"方案 2"（把完整 ML 管线以 sidecar 接入）；插件侧的接缝
（分类 → 档位 → override）已就位，届时只需把 `classifyTurn` 换成 sidecar 调用。
