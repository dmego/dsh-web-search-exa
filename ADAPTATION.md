# 本地适配说明 / Local adaptation

英文版见 [README.md](README.md)；本文件只讲**这个仓库相对上游**改了什么、为什么改。

本仓库是 `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1`（tag `dsh-v0.2.2-rc.1`）的
独立重建：去掉钉死的 DSH 版本范围，让它在 dsh 后续版本中继续可用（当前验证在 **0.2.2-rc.5**），
并额外支持多把 Exa 密钥。
`vendor:` 提交是上游原样基线，`adapt:` / `feat:` 两次提交是本仓库的改动，
`git diff` 可以逐行看到差异。

## 为什么需要重建

dsh 从 `0.2.2-rc.1` 升到 `0.2.2-rc.2` 后，上游包把 DSH 相关 `peerDependencies`
写死在 rc.1，被启动版本门禁拒绝激活。当时的日志原文：

```
dsh: warning: Plugin @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1 is incompatible
with dsh 0.2.2-rc.2: requirements
{"@deepseek-ai/dsh-launch-environment":"0.2.2-rc.1","@deepseek-ai/dsh-web":"0.2.2-rc.1"}
... Exact-version exemption: not active.
dsh: it stays installed but profile startup denies it until you grant an exemption.
```

npm 上该包最高只发布到 `0.2.2-rc.1`，官方仓库在 `0.2.2-rc.2` 之后也移除了
`packages/web/web-search-exa` 目录，没有可升级的版本。于是以**已安装 npm 包的
`lib/index.js`（完整编译产物）** 为源码基础重建 —— 搜索逻辑与官方 rc.1 是同一份代码。
`src/` 下保留了上游 TypeScript 源码供对照，但本仓库不构建它（`index.js` 才是入口）。

## 改了什么

### 1. `package.json`

- `version` → `0.2.2-rc.5`（只表示**最后核对过的 dsh 版本**，不是兼容范围），包名改为私有名
  `@local/dsh-web-search-exa`；
- **删除**钉死 rc.1 的 `peerDependencies`（这正是门禁判定不兼容的依据），也不声明
  `engines.dsh`，让门禁无版本约束可拒绝 —— 判定逻辑见 `dsh-app-boot` 的
  `plugin-compatibility.ts`：两类字段都没有时直接视为兼容，任何 dsh 版本都放行，所以后续
  dsh 升级不会再被挡住；升级后按 `test/` 的两条命令核对即可；
- 声明 `dsh.bundle.patch`，使它可以作为正式 bundle 安装；
- 不声明任何运行时依赖（见第 3 点），`private: true`。

### 2. `cordis.patch.yml`（新增）

- 用 distinct row id `web-search-exa-local` 插入启用行，**补丁里不写密钥**；
- 若 profile 里还有旧的 `web-search-exa` 行，它被门禁禁用、不会 mount，因此不会重复
  注册 provider id `exa`（重复会抛 `WEB_DUPLICATE_PROVIDER`）。

### 3. `index.js`（自包含改造）

以 `link:` 方式安装的包，loader 从真实路径加载，裸 `@deepseek-ai/*` specifier 不经过
DSH 的解析映射，会直接报：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-launch-environment'
```

因此把 3 条 import 换成本地等价实现：

- `WebError` → 带 `code` 字段的 `Error` 子类；
- `launchEnvironmentOf()` → 读 `process.env`，并加 `environmentReaderOf(ctx)`：
  优先取 `ctx.get("launchEnvironment")` 快照（`~/.dsh/.env` 与工作区 `.env` 都会进这个
  快照），再退回 `process.env`；
- 移除 `z` / `Config` schema（`Config` 本就可选，`apply()` 自带全部默认值）。

`mapExaResult()` / `available()` / 请求构造等搜索逻辑逐字未改。`apply()` 另外对
`config` 缺省（`undefined`）做了防御，补丁里完全不写 `config:` 也能启动。

### 4. 多密钥轮换（本地新增，官方 rc.1 没有）

见下一节。

### 5. profile 的 `web` 行

保持 `searchProvider: exa` + `fetchProvider: http` 不变。

## 多密钥

DSH 的 web provider 注册表按 `provider.id` 唯一（`registerSearchProvider()` →
`Map<string, provider>`，重复 id 直接抛 `WEB_DUPLICATE_PROVIDER`），所以
「一个 provider 一把 key」是注册表的硬约束；多密钥只能做在单个 provider 内部。

**只有跨 Exa team 才有意义**：Exa 的额度与 QPS 都按 team 计，同一个 team 的多把 key
共享同一份额度，轮换不会变多。

### 配置

按下列顺序**合并**并去重（前面的排在轮转队列前面）：

1. 插件 config 的 `apiKeys`（数组或逗号串）；
2. 环境变量 `EXA_API_KEYS`；
3. 插件 config 的 `apiKey`；
4. 环境变量 `EXA_API_KEY`。

config 与环境变量可以同时用，但通常只选一处写。环境变量走 launch 快照，因此
**调用目录的 `.env`** 与 **`~/.dsh/.env`** 都能用（改完重启 dsh）：

```sh
EXA_API_KEYS=team-a-key,team-b-key,team-c-key
# 或单把
EXA_API_KEY=team-a-key
```

分隔符支持逗号、分号、空白。

### 行为

- 健康 key 轮转（round-robin，从上次成功那把之后开始），避免一把被先用干；
- `402` / tag `NO_MORE_CREDITS`：立刻停放这把 key，冷却阶梯
  5min → 30min → 2h → 8h → 24h（Exa 不返回额度恢复时间，只能退避猜测；24h 上限对齐
  「每月 1 号 Starter 额度重置」的粒度），同一次搜索继续试下一把；
- `429`：按 `Retry-After` 在同一把 key 上重试（最多 2 次，单次睡眠封顶 5s），仍失败
  则换下一把 team，**不记冷却**；
- `401` / `403`：key 本身不可用，冷却 24h；
- 网络错误 / 5xx：直接抛给调用方，不消耗其他 key；
- 全部 key 都在冷却：最多每 60s 探测「最早解除冷却」的那把，其余请求直接报冷却消息
  （含还差几分钟），不会每次都打 Exa；
- 冷却账本持久化在 `$DSH_HOME/cache/exa-key-state.json`（默认 `~/.dsh/cache/`），
  条目按 key 的 sha256 前 16 位索引、**明文不落盘**；7 天前的陈旧条目加载时丢弃，
  写入用临时文件 + rename 且权限 0600，写不进去只损失一次探测。

### 安装到 profile

```sh
# profile 目录通常为 ~/.dsh/profiles/<name>
pnpm add "link:/path/to/dsh-web-search-exa"
```

再用 dsh 的 plugin manager 执行 `install_bundle`，或把 `@local/dsh-web-search-exa` 加进 profile
`package.json` 的 `dsh.profile.bundles`。本包的 `cordis.patch.yml` 会自己插入启用行，不需要手写。

## 验证

- 单元测试（10 条桩测试，stub 掉全局 `fetch`、用临时 `DSH_HOME` 隔离账本）：
  `node test/multi-key.test.mjs` —— 覆盖轮转、单 key 耗尽后换 key、冷却阶梯与 24h 封顶、
  全冷却时 60s 探测节流、429 重试与换 team、401 冷却、5xx 不换 key、`EXA_API_KEYS`
  解析与去重、重启后从账本恢复。
- 真实联调：`node test/live-check.mjs "exa api pricing"` 直连 Exa（不经过 dsh），读
  `~/.dsh/.env` 里的 key，账本隔离到临时 `DSH_HOME`，只打印 key 的 sha256 前缀。
  实测：耗尽的那把 402 后自动冷藏 5 分钟，下一把 team 的 key 600ms 内返回 2 条结果。
- 额度耗尽时的 Exa 原文（HTTP 402）：

  ```
  You have exceeded your credits limit. Please top up to keep using Exa at dashboard.exa.ai
  ```

## 遗留

- 这是第三方适配副本；上游已删除该目录，官方不再为它出任何版本。若日后官方在某个 dsh 版本里
  重新提供带多密钥能力的包，可切回官方包并移除本 bundle。
- 上游 `tests/*.spec.ts` 原样保留，但它们依赖 monorepo 的 workspace 依赖与本仓不提供的
  构建链，因此不在此处运行；本仓库的验证以 `test/` 下的 `.mjs` 为准。
