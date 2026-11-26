---
description: "ctx.web 的 Exa 搜索提供方本地分支：在 dsh 0.2.2-rc.5 上恢复 Exa 搜索，并支持跨 Exa team 的多密钥轮换与冷却。"
kind: "package-reference"
---

# dsh-web-search-exa（本地分支）

[English](README.md) | 中文

上游 [`@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/web/web-search-exa)
的独立重建，让它在 **dsh 0.2.2-rc.5** 上继续工作，并补上上游没有的**跨 Exa team 多密钥轮换**。
包名是 `@local/dsh-web-search-exa`，不会顶掉官方包。

`vendor:` 提交是上游原样基线，`adapt:` / `feat:` 两次提交是本仓库的全部改动，`git diff` 可以逐行对照。
改造理由、多密钥语义与验证方法的详细版本见 [ADAPTATION.md](ADAPTATION.md)。

## 为什么需要这个分支

上游包把 DSH 相关 `peerDependencies` 钉死在 `0.2.2-rc.1`，dsh 升到 rc.2 之后被启动版本门禁拒绝激活：

```
dsh: warning: Plugin @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1 is incompatible
with dsh 0.2.2-rc.2: requirements
{"@deepseek-ai/dsh-launch-environment":"0.2.2-rc.1","@deepseek-ai/dsh-web":"0.2.2-rc.1"}
... Exact-version exemption: not active.
```

npm 上最高只发布到 rc.1，官方仓库在 rc.2 之后直接删掉了 `packages/web/web-search-exa` 目录 —— 
既没有可升级的版本，也没有能提 PR 的地方。于是以已安装 npm 包的 `lib/index.js`（完整编译产物）
为基础重建：搜索逻辑与官方 rc.1 是同一份代码，改动都在周边。

## 相对上游改了什么

| # | 改进 | 上游行为 | 本分支 |
|---|---|---|---|
| 1 | **解除版本门禁** | `peerDependencies` 钉死 DSH `0.2.2-rc.1`，rc.5 直接拒绝加载 | 删掉 `peerDependencies` 与 `engines.dsh`，版本号对齐 `0.2.2-rc.5` |
| 2 | **`link:` 安装可用** | 从真实路径加载时裸 `@deepseek-ai/*` import 解析失败（`ERR_MODULE_NOT_FOUND`），`link:` 装不进去 | 自包含改造：本地 `WebError`、`launchEnvironmentOf()`、`environmentReaderOf(ctx)`，去掉 schemastery `Config`，零运行时依赖 |
| 3 | **多密钥轮换** ⭐ | 只认一把 `apiKey` | 多把 key 跨 Exa team 轮转（注册表仍是单 provider，见下节） |
| 4 | **额度耗尽的冷却阶梯** ⭐ | 一把 key 用干后，每次搜索都撞同一个 402 | 命中即停放，5min → 30min → 2h → 8h → 24h 递增，同一次搜索立刻换下一把 |
| 5 | **429 退避** | 直接失败 | 按 `Retry-After` 同 key 重试（最多 2 次、单次睡眠封顶 5s），仍失败换 team 且**不记冷却** |
| 6 | **冷却账本持久化** ⭐ | 无 | `$DSH_HOME/cache/exa-key-state.json`，按 key 的 sha256 前 16 位索引、明文不落盘，重启后冷却仍在，7 天陈旧条目自动丢弃 |
| 7 | **密钥只走环境** | 文档建议在补丁里写 `apiKey`，等于把密钥写进版本控制 | 支持 `EXA_API_KEYS` / `EXA_API_KEY`（也接受 `config:`），本仓库的 `cordis.patch.yml` 不含任何密钥 |
| 8 | **`config` 可缺省** | 补丁不写 `config:` 时 `apply()` 拿到 `undefined` 会崩 | `apply(ctx, config)` 内部 `config ?? {}`，空配置也能正常注册 |
| 9 | **可验证** | 测试依赖 monorepo 的 workspace 依赖，单独跑不起来 | `test/` 下 10 条桩测试（stub `fetch` + 临时 `DSH_HOME`）＋ 直连真实 Exa 的 `live-check.mjs` |
| 10 | **文档** | — | [ADAPTATION.md](ADAPTATION.md) 记录改造理由、多密钥语义与验证方法 |

## 安装

```sh
# 1. 让 profile 以链接方式依赖本仓库（profile 目录通常为 ~/.dsh/profiles/<name>）
pnpm add "link:/path/to/dsh-web-search-exa"

# 2. 把 bundle 装进 profile：用 dsh plugin manager 的 install_bundle，
#    或把 @local/dsh-web-search-exa 加进 profile package.json 的 dsh.profile.bundles
```

本包自带 [cordis.patch.yml](cordis.patch.yml)，用 distinct row id `web-search-exa-local` 插入启用行；
若 profile 里还留着旧的 `web-search-exa` 行，它被门禁禁用、不会 mount，因此不会重复注册 provider id `exa`
（重复会抛 `WEB_DUPLICATE_PROVIDER`）。profile 的 `web` 行保持 `searchProvider: exa` + `fetchProvider: http` 不变。

## 多密钥怎么配

```sh
# 推荐写在 ~/.dsh/.env（或调用目录的 .env），改完重启 dsh
EXA_API_KEYS=team-a-key,team-b-key,team-c-key
```

配置来源按下列顺序**合并并去重**（前面的排在轮转队列前面）：
插件 config 的 `apiKeys` → 环境变量 `EXA_API_KEYS` → 插件 config 的 `apiKey` → 环境变量 `EXA_API_KEY`。
分隔符支持逗号、分号、空白；单把 key 用 `EXA_API_KEY` 即可，行为与上游一致。
环境变量走 dsh 的 launch 快照，所以 `~/.dsh/.env` 与调用目录的 `.env` 都生效。

> **只有跨 Exa team 才有意义。** Exa 的额度与 QPS 都按 team 计，同一个 team 的多把 key 共享同一份额度，
> 轮换不会让额度变多。

### 一次搜索如何选 key

| 场景 | 行为 |
|---|---|
| 有健康 key | round-robin 轮转，从上次成功那把之后开始，避免一把被先用干 |
| `402` / tag `NO_MORE_CREDITS` | 立刻停放这把 key 并提高冷却档位，本次搜索换下一把 |
| `429` | 按 `Retry-After` 在同一把 key 上重试（≤2 次、单次 ≤5s），仍失败则换 team，不记冷却 |
| `401` / `403` | key 本身不可用，冷却 24h |
| 网络错误 / `5xx` | 直接抛给调用方，不消耗其他 key |
| 全部 key 在冷却 | 每分钟最多探测一次「最早解锁」的那把；其余请求立即失败并报还差几分钟 |

### 额度恢复时间

Exa 的 402 不带 `Retry-After`，也不返回额度重置时间；Starter 免费版每月 1 号额度回到 $10（不累计），
Developer 是预付费（充值后立即恢复）。所以冷却只能是**带封顶的退避猜测** —— 24h 上限对齐「月初重置」
的粒度，同时让试探流量接近零。刚充值完想立刻解冻：停掉 dsh → 删掉账本
`$DSH_HOME/cache/exa-key-state.json` → 重启（账本在构造时读入并常驻内存）。

## 验证

```sh
node test/multi-key.test.mjs          # 10 条桩测试，不联网、不花钱
node test/live-check.mjs "exa pricing"  # 直连真实 Exa，只打印 key 的 sha256 前缀
```

桩测试覆盖：轮转、单 key 耗尽后换 key、冷却阶梯与 24h 封顶、全冷却时的探测节流、429 重试与换 team、
401 冷却、5xx 不换 key、`EXA_API_KEYS` 解析与去重、重启后从账本恢复。
`live-check.mjs` 默认把账本写到临时目录，不会污染真实账本。

## 提交历史（三段核心提交）

```
9ffc9a6 feat: rotate several Exa API keys with a cooldown ledger
1a72c1e adapt: make the bundle self-contained for dsh 0.2.2-rc.5
ba9bb0b vendor: import @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1 verbatim
```

## 上游原始文档

以下为上游 `0.2.2-rc.1` 的原文档，描述的是上游包本身（包括官方包名、monorepo 内的相对链接）；
本分支的差异以上面各节为准。`src/` 是上游 TypeScript 源码，仅作对照，不参与构建 ——
运行时入口是本仓库的 [index.js](index.js)。

-----
### 概述

有了 `dsh-web-search-exa`，harness 可以通过 Exa 搜索 web，获得带可移植 snippet 与发布日期的厂商原生结果。当部署持有 Exa API 密钥、并希望使用 Exa 的关键词或神经搜索时选择它。Exa 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。没有非空白高亮的来源会被丢弃，因此一次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

### 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
### 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `exa` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: exa` 固定。

#### 何时选择

当部署持有 Exa API 密钥，并希望使用 Exa 的关键词或神经搜索、获得每项结果的高亮 snippet 与发布日期时，选择此后端。密钥为空或端点基址无法解析时，提供方不可用——每次搜索调用都会以结构化错误失败。

#### 最小配置

加载 web 服务与本提供方；API 密钥回退到启动环境中的 `$EXA_API_KEY`，其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Exa API 密钥；为空或缺失时提供方不可用 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`auto`、`keyword` 或 `neural` |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数 |
| `highlightsPerResult` | `1` | 每个结果请求的 highlight 句子数（Exa `highlightsPerUrl`）；必须是正整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)是每个受支持字段及其 JSDoc 的穷尽式真源。

#### 搜索返回什么

每项 Exa 结果映射为 `WebSearchSource`：`url`、`title`、以首个非空白高亮作为 `snippet`、`publishedDate` 作为 `publishedAt`；没有高亮的来源缺少可移植的 snippet，会被丢弃。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为成本与延迟优化发送给 Exa——最终上限由服务强制执行：截断并标记。Exa 不返回生成答案，因此结果不携带 `content`。

#### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
### 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

#### 设计理念

该提供方是 Exa API 之上的薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源只有在真实高亮存在时才获得 `snippet`；用其他字段捏造会让 seam 说谎，因此没有 snippet 的结果被整个丢弃。
- **不虚构答案。** Exa 不返回生成答案，因此省略 `content`，而不是编造模型可能信任的提供方文本。

#### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ExaSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Exa 协议类型：`ExaSearchResponse`、`ExaResult`、`ExaError` |

#### 请求与映射流程

`search()` 以 `redirect: 'error'` 把查询、检索模式、高亮请求与可选结果数 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，没有 snippet 的条目被丢弃，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
### 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
### 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、首条高亮与发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Exa search aborted`、`Exa search request failed: <error>` 和 `Exa returned an unprocessable response body: <error>`。

##### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

### 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有非空白高亮的来源会被整个丢弃**——没有可映射的可移植 snippet，因此返回来源可能少于请求数量。
- **只公开 `searchType`／`numResults`／`highlightsPerResult`**——Exa 的其他控制项（livecrawl、category、域名／日期过滤条件、全文内容）等待提供方无关的服务字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
#### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

##### 未来：更宽的 Exa 控制面

Exa 的 livecrawl、category、域名与日期过滤条件以及全文内容仍未公开。公开它们需要先有提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>
