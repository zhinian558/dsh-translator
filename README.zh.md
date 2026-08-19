# @zhinian558/dsh-translator

[English](README.md) · **简体中文**

![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)
![Platform: DeepSeek Harness](https://img.shields.io/badge/platform-DeepSeek%20Harness-4f8cff.svg)
![Type: DSH plugin (Web GUI)](<https://img.shields.io/badge/type-dsh%20plugin%20(Web%20GUI)-blue.svg>)
![DSH: 0.1.0-rc.7](https://img.shields.io/badge/dsh-0.1.0--rc.7-1f6feb.svg)

Web GUI 的悬浮 AI 翻译窗口。浏览器端（`./client`）向全局 `shell.overlay` 插槽注册一个条目：可拖拽、可缩放窗口，包含语言选择、原文/译文面板，以及展示服务商账户余额和今日估算消耗的底部状态栏。所有服务商请求都在宿主端完成——宿主端暴露 `/translator/*` 三个普通路由和一个用户设置命名空间，API Key 永远不会随页面请求传出去。

## 安装

这是一个独立的 DeepSeek Harness 插件——双面 bundle（宿主端 + 浏览器端）。用 `dsh plugin` 命令装进任意 profile：

```sh
# 从 git 仓库安装（prepare 脚本会在安装时现场构建）
dsh plugin --profile web add github:zhinian558/dsh-translator

# 或发布到 npm 后
dsh plugin --profile web add @zhinian558/dsh-translator
```

`dsh.bundle` 配置层会插入 `translator` 行（宿主路由 + 设置命名空间）；`dsh.client` 声明把浏览器窗口注册进 Web GUI 的 `shell.overlay` 插槽。装完需重启 dsh 并刷新页面。

git 安装拉取的是**源码**而非构建产物：包内带 `prepare` 脚本在安装时构建 `lib/`，pnpm ≥10 需要在 profile 的 `pnpm-workspace.yaml` 里放行（`allowBuilds: '@zhinian558/dsh-translator': true`），详见官方[打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)。npm/tarball 安装自带构建好的 `lib/`，无需放行。

本地开发：`pnpm install && pnpm run build`（tsc + tsdown；浏览器端 bundle 与仓库内插件一致，通过 `window.__ModuleLoader__.load` 注册）。发布 npm 直接 `npm publish`；当前包名使用 `@deepseek-ai` scope，若发布到自己的 scope，请同步修改 `package.json`、`tsdown.config.ts`（`PLUGIN_ID`）和 `cordis.patch.yml` 中的名字。

## 宿主端服务

`export const name = 'translator'`，注入 `webServer`、`settings` 与 `credentials`。

### 路由

| 路由                         | 用途                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /translator/translate` | 一次对话补全翻译。请求体：`{text, source, target}`，`source` 可为 `'auto'`。返回译文、token 用量、所用模型、估算费用（人民币 ¥，按设置中的价格计算）与延迟。 |
| `GET /translator/balance`    | 服务商账户余额。DeepSeek 使用 `/user/balance`；OpenAI 在默认接口地址时使用公开的 credit-grants 端点。其他 OpenAI 兼容端点返回 `supported: false`。           |
| `GET /translator/status`     | 已生效的服务商/模型/接口地址、密钥是否已配置及来源层、是否支持余额查询。                                                                                     |

所有响应均为 `no-store` 的 JSON；业务失败返回 HTTP 200 + `ok: false`，带稳定 `code`（`bad-request`、`no-api-key`、`provider`、`timeout`、`internal`）与可读 `error`。

### 设置命名空间

`translator` 命名空间承载用户可编辑子集：`provider`（`deepseek` | `openai`）、`baseUrl`、`model`、`apiKey`（secret，可选）、`apiKeyEnv`（凭据引用，默认 `DEEPSEEK_API_KEY`）、六个人民币单价（高峰 `inputPrice` / `cacheHitInputPrice` / `outputPrice` 与空闲 `offPeak*` 三件套，每 1M token，用于费用估算）、`temperature`。该命名空间会自动出现在 设置 → 插件 的配置页；窗口内的设置浮层写入同一个 section。

密钥解析顺序：设置中的 `apiKey` 字面量，其次 `credentials` 服务按引用名解析（环境变量优先于托管文件）。默认值：DeepSeek `https://api.deepseek.com` + `deepseek-chat`；OpenAI `https://api.openai.com/v1` + `gpt-4o-mini`。

### 配置

```ts
interface Config {
  requestTimeoutMs?: number; // 默认 60000
  maxBodyBytes?: number; // 默认 262144
}
```

## 浏览器窗口

客户端注入 `slots`、`locale`、`settingsScope`；注册 `translator` 语言命名空间，并向 `shell.overlay` 注册一个条目（`id: translator`，`order: 20`），渲染窗口与一个切换开关的悬浮按钮。窗口位置与尺寸持久化在 `localStorage`；每日用量账本（按本地日期，保留 30 天）同样持久化。窗口在打开时、每次翻译后、手动点击以及打开期间每五分钟刷新一次余额。

### 底部统计口径

窗口底部状态栏展示了几个数字，来源如下：

- **余额** — 实时查询服务商（`GET /translator/balance`；DeepSeek `/user/balance`，公开 OpenAI 端点为 credit grants），不做本地存储。
- **今日消耗** — **估算值（人民币 ¥），不是服务商账单，实际费用以 DeepSeek 官方账户/账单为准**。每次翻译成功后，把该请求的估算费用记入 localStorage 账本（按本地日期，保留 30 天），底部对当日所有记录求和。宿主端按北京时间自动选择计价档位（空闲时段 16:30–次日 00:30，UTC+8），并按如下公式计算：

  `费用 = 未命中输入tokens / 1,000,000 × inputPrice + 命中输入tokens / 1,000,000 × cacheHitInputPrice + 输出tokens / 1,000,000 × outputPrice`

  其中 token 数是**服务商真实返回**的该请求用量（`prompt_cache_miss_tokens`、`prompt_cache_hit_tokens`、`completion_tokens`；不报告缓存拆分的服务商按全部未命中处理），单价是设置项中的高峰或空闲档（每 1M token 的人民币价）。**token 是真实的，金额是按配置单价估算的**——想让数字贴近实际账单，请把单价设置为与服务商真实计费一致。账本只统计本翻译窗口发起的请求，DSH 其他会话的消耗不计入。

- **右侧元信息（如 `deepseek-chat · 123 tokens · 0.5s`）** — 最近一次完成的翻译：所用模型、服务商为该请求返回的总 token 数（`usage.total_tokens`，输入+输出，**真实用量而非估算**）、宿主端测得的往返耗时（秒）。

### 设置项说明

`translator` 设置可通过窗口 ⚙ 浮层或 设置 → 插件 修改，两者写入同一份文档（`$DSH_HOME/settings.yaml` 的 `translator:` 节）。

| 字段                        | 作用                                                                                                                                                                                                                                                                 | 默认值             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `provider`                  | 服务商：`deepseek`（余额端点 + DeepSeek 默认值）或 `openai`（OpenAI 兼容端点）。                                                                                                                                                                                     | `deepseek`         |
| `baseUrl`                   | API 基础地址。插件会自动追加 `/chat/completions`（余额查询追加 `/user/balance`）。留空继承服务商默认值：`https://api.deepseek.com` / `https://api.openai.com/v1`。兼容 OpenAI 协议的网关（one-api、new-api、vLLM 等）也可填写。**不要带 `/chat/completions` 后缀。** | 空                 |
| `model`                     | 发给服务商的模型 id。留空继承服务商默认值：`deepseek-chat` / `gpt-4o-mini`。                                                                                                                                                                                         | 空                 |
| `apiKey`                    | 可选 API Key 覆盖（只写不读）。设置后优先于 DSH 凭据；留空则走 `apiKeyEnv` 指定的 DSH 凭据。                                                                                                                                                                         | 空                 |
| `apiKeyEnv`                 | 凭据引用（环境变量名）：未设置字面 `apiKey` 时，通过 DSH 凭据服务解析（环境变量优先，其次 `$DSH_HOME/.credentials.yaml`）。高级字段——⚙ 浮层不渲染，可在 设置 → 插件 或设置文档中修改。                                                                               | `DEEPSEEK_API_KEY` |
| `inputPrice`                | 每 1M **输入** token 的人民币单价（缓存未命中，**高峰**），只用于「今日消耗」估算，不会发给服务商。                                                                                                                                                                  | `3.0`              |
| `cacheHitInputPrice`        | 每 1M **输入** token 的人民币单价（缓存命中，**高峰**），只用于「今日消耗」估算。                                                                                                                                                                                    | `0.1`              |
| `outputPrice`               | 每 1M **输出** token 的人民币单价（**高峰**），只用于「今日消耗」估算。                                                                                                                                                                                              | `9.0`              |
| `offPeakInputPrice`         | 每 1M **输入** token 的人民币单价（缓存未命中，**空闲**）。                                                                                                                                                                                                          | `1.5`              |
| `offPeakCacheHitInputPrice` | 每 1M **输入** token 的人民币单价（缓存命中，**空闲**）。                                                                                                                                                                                                            | `0.05`             |
| `offPeakOutputPrice`        | 每 1M **输出** token 的人民币单价（**空闲**）。                                                                                                                                                                                                                      | `4.5`              |
| `temperature`               | 传给服务商的采样温度（0–2）。越低越确定、越高越多变；翻译场景 `0.3` 较合适。                                                                                                                                                                                         | `0.3`              |

价格默认值取自 DeepSeek 官方最新定价表（每 1M tokens，人民币），为 **`deepseek-v4-flash` 行**：高峰 输入 ¥3.0（缓存命中 ¥0.1）/ 输出 ¥9.0；空闲 输入 ¥1.5（缓存命中 ¥0.05）/ 输出 ¥4.5。若使用 `deepseek-v4-pro`，请改为：高峰 输入 ¥9.0（缓存命中 ¥0.3）/ 输出 ¥27.0；空闲 输入 ¥4.5（缓存命中 ¥0.15）/ 输出 ¥13.5。宿主端会在北京时间 16:30–次日 00:30 自动套用空闲档。这些默认值是**手工维护的，不是查询服务商得到的**——DeepSeek 没有公开的机器可读定价 API；**今日消耗为本地估算，实际费用以 DeepSeek 官方账单为准**。若你使用其他服务商、模型或网关且计费不同，请把六个单价改成与实际一致。

## Model Experience

### System prompt

#### What the model sees

每次翻译发送一条固定的系统消息，指示模型作为专业翻译引擎、只输出译文，随后仅跟一条用户消息（待翻译文本）。

#### Token effect

Fixed: 每次请求一条系统消息，长度与会话状态无关；用户消息即待翻译文本，请求大小随输入增长。

#### KV Cache effect

请求是相互独立的单轮补全，系统前缀稳定（指令与两个已解析的语言名）；请求之间不缓存也不复用任何内容，提供方自身的缓存行为不在本包契约内。

## Known Limitations and Deferred Work

- **非流式响应** — 译文一次性返回；流式输出留待后续。
- **费用为估算值** — 底部状态栏的今日消耗由 token 用量与配置价格计算，**并非服务商账单，实际费用以 DeepSeek 官方账单为准**；详见[底部统计口径](#底部统计口径)。未接入服务商原生单次费用字段。
- **余额支持因服务商而异** — 仅 DeepSeek 与公开 OpenAI 端点提供余额端点；其他 OpenAI 兼容端点显示 `余额 —`。
- **密钥只写不读** — 窗口可写入可选密钥但从不回读；设置 → 插件 卡片是等价配置入口。
