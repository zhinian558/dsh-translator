/**
 * Translator host half: a stateless route set over provider chat-completions
 * APIs plus the settings namespace and credential resolution. The browser
 * window (`src/client`) talks only to these routes; the API key never crosses
 * the wire to the page.
 *
 * Routes:
 * - `POST /translator/translate` — one chat-completions translation.
 * - `GET  /translator/balance`  — provider account balance (DeepSeek
 *   `/user/balance`; OpenAI credit grants when the public endpoint is used).
 * - `GET  /translator/status`   — resolved provider/model/key facts for the UI.
 *
 * The `translator` settings namespace carries the user-editable subset
 * (provider, base URL, model, optional key, pricing, temperature) and is
 * served automatically to the Settings → Plugins configuration surface.
 * @module @deepseek-ai/dsh-translator
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only Context merges for the injected services (webServer, settings).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  BalanceResponse, BalanceView, Provider, StatusResponse, TranslateRequest,
  TranslateResponse, TranslateUsage,
} from './types.ts'

export type {
  BalanceResponse, BalanceView, Provider, StatusResponse, TranslateRequest,
  TranslateResponse, TranslateUsage,
} from './types.ts'
export type { Provider as TranslatorProvider } from './types.ts'

/** Cordis plugin name. */
export const name = 'translator'

/** Required services: the route registry, the settings seam, and credentials. */
export const inject = ['webServer', 'settings', 'credentials']

/** Plugin config (cordis.yml layer). */
export interface Config {
  /** Provider request timeout in milliseconds. */
  requestTimeoutMs?: number
  /** Max accepted request body bytes. */
  maxBodyBytes?: number
}

export const Config: z<Config> = z.object({
  requestTimeoutMs: z.number().step(1).min(1000).default(60_000),
  maxBodyBytes: z.number().step(1).min(1024).default(256 * 1024),
})

/** Settings namespace of this plugin. */
const NAMESPACE = settingsNamespace('translator')

/** Default endpoint bases per provider. */
const DEFAULT_BASE_URL: Record<Provider, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
}

/** Default model ids per provider. */
const DEFAULT_MODEL: Record<Provider, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
}

/**
 * Default per-1M-token pricing in CNY (¥) for cost estimation. These are
 * DeepSeek's official list prices for `deepseek-v4-flash` (peak / off-peak
 * rows), maintained manually: DeepSeek exposes no machine-readable pricing
 * API, so the numbers are user-editable settings rather than provider
 * queries. Off-peak is 16:30–00:30 Beijing time (UTC+8), per the official
 * schedule; the host selects the active tier automatically.
 */
const DEFAULT_PEAK_INPUT_PRICE = 3.0
const DEFAULT_PEAK_CACHE_HIT_INPUT_PRICE = 0.1
const DEFAULT_PEAK_OUTPUT_PRICE = 9.0
const DEFAULT_OFFPEAK_INPUT_PRICE = 1.5
const DEFAULT_OFFPEAK_CACHE_HIT_INPUT_PRICE = 0.05
const DEFAULT_OFFPEAK_OUTPUT_PRICE = 4.5

/** Off-peak window: 16:30–00:30, expressed in minutes since midnight (Beijing time). */
const OFFPEAK_START_MINUTES = 16 * 60 + 30
const OFFPEAK_END_MINUTES = 30

/**
 * Whether `now` falls in the DeepSeek off-peak window (16:30–00:30 Beijing
 * time, UTC+8, no DST).
 * @param now - the reference instant.
 * @returns true during off-peak hours.
 */
function isOffPeak(now: Date): boolean {
  const beijing = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return minutes >= OFFPEAK_START_MINUTES || minutes < OFFPEAK_END_MINUTES
}

/** The user-editable `translator` section; validated by the same-named schema. */
export interface TranslatorSettings {
  /** Provider family. */
  provider: Provider
  /** Endpoint base; empty inherits the provider default. */
  baseUrl: string
  /** Model id; empty inherits the provider default. */
  model: string
  /** Optional key override; empty falls back to DSH credentials. */
  apiKey: string
  /** Credential reference (environment-variable name) resolved per request. */
  apiKeyEnv: string
  /** CNY per 1M input tokens, peak (cache miss), for the daily-cost estimate. */
  inputPrice: number
  /** CNY per 1M input tokens served from the prompt cache, peak. */
  cacheHitInputPrice: number
  /** CNY per 1M output tokens, peak. */
  outputPrice: number
  /** CNY per 1M input tokens, off-peak (cache miss). */
  offPeakInputPrice: number
  /** CNY per 1M input tokens served from the prompt cache, off-peak. */
  offPeakCacheHitInputPrice: number
  /** CNY per 1M output tokens, off-peak. */
  offPeakOutputPrice: number
  /** Sampling temperature for translations. */
  temperature: number
}

export const TranslatorSettingsSchema: z<TranslatorSettings> = z.object({
  provider: z.union(['deepseek', 'openai'] as const).default('deepseek'),
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  inputPrice: z.number().min(0).default(DEFAULT_PEAK_INPUT_PRICE),
  cacheHitInputPrice: z.number().min(0).default(DEFAULT_PEAK_CACHE_HIT_INPUT_PRICE),
  outputPrice: z.number().min(0).default(DEFAULT_PEAK_OUTPUT_PRICE),
  offPeakInputPrice: z.number().min(0).default(DEFAULT_OFFPEAK_INPUT_PRICE),
  offPeakCacheHitInputPrice: z.number().min(0).default(DEFAULT_OFFPEAK_CACHE_HIT_INPUT_PRICE),
  offPeakOutputPrice: z.number().min(0).default(DEFAULT_OFFPEAK_OUTPUT_PRICE),
  temperature: z.number().min(0).max(2).default(0.3),
})

/** One pricing tier (CNY per 1M tokens). */
interface PriceTier {
  inputPrice: number
  cacheHitInputPrice: number
  outputPrice: number
}

/** The active pricing tier for `now`: peak unless the official off-peak window applies. */
function activeTier(settings: TranslatorSettings, now: Date): PriceTier {
  return isOffPeak(now)
    ? {
      inputPrice: settings.offPeakInputPrice,
      cacheHitInputPrice: settings.offPeakCacheHitInputPrice,
      outputPrice: settings.offPeakOutputPrice,
    }
    : {
      inputPrice: settings.inputPrice,
      cacheHitInputPrice: settings.cacheHitInputPrice,
      outputPrice: settings.outputPrice,
    }
}

/** Resolved endpoint facts the routes act on. */
interface Endpoint {
  provider: Provider
  baseUrl: string
  model: string
  temperature: number
}

/** Resolve the effective endpoint from the settings section. */
function endpointOf(settings: TranslatorSettings): Endpoint {
  const provider = settings.provider
  return {
    provider,
    baseUrl: (settings.baseUrl.trim() || DEFAULT_BASE_URL[provider]).replace(/\/+$/, ''),
    model: settings.model.trim() || DEFAULT_MODEL[provider],
    temperature: settings.temperature,
  }
}

/** One resolved API key plus its provenance. */
interface ResolvedKey {
  key: string
  source: string
}

/**
 * Resolve the API key: the settings section wins, then the DSH credentials
 * seam (inherited environment over the managed document), then nothing.
 * @param ctx - host context carrying the credentials service.
 * @param settings - the resolved translator section.
 * @returns the key and its provenance, or undefined when unconfigured.
 */
async function resolveApiKey(ctx: Context, settings: TranslatorSettings): Promise<ResolvedKey | undefined> {
  const literal = settings.apiKey.trim()
  if (literal.length > 0) return { key: literal, source: 'settings' }
  const refName = settings.apiKeyEnv.trim() || 'DEEPSEEK_API_KEY'
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  let hit
  try {
    hit = await credentials.resolve(credentialRef(refName))
  } catch {
    return undefined
  }
  return hit === undefined ? undefined : { key: hit.value, source: hit.source }
}

/** One chat-completion message. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Provider chat-completions call. */
async function chatCompletion(options: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  messages: ChatMessage[]
  timeoutMs: number
}): Promise<{ content: string; usage: TranslateUsage }> {
  let response: Response
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    const cause = error as { name?: unknown }
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      throw new Error('provider request timed out')
    }
    throw error
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`provider HTTP ${response.status}: ${detail.slice(0, 300)}`)
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      total_tokens?: unknown
      prompt_cache_hit_tokens?: unknown
      prompt_cache_miss_tokens?: unknown
    }
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('provider returned no completion content')
  }
  const usage = data.usage
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0
  const reportedHit = typeof usage?.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : 0
  const reportedMiss = typeof usage?.prompt_cache_miss_tokens === 'number' ? usage.prompt_cache_miss_tokens : 0
  // Providers that report only one side leave the other inferred; providers
  // that report neither are treated as all-miss (the conservative default).
  const promptCacheMissTokens = reportedMiss > 0 || reportedHit > 0
    ? reportedMiss > 0 ? reportedMiss : Math.max(0, promptTokens - reportedHit)
    : promptTokens
  const promptCacheHitTokens = reportedHit > 0 || reportedMiss > 0
    ? reportedHit > 0 ? reportedHit : Math.max(0, promptTokens - reportedMiss)
    : 0
  return {
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens,
      promptCacheHitTokens,
      promptCacheMissTokens,
    },
  }
}

/** Human-readable English language name for the translation prompt. */
const LANG_NAMES: Record<string, string> = {
  'auto': 'the detected source language',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian',
  'pt': 'Portuguese',
  'it': 'Italian',
  'ar': 'Arabic',
  'tr': 'Turkish',
  'th': 'Thai',
  'vi': 'Vietnamese',
  'id': 'Indonesian',
  'nl': 'Dutch',
  'pl': 'Polish',
  'uk': 'Ukrainian',
  'hi': 'Hindi',
}

/** Name of a language code in the prompt; unknown codes pass through. */
function langName(code: string): string {
  const known = LANG_NAMES[code]
  return known === undefined ? code : known
}

/**
 * Handle `POST /translator/translate`.
 * @param ctx - host context.
 * @param settings - the resolved translator section.
 * @param timeoutMs - provider request timeout.
 * @param maxBodyBytes - request body cap.
 */
async function handleTranslate(
  ctx: Context,
  settings: TranslatorSettings,
  timeoutMs: number,
  maxBodyBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const started = Date.now()
  let body: unknown
  try {
    body = await readJson(req, maxBodyBytes)
  } catch (error) {
    respond(res, { ok: false, code: 'bad-request', error: String(error) } satisfies TranslateResponse)
    return
  }
  const request = body as Partial<TranslateRequest> | undefined
  const text = typeof request?.text === 'string' ? request.text.trim() : ''
  if (text.length === 0 || text.length > 32_000) {
    respond(res, { ok: false, code: 'bad-request', error: 'text must be a non-empty string of at most 32000 characters' })
    return
  }
  const source = typeof request?.source === 'string' && request.source.length > 0 ? request.source : 'auto'
  const target = typeof request?.target === 'string' && request.target.length > 0 ? request.target : 'en'
  const key = await resolveApiKey(ctx, settings)
  if (key === undefined) {
    respond(res, { ok: false, code: 'no-api-key', error: 'no API key configured' })
    return
  }
  const endpoint = endpointOf(settings)
  const sourceName = langName(source)
  const targetName = langName(target)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a professional translation engine. Translate the user text from '
        + `${sourceName} to ${targetName}. Output ONLY the translated text: no explanations, no `
        + 'preamble, no quotes, no transliteration notes. Preserve line breaks, list structure, '
        + 'and code blocks. Keep names and technical terms natural in the target language.',
    },
    { role: 'user', content: text },
  ]
  try {
    const completion = await chatCompletion({
      baseUrl: endpoint.baseUrl,
      apiKey: key.key,
      model: endpoint.model,
      temperature: endpoint.temperature,
      messages,
      timeoutMs,
    })
    const usage = completion.usage
    const tier = activeTier(settings, new Date())
    const cost = usage.promptCacheMissTokens / 1_000_000 * tier.inputPrice
      + usage.promptCacheHitTokens / 1_000_000 * tier.cacheHitInputPrice
      + usage.completionTokens / 1_000_000 * tier.outputPrice
    respond(res, {
      ok: true,
      translated: completion.content,
      usage: completion.usage,
      model: endpoint.model,
      cost,
      latencyMs: Date.now() - started,
    } satisfies TranslateResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.includes('timed out') ? 'timeout' : 'provider'
    ctx.logger.warn(`translator: ${code} failure: ${message}`)
    respond(res, { ok: false, code, error: message } satisfies TranslateResponse)
  }
}

/**
 * Handle `GET /translator/balance`.
 * @param ctx - host context.
 * @param settings - the resolved translator section.
 */
async function handleBalance(ctx: Context, settings: TranslatorSettings, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = await resolveApiKey(ctx, settings)
  if (key === undefined) {
    respond(res, { ok: false, code: 'internal', error: 'no API key configured' } satisfies BalanceResponse)
    return
  }
  const endpoint = endpointOf(settings)
  try {
    const balance = await fetchBalance(endpoint, key.key)
    respond(res, { ok: true, balance } satisfies BalanceResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`translator: balance failure: ${message}`)
    respond(res, { ok: false, code: 'provider', error: message } satisfies BalanceResponse)
  }
}

/** Coerce a provider-reported balance field (number or numeric string) to a number. */
function numberOr(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Query the provider account balance. */
async function fetchBalance(endpoint: Endpoint, apiKey: string): Promise<BalanceView> {
  if (endpoint.provider === 'deepseek') {
    const response = await fetch(`${endpoint.baseUrl}/user/balance`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`balance HTTP ${response.status}: ${detail.slice(0, 200)}`)
    }
    const data = await response.json() as {
      is_available?: unknown
      balance_infos?: Array<{
        currency?: unknown
        total_balance?: unknown
        granted_balance?: unknown
        topped_up_balance?: unknown
      }>
    }
    const info = data.balance_infos?.[0]
    const currency = typeof info?.currency === 'string' ? info.currency : 'CNY'
    const total = numberOr(info?.total_balance)
    const balance: BalanceView = {
      supported: true,
      provider: 'deepseek',
      currency,
      total,
      used: 0,
      granted: numberOr(info?.granted_balance),
      toppedUp: numberOr(info?.topped_up_balance),
      refreshedAt: Date.now(),
    }
    if (data.is_available !== true) balance.detail = 'account unavailable'
    return balance
  }
  if (endpoint.baseUrl === 'https://api.openai.com/v1') {
    const response = await fetch(`${endpoint.baseUrl}/dashboard/billing/credit_grants`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`balance HTTP ${response.status}: ${detail.slice(0, 200)}`)
    }
    const data = await response.json() as {
      total_granted?: unknown
      total_used?: unknown
      total_available?: unknown
    }
    return {
      supported: true,
      provider: 'openai',
      currency: 'USD',
      total: numberOr(data.total_available),
      used: numberOr(data.total_used),
      granted: numberOr(data.total_granted),
      toppedUp: 0,
      refreshedAt: Date.now(),
    }
  }
  return {
    supported: false,
    provider: 'openai',
    currency: 'USD',
    total: 0,
    used: 0,
    granted: 0,
    toppedUp: 0,
    refreshedAt: Date.now(),
  }
}

/**
 * Handle `GET /translator/status`.
 * @param ctx - host context.
 * @param settings - the resolved translator section.
 */
async function handleStatus(ctx: Context, settings: TranslatorSettings, res: ServerResponse): Promise<void> {
  const key = await resolveApiKey(ctx, settings)
  const endpoint = endpointOf(settings)
  respond(res, {
    ok: true,
    status: {
      configured: key !== undefined,
      keySource: key?.source ?? 'none',
      provider: endpoint.provider,
      model: endpoint.model,
      baseUrl: endpoint.baseUrl,
      balanceSupported: endpoint.provider === 'deepseek' || endpoint.baseUrl === 'https://api.openai.com/v1',
    },
  } satisfies StatusResponse)
}

/** Read a JSON request body with a size cap. */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Write one JSON response with no-store caching. */
function respond(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Mount the translator routes, the settings namespace, and the credential
 * resolution.
 * @param ctx - host plugin context carrying webServer, settings, credentials.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.requestTimeoutMs as number
  const maxBodyBytes = config.maxBodyBytes as number

  // The namespace registration is an effect on this fiber: unload removes it.
  ctx.settings.register(NAMESPACE, TranslatorSettingsSchema, { applies: 'live' })

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/translator/translate',
        handler: (req, res) => {
          const settings = ctx.settings.get(NAMESPACE) as TranslatorSettings | undefined
          if (settings === undefined) {
            respond(res, { ok: false, code: 'internal', error: 'translator settings unavailable' } satisfies TranslateResponse)
            return
          }
          void handleTranslate(ctx, settings, timeoutMs, maxBodyBytes, req, res)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/translator/balance',
        handler: (req, res) => {
          const settings = ctx.settings.get(NAMESPACE) as TranslatorSettings | undefined
          if (settings === undefined) {
            respond(res, { ok: false, code: 'internal', error: 'translator settings unavailable' } satisfies BalanceResponse)
            return
          }
          void handleBalance(ctx, settings, req, res)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/translator/status',
        handler: (_req, res) => {
          const settings = ctx.settings.get(NAMESPACE) as TranslatorSettings | undefined
          if (settings === undefined) {
            respond(res, { ok: false, code: 'internal', error: 'translator settings unavailable' } satisfies StatusResponse)
            return
          }
          void handleStatus(ctx, settings, res)
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'translator: routes')
}
