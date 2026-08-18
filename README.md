# @deepseek-ai/dsh-translator

Floating AI translation window for the Web GUI. The browser half (`./client`)
registers one entry into the frame-wide `shell.overlay` slot: a draggable,
resizable window with a language picker, source/result panes, and a footer
that shows the provider account balance and today's estimated consumption. All
provider work happens on the host half, which exposes three plain routes under
`/translator/*` and a user-settings namespace; the API key never crosses the
wire to the page.

## Installation

This is a standalone DeepSeek Harness plugin — a dual-face bundle (host half +
browser half). Install it into any dsh profile with the `dsh plugin` CLI:

```sh
# from a git repository (builds on install via the prepare script)
dsh plugin --profile web add github:<your-org>/dsh-translator

# or, once published to npm
dsh plugin --profile web add @deepseek-ai/dsh-translator
```

The `dsh.bundle` layer inserts the `translator` row (host routes + settings
namespace); the `dsh.client` declaration registers the browser window into the
Web GUI's `shell.overlay` slot. Restart dsh and refresh the page afterwards.

Git installs fetch **sources**, not built artifacts: the package ships a
`prepare` script that builds `lib/` at install time, and pnpm ≥10 requires
allowlisting it in the profile's `pnpm-workspace.yaml` (`allowBuilds:
'@deepseek-ai/dsh-translator': true`) — see the official
[packaging doc](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md).
npm/tarball installs carry prebuilt `lib/` and need no permission.

Local development: `pnpm install && pnpm run build` (tsc + tsdown; the client
bundle registers through `window.__ModuleLoader__.load` exactly like in-repo
plugins). Publishing to npm is a plain `npm publish`; the package name is
currently the `@deepseek-ai` scope, so rename it in `package.json`,
`tsdown.config.ts` (`PLUGIN_ID`), and `cordis.patch.yml` if you publish under
your own scope.

## Host service

`export const name = 'translator'`, injects `webServer`, `settings`, and
`credentials`.

### Routes

| Route | Purpose |
|---|---|
| `POST /translator/translate` | One chat-completions translation. Body: `{text, source, target}` where `source` may be `'auto'`. Returns the translated text, token usage, the serving model, an estimated USD cost (pricing from the settings section), and latency. |
| `GET /translator/balance` | Provider account balance. DeepSeek uses `/user/balance`; OpenAI uses the public credit-grants endpoint when the base URL is the default. Other OpenAI-compatible endpoints report `supported: false`. |
| `GET /translator/status` | Resolved provider/model/base URL, whether a key is configured and from which layer, and whether balance queries are supported. |

All responses are JSON with `no-store`; business failures return HTTP 200 with
`ok: false` and a stable `code` (`bad-request`, `no-api-key`, `provider`,
`timeout`, `internal`) plus a human-readable `error`.

### Settings namespace

The `translator` namespace carries the user-editable subset: `provider`
(`deepseek` | `openai`), `baseUrl`, `model`, `apiKey` (secret, optional),
`apiKeyEnv` (credential reference, default `DEEPSEEK_API_KEY`), `inputPrice` /
`outputPrice` (USD per 1M tokens, for the cost estimate), and `temperature`.
The namespace is served automatically to the Settings → Plugins configuration
surface; the window's own settings popover writes the same section.

Key resolution order: the settings-section `apiKey` literal, then the
`credentials` seam for the named reference (inherited environment over the
managed document). Defaults: DeepSeek at `https://api.deepseek.com`,
`deepseek-chat`; OpenAI at `https://api.openai.com/v1`, `gpt-4o-mini`.

### Config

```ts
interface Config {
  requestTimeoutMs?: number  // default 60000
  maxBodyBytes?: number      // default 262144
}
```

## Browser window

The client half injects `slots`, `locale`, and `settingsScope`; it registers
the `translator` locale namespace and one `shell.overlay` entry (`id:
translator`, `order: 20`) rendering the window plus a floating action button
that toggles it. Window position and size persist in `localStorage`; the
daily-usage ledger (per local day, pruned after 30 days) does too. The
window refreshes the balance on open, after each translation, on manual
click, and every five minutes while open.

### Footer statistics

The window footer shows several numbers; here is exactly where each one
comes from:

- **Balance** — a live provider query (`GET /translator/balance`; DeepSeek
  `/user/balance`, OpenAI credit grants on the public endpoint). Never stored
  locally.
- **Today (今日消耗)** — an *estimate in CNY (¥)*, not provider billing; the
  official DeepSeek bill in your account console is always authoritative.
  Every successful translation records the request's estimated cost into the
  localStorage ledger under the local date; the footer sums today's rows. The
  host picks the active price tier by Beijing time (off-peak 16:30–00:30,
  UTC+8) and computes

  `cost = cacheMissTokens / 1,000,000 × inputPrice + cacheHitTokens / 1,000,000 × cacheHitInputPrice + completionTokens / 1,000,000 × outputPrice`

  where the token counts are the **provider-reported** usage of that request
  (`prompt_cache_miss_tokens`, `prompt_cache_hit_tokens`, `completion_tokens`;
  providers that report neither side are treated as all-miss) and the prices
  are the configured peak or off-peak settings (CNY per 1M tokens). The token
  counts are real; the money is estimated from the configured prices, so keep
  the prices aligned with your provider's billing for accuracy. The ledger
  also counts only translations made through this window — other DSH usage is
  not included.
- **Right-side meta (`deepseek-chat · 123 tokens · 0.5s`)** — the *last
  completed* translation: the serving model, the total tokens reported by the
  provider for that request (`usage.total_tokens`, input + output — real
  provider usage, not an estimate), and the host-measured round-trip latency
  in seconds.

### Settings fields

The `translator` settings section is editable from the window's ⚙ popover and
from Settings → Plugins; both write the same document (`$DSH_HOME/settings.yaml`
under `translator:`).

| Field | Meaning | Default |
|---|---|---|
| `provider` | Provider family: `deepseek` (balance endpoint, DeepSeek defaults) or `openai` (OpenAI-compatible endpoints). | `deepseek` |
| `baseUrl` | API base URL. The plugin appends `/chat/completions` (and `/user/balance` for balance). Blank inherits the provider default: `https://api.deepseek.com` / `https://api.openai.com/v1`. Works with OpenAI-compatible gateways (one-api, new-api, vLLM, …). Must not include the `/chat/completions` suffix. | blank |
| `model` | Model id sent to the provider. Blank inherits the provider default: `deepseek-chat` / `gpt-4o-mini`. | blank |
| `apiKey` | Optional API key override (write-only; never read back). When set it wins over DSH credentials; blank falls back to the DSH credential seam named by `apiKeyEnv`. | blank |
| `apiKeyEnv` | Credential reference (environment-variable name) resolved through the DSH credentials service when no literal `apiKey` is set: inherited environment first, then `$DSH_HOME/.credentials.yaml`. Advanced field — not rendered in the ⚙ popover; edit it in Settings → Plugins or the settings document. | `DEEPSEEK_API_KEY` |
| `inputPrice` | CNY per 1M **input** tokens (cache miss), **peak**; used only for the 今日消耗 estimate. Never sent to the provider. | `3.0` |
| `cacheHitInputPrice` | CNY per 1M **input** tokens served from the prompt cache, **peak**. | `0.1` |
| `outputPrice` | CNY per 1M **output** tokens, **peak**. | `9.0` |
| `offPeakInputPrice` | CNY per 1M **input** tokens (cache miss), **off-peak**. | `1.5` |
| `offPeakCacheHitInputPrice` | CNY per 1M **input** tokens served from the prompt cache, **off-peak**. | `0.05` |
| `offPeakOutputPrice` | CNY per 1M **output** tokens, **off-peak**. | `4.5` |
| `temperature` | Sampling temperature passed to the provider (0–2). Lower is more deterministic, higher more varied; `0.3` suits translation. | `0.3` |

The price defaults follow DeepSeek's official list-price table (CNY per 1M
tokens), **`deepseek-v4-flash` row** — peak: input ¥3.0 (cache hit ¥0.1),
output ¥9.0; off-peak: input ¥1.5 (cache hit ¥0.05), output ¥4.5. For
`deepseek-v4-pro`, use peak input ¥9.0 (cache hit ¥0.3) / output ¥27.0 and
off-peak input ¥4.5 (cache hit ¥0.15) / output ¥13.5. The host applies the
off-peak tier automatically during 16:30–00:30 Beijing time (UTC+8). These
defaults are **manually maintained, not provider queries** — DeepSeek exposes
no machine-readable pricing API, and **今日消耗 is a local estimate; the
official DeepSeek bill is authoritative**. If you use another provider,
model, or gateway with different billing, set the six prices to match it.

## Model Experience

### System prompt

#### What the model sees

Each translation sends a fixed system message instructing the model to act as
a professional translation engine and to output only the translated text,
followed by the user's text as the only user message.

#### Token effect

Fixed: one system message per request whose length does not depend on session
state; the user message is the text being translated, so request size grows
with the input text.

#### KV Cache effect

Requests are independent single-turn completions with a stable system prefix
(the instruction and the two resolved language names); nothing is cached or
reused across requests, and the provider's own cache behavior remains outside
this package's contract.

## Known Limitations and Deferred Work

- **Non-streaming responses** — translation results arrive in one completion;
streaming output is deferred work.
- **Cost is an estimate** — the daily consumption shown in the footer is
computed from token usage and the configured pricing, not from provider
billing; see [Footer statistics](#footer-statistics). Providers that report
per-request cost natively are not integrated.
- **Balance support is provider-specific** — only DeepSeek and the public
OpenAI endpoint expose balance endpoints; other OpenAI-compatible endpoints
show `余额 —`.
- **Key writes are write-only** — the window can set the optional key but never
reads it back; the Settings → Plugins card is the equivalent surface.
