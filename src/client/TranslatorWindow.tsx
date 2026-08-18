/**
 * The translator floating window, registered into the frame-wide
 * `shell.overlay` slot: a draggable, resizable window with language controls,
 * source/result panes, and a footer showing provider balance and today's
 * estimated consumption, plus a floating action button that toggles it.
 */

import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslatorKey } from './locales.ts'
import { LANGS } from './langs.ts'
import {
  translatorController, useTranslatorSnapshot,
} from './service.ts'
import {
  clearTranslatorSetting, setTranslatorSetting, useTranslatorSettings,
  type TranslatorSettingsView,
} from './settings.ts'
import css from './TranslatorWindow.module.css'

/** Map wire failure codes onto localized dictionary keys. */
const ERROR_KEYS: Record<string, TranslatorKey> = {
  'bad-request': 'error.bad-request',
  'no-api-key': 'error.no-api-key',
  'timeout': 'error.timeout',
  'provider': 'error.provider',
  'internal': 'error.internal',
}

/** Settings draft state of the popover. */
interface SettingsDraft {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  apiKeyEnv: string
  inputPrice: string
  cacheHitInputPrice: string
  outputPrice: string
  offPeakInputPrice: string
  offPeakCacheHitInputPrice: string
  offPeakOutputPrice: string
  temperature: string
}

/** Build a draft from a settings section (or its absence). */
function draftOf(value: TranslatorSettingsView | undefined): SettingsDraft {
  return {
    provider: value?.provider ?? 'deepseek',
    baseUrl: value?.baseUrl ?? '',
    model: value?.model ?? '',
    apiKey: '',
    apiKeyEnv: value?.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    inputPrice: value?.inputPrice === undefined ? '' : String(value.inputPrice),
    cacheHitInputPrice: value?.cacheHitInputPrice === undefined ? '' : String(value.cacheHitInputPrice),
    outputPrice: value?.outputPrice === undefined ? '' : String(value.outputPrice),
    offPeakInputPrice: value?.offPeakInputPrice === undefined ? '' : String(value.offPeakInputPrice),
    offPeakCacheHitInputPrice: value?.offPeakCacheHitInputPrice === undefined ? '' : String(value.offPeakCacheHitInputPrice),
    offPeakOutputPrice: value?.offPeakOutputPrice === undefined ? '' : String(value.offPeakOutputPrice),
    temperature: value?.temperature === undefined ? '' : String(value.temperature),
  }
}

/** The floating window and its toggle button. */
export function TranslatorOverlay(props: { t: TranslateNS<'translator'> }) {
  const { t } = props
  const snapshot = useTranslatorSnapshot()
  const settings = useTranslatorSettings()
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(settings.value))

  // Adopt a settings section that arrives (or changes) from the host.
  const seenRevision = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (settings.status !== 'ready') return
    if (seenRevision.current === settings.revision) return
    seenRevision.current = settings.revision
    setDraft(draftOf(settings.value))
  }, [settings])

  const geometry = snapshot.geometry

  // ── drag (header) ─────────────────────────────────────────────────────────
  const dragStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('[data-no-drag]') !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = { px: event.clientX, py: event.clientY, x: geometry.x, y: geometry.y }
  }
  const onHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current
    if (start === null) return
    translatorController.setGeometry({
      ...geometry,
      x: start.x + event.clientX - start.px,
      y: start.y + event.clientY - start.py,
    })
  }
  const onHeaderPointerUp = (): void => { dragStart.current = null }

  // ── resize (bottom-right handle) ──────────────────────────────────────────
  const resizeStart = useRef<{ px: number; py: number; w: number; h: number } | null>(null)
  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStart.current = { px: event.clientX, py: event.clientY, w: geometry.w, h: geometry.h }
  }
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeStart.current
    if (start === null) return
    translatorController.setGeometry({
      ...geometry,
      w: start.w + event.clientX - start.px,
      h: start.h + event.clientY - start.py,
    })
  }
  const onResizePointerUp = (): void => { resizeStart.current = null }

  // Refresh the balance periodically while the window is open.
  useEffect(() => {
    if (!snapshot.open) return
    const timer = window.setInterval(() => { void translatorController.refreshBalance() }, 5 * 60_000)
    return () => { window.clearInterval(timer) }
  }, [snapshot.open])

  // Close the settings popover on Escape.
  useEffect(() => {
    if (!snapshot.settingsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') translatorController.closeSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [snapshot.settingsOpen])

  // Close the settings popover when clicking outside of it (the ⚙ toggle
  // button is exempt — its own click handles the flip).
  const popoverRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!snapshot.settingsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (popoverRef.current?.contains(target) === true) return
      if (target.closest('[data-settings-toggle]') !== null) return
      translatorController.closeSettings()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [snapshot.settingsOpen])

  const balanceText = snapshot.balanceState === 'loading'
    ? t('balance.loading')
    : snapshot.balanceState === 'ready' && snapshot.balance !== undefined && snapshot.balance.supported
      ? `${snapshot.balance.total.toFixed(2)} ${snapshot.balance.currency}`
      : snapshot.balanceState === 'error'
        ? '—'
        : t('balance.unsupported')

  const copyResult = async (): Promise<void> => {
    if (snapshot.result.length === 0) return
    try {
      await navigator.clipboard.writeText(snapshot.result)
      translatorController.markCopied()
    } catch {
      // Clipboard unavailable; the button simply does nothing.
    }
  }

  const onTranslateKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void translatorController.translate()
    }
  }

  const saveSettings = async (): Promise<void> => {
    translatorController.setSettingsSaving(true)
    const price = (raw: string): number | undefined => {
      const parsed = Number(raw)
      return raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0 ? undefined : parsed
    }
    const temperature = (raw: string): number | undefined => {
      const parsed = Number(raw)
      return raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 2 ? undefined : parsed
    }
    const writes: Promise<void>[] = [
      setTranslatorSetting('provider', draft.provider === 'openai' ? 'openai' : 'deepseek'),
      setTranslatorSetting('baseUrl', draft.baseUrl.trim()),
      setTranslatorSetting('model', draft.model.trim()),
      setTranslatorSetting('apiKeyEnv', draft.apiKeyEnv.trim() || 'DEEPSEEK_API_KEY'),
      ...(draft.apiKey.trim().length > 0 ? [setTranslatorSetting('apiKey', draft.apiKey.trim())] : []),
      ...(price(draft.inputPrice) !== undefined ? [setTranslatorSetting('inputPrice', price(draft.inputPrice))] : []),
      ...(price(draft.cacheHitInputPrice) !== undefined ? [setTranslatorSetting('cacheHitInputPrice', price(draft.cacheHitInputPrice))] : []),
      ...(price(draft.outputPrice) !== undefined ? [setTranslatorSetting('outputPrice', price(draft.outputPrice))] : []),
      ...(price(draft.offPeakInputPrice) !== undefined ? [setTranslatorSetting('offPeakInputPrice', price(draft.offPeakInputPrice))] : []),
      ...(price(draft.offPeakCacheHitInputPrice) !== undefined ? [setTranslatorSetting('offPeakCacheHitInputPrice', price(draft.offPeakCacheHitInputPrice))] : []),
      ...(price(draft.offPeakOutputPrice) !== undefined ? [setTranslatorSetting('offPeakOutputPrice', price(draft.offPeakOutputPrice))] : []),
      ...(temperature(draft.temperature) !== undefined ? [setTranslatorSetting('temperature', temperature(draft.temperature))] : []),
    ]
    await Promise.all(writes)
    translatorController.setSettingsSaving(false)
    translatorController.markSettingsSaved()
    void translatorController.refreshBalance()
  }

  const resetSettings = async (): Promise<void> => {
    translatorController.setSettingsSaving(true)
    await clearTranslatorSetting('apiKey')
    await Promise.all([
      setTranslatorSetting('provider', 'deepseek'),
      setTranslatorSetting('baseUrl', ''),
      setTranslatorSetting('model', ''),
      setTranslatorSetting('apiKeyEnv', 'DEEPSEEK_API_KEY'),
      setTranslatorSetting('inputPrice', 3.0),
      setTranslatorSetting('cacheHitInputPrice', 0.1),
      setTranslatorSetting('outputPrice', 9.0),
      setTranslatorSetting('offPeakInputPrice', 1.5),
      setTranslatorSetting('offPeakCacheHitInputPrice', 0.05),
      setTranslatorSetting('offPeakOutputPrice', 4.5),
      setTranslatorSetting('temperature', 0.3),
    ])
    translatorController.setSettingsSaving(false)
    translatorController.markSettingsSaved()
    void translatorController.refreshBalance()
  }

  const field = (key: keyof SettingsDraft) => ({
    value: draft[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setDraft(current => ({ ...current, [key]: event.target.value }))
    },
  })

  return (
    <>
      {snapshot.open && (
        <section
          className={css.window}
          style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h }}
          aria-label={t('title')}
        >
          <div
            className={css.header}
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={onHeaderPointerUp}
          >
            <span className={css.title}>{t('title')}</span>
            <div className={css.headerActions}>
              <button
                type="button"
                className={css.iconButton}
                data-no-drag
                data-settings-toggle
                onClick={() => { translatorController.toggleSettings() }}
                title={t('settings')}
                aria-label={t('settings')}
                data-active={snapshot.settingsOpen || undefined}
              >
                ⚙
              </button>
              <button
                type="button"
                className={css.iconButton}
                data-no-drag
                onClick={() => { translatorController.close() }}
                title={t('close')}
                aria-label={t('close')}
              >
                ✕
              </button>
            </div>
          </div>

          <div className={css.body}>
            <div className={css.langRow}>
              <label className={css.langField}>
                <span className={css.langLabel}>{t('source')}</span>
                <select
                  className={css.langSelect}
                  value={snapshot.source}
                  onChange={(event) => { translatorController.setSource(event.target.value) }}
                >
                  <option value="auto">{t('auto')}</option>
                  {LANGS.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={css.swapButton}
                onClick={() => { translatorController.swap() }}
                title={t('swap')}
                aria-label={t('swap')}
              >
                ⇄
              </button>
              <label className={css.langField}>
                <span className={css.langLabel}>{t('target')}</span>
                <select
                  className={css.langSelect}
                  value={snapshot.target}
                  onChange={(event) => { translatorController.setTarget(event.target.value) }}
                >
                  {LANGS.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <textarea
              className={css.input}
              value={snapshot.text}
              onChange={(event) => { translatorController.setText(event.target.value) }}
              onKeyDown={onTranslateKeyDown}
              placeholder={t('input.placeholder')}
              spellCheck={false}
            />
            <div className={css.actions}>
              <button
                type="button"
                className={css.primary}
                disabled={snapshot.busy || snapshot.text.trim().length === 0}
                onClick={() => { void translatorController.translate() }}
              >
                {snapshot.busy ? t('translating') : t('translate')}
              </button>
              <button
                type="button"
                className={css.secondary}
                disabled={snapshot.text.length === 0 && snapshot.result.length === 0}
                onClick={() => { translatorController.clear() }}
              >
                {t('clear')}
              </button>
              <button
                type="button"
                className={css.secondary}
                disabled={snapshot.result.length === 0}
                onClick={() => { void copyResult() }}
              >
                {snapshot.copied ? t('copied') : t('copy')}
              </button>
            </div>
            <textarea
              className={css.output}
              value={snapshot.result}
              readOnly
              placeholder={t('output.placeholder')}
              spellCheck={false}
            />
            {snapshot.error !== undefined && (
              <div className={css.error} role="alert">
                {t(ERROR_KEYS[snapshot.error.code] ?? 'error.internal')}
              </div>
            )}
          </div>

          <div className={css.footer}>
            <button
              type="button"
              className={css.balanceButton}
              onClick={() => { void translatorController.refreshBalance() }}
              title={t('balance.refresh')}
            >
              <span className={css.footerLabel}>{t('balance')}</span>
              <span className={css.footerValue}>{balanceText}</span>
            </button>
            <span className={css.footerDot}>·</span>
            <span className={css.today} title={t('usage.estimate')}>
              <span className={css.footerLabel}>{t('today')}</span>
              <span className={css.footerValue}>¥{snapshot.todayCost.toFixed(4)}</span>
            </span>
            {snapshot.last !== undefined && (
              <span className={css.lastMeta}>
                {snapshot.last.model} · {snapshot.last.totalTokens} {t('last.tokens')} · {(snapshot.last.latencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {snapshot.settingsOpen && (
            <div className={css.settingsPopover} role="dialog" aria-label={t('settings.title')} ref={popoverRef}>
              <div className={css.settingsTitleRow}>
                <span className={css.settingsTitle}>{t('settings.title')}</span>
                <button
                  type="button"
                  className={css.settingsClose}
                  onClick={() => { translatorController.closeSettings() }}
                  title={t('close')}
                  aria-label={t('close')}
                >
                  ✕
                </button>
              </div>
              <label className={css.settingsField}>
                <span>{t('settings.provider')}</span>
                <select {...field('provider')}>
                  <option value="deepseek">{t('settings.provider.deepseek')}</option>
                  <option value="openai">{t('settings.provider.openai')}</option>
                </select>
              </label>
              <label className={css.settingsField}>
                <span>{t('settings.baseUrl')}</span>
                <input type="text" spellCheck={false} {...field('baseUrl')} />
              </label>
              <label className={css.settingsField}>
                <span>{t('settings.model')}</span>
                <input type="text" spellCheck={false} {...field('model')} />
              </label>
              <label className={css.settingsField}>
                <span>{t('settings.apiKey')}</span>
                <input type="password" autoComplete="off" spellCheck={false} {...field('apiKey')} />
              </label>
              <div className={css.settingsGroup}>
                <span className={css.settingsGroupLabel}>{t('settings.peakGroup')}</span>
                <div className={css.settingsRow}>
                  <label className={css.settingsField}>
                    <span>{t('settings.inputPrice')}</span>
                    <input type="number" min="0" step="0.01" {...field('inputPrice')} />
                  </label>
                  <label className={css.settingsField}>
                    <span>{t('settings.cacheHitInputPrice')}</span>
                    <input type="number" min="0" step="0.01" {...field('cacheHitInputPrice')} />
                  </label>
                </div>
                <label className={css.settingsField}>
                  <span>{t('settings.outputPrice')}</span>
                  <input type="number" min="0" step="0.01" {...field('outputPrice')} />
                </label>
              </div>
              <div className={css.settingsGroup}>
                <span className={css.settingsGroupLabel}>{t('settings.offPeakGroup')}</span>
                <div className={css.settingsRow}>
                  <label className={css.settingsField}>
                    <span>{t('settings.offPeakInputPrice')}</span>
                    <input type="number" min="0" step="0.01" {...field('offPeakInputPrice')} />
                  </label>
                  <label className={css.settingsField}>
                    <span>{t('settings.offPeakCacheHitInputPrice')}</span>
                    <input type="number" min="0" step="0.01" {...field('offPeakCacheHitInputPrice')} />
                  </label>
                </div>
                <label className={css.settingsField}>
                  <span>{t('settings.offPeakOutputPrice')}</span>
                  <input type="number" min="0" step="0.01" {...field('offPeakOutputPrice')} />
                </label>
              </div>
              <div className={css.priceHint}>{t('settings.priceHint')}</div>
              <label className={css.settingsField}>
                <span>{t('settings.temperature')}</span>
                <input type="number" min="0" max="2" step="0.1" {...field('temperature')} />
              </label>
              <div className={css.settingsActions}>
                <button
                  type="button"
                  className={css.primary}
                  disabled={snapshot.settingsSaving}
                  onClick={() => { void saveSettings() }}
                >
                  {snapshot.settingsSaving ? t('settings.saving') : snapshot.settingsSaved ? t('settings.saved') : t('settings.save')}
                </button>
                <button
                  type="button"
                  className={css.secondary}
                  disabled={snapshot.settingsSaving}
                  onClick={() => { void resetSettings() }}
                >
                  {t('settings.reset')}
                </button>
              </div>
            </div>
          )}
          <div
            className={css.resizeHandle}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            role="separator"
            aria-label="resize"
          />
        </section>
      )}

      <button
        type="button"
        className={css.fab}
        onClick={() => { translatorController.toggle() }}
        title={snapshot.open ? t('fab.close') : t('fab.label')}
        aria-label={snapshot.open ? t('fab.close') : t('fab.label')}
        aria-expanded={snapshot.open || undefined}
        data-open={snapshot.open || undefined}
      >
        {snapshot.open ? (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"
            />
          </svg>
        )}
      </button>
    </>
  )
}
