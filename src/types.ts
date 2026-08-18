/**
 * Shared wire contract between the translator's host routes and its browser
 * window. Type-only by design: the client bundle imports these types without
 * any runtime value, so the bundle purity gate stays satisfied.
 * @module @deepseek-ai/dsh-translator/types
 */

/** Provider backend family the translator routes speak to. */
export type Provider = 'deepseek' | 'openai'

/** One translation request body. */
export interface TranslateRequest {
  /** The text to translate. */
  text: string
  /** Source language code, or 'auto' for automatic detection. */
  source: string
  /** Target language code. */
  target: string
}

/** Token usage reported by the provider for one completion. */
export interface TranslateUsage {
  /** Input tokens consumed. */
  promptTokens: number
  /** Output tokens produced. */
  completionTokens: number
  /** Sum of both. */
  totalTokens: number
  /** Input tokens served from the provider's prompt cache (0 when unreported). */
  promptCacheHitTokens: number
  /** Input tokens that missed the provider's prompt cache (0 when unreported). */
  promptCacheMissTokens: number
}

/** Successful translation payload. */
export interface TranslateSuccess {
  ok: true
  /** The translated text. */
  translated: string
  /** Token usage of the completion. */
  usage: TranslateUsage
  /** Model that served the request. */
  model: string
  /**
   * Estimated cost of the request in CNY (¥), from the configured peak or
   * off-peak pricing (selected by Beijing time) and the provider-reported
   * token usage. An estimate only — the provider billing is authoritative.
   */
  cost: number
  /** Round-trip latency in milliseconds. */
  latencyMs: number
}

/** Failure payload; `code` is stable for client-side messaging. */
export interface TranslateFailure {
  ok: false
  code: 'bad-request' | 'no-api-key' | 'provider' | 'timeout' | 'internal'
  /** Human-readable failure detail (provider wording when available). */
  error: string
}

/** Result of one `/translator/translate` call. */
export type TranslateResponse = TranslateSuccess | TranslateFailure

/** Account balance snapshot as displayed by the window footer. */
export interface BalanceView {
  /** Whether this provider exposes a balance endpoint. */
  supported: boolean
  /** Provider family the balance came from. */
  provider: Provider
  /** Balance currency code (USD, CNY, …). */
  currency: string
  /** Total remaining balance (deepseek `total_balance`, openai `total_available`). */
  total: number
  /** Amount consumed so far (openai `total_used`; 0 where the provider reports none). */
  used: number
  /** Granted (free) portion of the balance, when reported. */
  granted: number
  /** Topped-up (paid) portion of the balance, when reported. */
  toppedUp: number
  /** Raw provider detail line, when the provider returned one. */
  detail?: string
  /** Epoch milliseconds of the snapshot. */
  refreshedAt: number
}

/** Result of one `/translator/balance` call. */
export type BalanceResponse =
  | { ok: true; balance: BalanceView }
  | { ok: false; code: 'unsupported' | 'provider' | 'internal'; error: string }

/** Configuration status of the translator host service. */
export interface StatusView {
  /** Whether an API key is resolvable (settings override or DSH credentials). */
  configured: boolean
  /** Where the key came from: 'settings' | 'env' | 'file' | 'none'. */
  keySource: string
  /** Active provider family. */
  provider: Provider
  /** Active model id. */
  model: string
  /** Active endpoint base URL. */
  baseUrl: string
  /** Whether the active provider exposes a balance endpoint. */
  balanceSupported: boolean
}

/** Result of one `/translator/status` call. */
export type StatusResponse =
  | { ok: true; status: StatusView }
  | { ok: false; code: 'internal'; error: string }
