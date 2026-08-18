/**
 * Client-side binding of the `translator` settings namespace. Reads and writes
 * ride the settings transport (connection.api.settings) through the
 * SettingsScopeBinder provided by `dsh-client-ui-settings`; the same
 * namespace is registered by the translator host half, so the Settings →
 * Plugins configuration surface shows it as well.
 */

import { useSyncExternalStore } from 'react'
import type { ClientContext, SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Client view of the `translator` settings section (schema defaults live host-side). */
export interface TranslatorSettingsView {
  /** Provider family. */
  provider?: string
  /** Endpoint base; blank inherits the provider default. */
  baseUrl?: string
  /** Model id; blank inherits the provider default. */
  model?: string
  /** Optional key override (write-only on the wire; never read back). */
  apiKey?: string
  /** Credential reference resolved when no literal key is set. */
  apiKeyEnv?: string
  /** CNY per 1M input tokens (cache miss), peak. */
  inputPrice?: number
  /** CNY per 1M input tokens served from the prompt cache, peak. */
  cacheHitInputPrice?: number
  /** CNY per 1M output tokens, peak. */
  outputPrice?: number
  /** CNY per 1M input tokens (cache miss), off-peak. */
  offPeakInputPrice?: number
  /** CNY per 1M input tokens served from the prompt cache, off-peak. */
  offPeakCacheHitInputPrice?: number
  /** CNY per 1M output tokens, off-peak. */
  offPeakOutputPrice?: number
  /** Sampling temperature. */
  temperature?: number
}

/** The bound scope, installed once by the plugin apply. */
let scope: SettingsScope<TranslatorSettingsView> | undefined

/** Whether the settings scope is available (bound after apply). */
export function hasTranslatorSettings(): boolean {
  return scope !== undefined
}

/**
 * Bind the translator namespace on the calling plugin's lifecycle.
 * @param ctx - the client root context (injects `settingsScope`).
 */
export function initTranslatorSettings(ctx: ClientContext): void {
  scope = ctx.settingsScope.bind({ namespace: 'translator' })
}

/**
 * React hook over the translator settings snapshot. Returns the live
 * snapshot; `status` is `unavailable` until the namespace is served.
 */
export function useTranslatorSettings(): SettingsScopeSnapshot<TranslatorSettingsView> {
  const current = scope
  return useSyncExternalStore(
    listener => current === undefined ? () => {} : current.subscribe(listener),
    () => current === undefined
      ? { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }
      : current.getSnapshot(),
  )
}

/**
 * Write one field of the translator section.
 * @param field - the field name.
 * @param value - the JSON-shaped value.
 * @returns settlement of the queued write.
 */
export function setTranslatorSetting(field: keyof TranslatorSettingsView, value: unknown): Promise<void> {
  return scope?.set(field, value) ?? Promise.resolve()
}

/**
 * Clear one field of the translator section (re-inherits the composition
 * layer). Used for secrets, which must never be restated by a caller that
 * only holds a redacted view.
 * @param field - the field name.
 * @returns settlement of the queued write.
 */
export function clearTranslatorSetting(field: keyof TranslatorSettingsView): Promise<void> {
  return scope?.unset(field) ?? Promise.resolve()
}
