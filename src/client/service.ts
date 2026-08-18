/**
 * Browser-half service of the translator: the `/translator/*` wire client,
 * the daily-usage ledger (localStorage, cost estimated from token usage and
 * the configured pricing), and the tiny snapshot store the window renders.
 */

import { useSyncExternalStore } from 'react'
import type {
  BalanceResponse, StatusResponse, TranslateRequest, TranslateResponse,
} from '../types.ts'

/** One ledger row per local day. */
export interface LedgerRow {
  /** Local date key, YYYY-MM-DD. */
  date: string
  /** Accumulated estimated cost in CNY (¥). */
  cost: number
  /** Number of requests served. */
  count: number
}

// v2: the ledger switched from USD to CNY (¥) with the official DeepSeek
// pricing table; v1 entries are dropped rather than mixed.
const LEDGER_KEY = 'dsh.translator.usage.v2'
const WINDOW_KEY = 'dsh.translator.window.v1'
const LEDGER_KEEP_DAYS = 30

/** Local date key of now. */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Read the persisted ledger, pruning rows older than {@link LEDGER_KEEP_DAYS}. */
export function readLedger(): LedgerRow[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const today = todayKey()
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - LEDGER_KEEP_DAYS)
    const cutoffKey = todayKey(cutoff)
    return parsed.filter((row): row is LedgerRow => {
      if (typeof row !== 'object' || row === null) return false
      const candidate = row as Record<string, unknown>
      return typeof candidate.date === 'string'
        && typeof candidate.cost === 'number'
        && typeof candidate.count === 'number'
        && candidate.date <= today
        && candidate.date >= cutoffKey
    })
  } catch {
    return []
  }
}

/** Persist the ledger. */
function writeLedger(rows: LedgerRow[]): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(rows))
  } catch {
    // Quota / private mode: the ledger simply does not persist.
  }
}

/** Record one request's estimated cost (CNY) against today's row. */
export function recordUsage(cost: number): LedgerRow {
  const rows = readLedger()
  const today = todayKey()
  const index = rows.findIndex(row => row.date === today)
  if (index >= 0) {
    const existing = rows[index] as LedgerRow
    const next = { date: today, cost: existing.cost + cost, count: existing.count + 1 }
    rows[index] = next
    writeLedger(rows)
    return next
  }
  const created = { date: today, cost, count: 1 }
  rows.push(created)
  writeLedger(rows)
  return created
}

/** Estimated CNY cost consumed today, from the ledger. */
export function todayCost(): number {
  const today = todayKey()
  return readLedger().find(row => row.date === today)?.cost ?? 0
}

/** Persisted window geometry. */
export interface WindowGeometry {
  x: number
  y: number
  w: number
  h: number
}

/** Read the persisted window geometry, clamped to the viewport. */
export function readGeometry(): WindowGeometry {
  const fallback: WindowGeometry = { x: 0, y: 0, w: 0, h: 0 }
  try {
    const raw = localStorage.getItem(WINDOW_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const numberOr = (value: unknown, def: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : def
    return {
      x: numberOr(parsed.x, 0),
      y: numberOr(parsed.y, 0),
      w: numberOr(parsed.w, 0),
      h: numberOr(parsed.h, 0),
    }
  } catch {
    return fallback
  }
}

/** Persist the window geometry. */
export function writeGeometry(geometry: WindowGeometry): void {
  try {
    localStorage.setItem(WINDOW_KEY, JSON.stringify(geometry))
  } catch {
    // Non-fatal: geometry just resets on the next session.
  }
}

/** POST one JSON body to a translator route. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`translator route HTTP ${response.status}`)
  return await response.json() as T
}

/** GET one translator route. */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`translator route HTTP ${response.status}`)
  return await response.json() as T
}

/** Request one translation through the host. */
export function requestTranslate(request: TranslateRequest): Promise<TranslateResponse> {
  return postJson<TranslateResponse>('/translator/translate', request)
}

/** Refresh the provider balance snapshot. */
export function requestBalance(): Promise<BalanceResponse> {
  return getJson<BalanceResponse>('/translator/balance')
}

/** Refresh the translator status snapshot. */
export function requestStatus(): Promise<StatusResponse> {
  return getJson<StatusResponse>('/translator/status')
}

/** Metadata of the last completed translation. */
export interface LastTranslate {
  model: string
  /** Estimated cost in CNY (¥), for future display. */
  cost: number
  latencyMs: number
  totalTokens: number
}

/** One translation error as shown by the window. */
export interface TranslateError {
  /** Stable failure code from the wire. */
  code: string
  /** Raw wire detail. */
  detail: string
}

/** Derive the display error from a failure response. */
export function errorOf(response: Extract<TranslateResponse, { ok: false }>): TranslateError {
  return { code: response.code, detail: response.error }
}

/** Live snapshot the window renders. */
export interface TranslatorSnapshot {
  /** Whether the window is shown. */
  open: boolean
  /** Window geometry (unclamped viewport offsets). */
  geometry: WindowGeometry
  /** Source language code, or 'auto'. */
  source: string
  /** Target language code. */
  target: string
  /** Source text. */
  text: string
  /** Latest translation result. */
  result: string
  /** Whether a translation is in flight. */
  busy: boolean
  /** Balance display state. */
  balanceState: 'idle' | 'loading' | 'ready' | 'error'
  /** Balance snapshot; undefined until the first success. */
  balance: Extract<BalanceResponse, { ok: true }>['balance'] | undefined
  /** Balance failure text. */
  balanceError: string
  /** Estimated USD consumed today. */
  todayCost: number
  /** Metadata of the last completed translation. */
  last: LastTranslate | undefined
  /** Last translation error. */
  error: TranslateError | undefined
  /** Whether the settings popover is open. */
  settingsOpen: boolean
  /** Whether a settings write is in flight. */
  settingsSaving: boolean
  /** Whether the settings write just landed. */
  settingsSaved: boolean
  /** Whether the copy action just landed. */
  copied: boolean
}

/** Window placement defaults (px). */
const DEFAULT_W = 420
const DEFAULT_H = 520
const DEFAULT_X = 24
const DEFAULT_Y = 24

/** Clamp geometry into the viewport. */
function clampGeometry(geometry: WindowGeometry): WindowGeometry {
  const w = Math.max(320, Math.min(geometry.w > 0 ? geometry.w : DEFAULT_W, window.innerWidth - 16))
  const h = Math.max(280, Math.min(geometry.h > 0 ? geometry.h : DEFAULT_H, window.innerHeight - 16))
  const x = Math.max(8, Math.min(geometry.x, Math.max(8, window.innerWidth - w - 8)))
  const y = Math.max(8, Math.min(geometry.y, Math.max(8, window.innerHeight - h - 8)))
  return { x, y, w, h }
}

/**
 * The window's state machine and action surface. One instance lives for the
 * plugin lifetime; React binds to it through {@link useTranslatorSnapshot}.
 */
export class TranslatorController {
  private snapshot: TranslatorSnapshot
  private readonly listeners = new Set<() => void>()

  constructor() {
    const persisted = readGeometry()
    const geometry = persisted.w > 0 && persisted.h > 0
      ? clampGeometry(persisted)
      : { x: DEFAULT_X, y: DEFAULT_Y, w: DEFAULT_W, h: DEFAULT_H }
    this.snapshot = {
      open: false,
      geometry,
      source: 'auto',
      target: 'zh-CN',
      text: '',
      result: '',
      busy: false,
      balanceState: 'idle',
      balance: undefined,
      balanceError: '',
      todayCost: todayCost(),
      last: undefined,
      error: undefined,
      settingsOpen: false,
      settingsSaving: false,
      settingsSaved: false,
      copied: false,
    }
  }

  /** @returns the current immutable snapshot. */
  getSnapshot(): TranslatorSnapshot {
    return this.snapshot
  }

  /** Subscribe to snapshot replacements. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<TranslatorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Toggle the window; opening triggers a balance refresh. */
  toggle(): void {
    const next = !this.snapshot.open
    this.set({ open: next })
    if (next) void this.refreshBalance()
  }

  /** Open the window (no-op when already open). */
  open(): void {
    if (!this.snapshot.open) this.toggle()
  }

  /** Close the window. */
  close(): void {
    this.set({ open: false, settingsOpen: false })
  }

  /** Update the window geometry (clamped) and persist it. */
  setGeometry(geometry: WindowGeometry): void {
    const clamped = clampGeometry(geometry)
    this.set({ geometry: clamped })
    writeGeometry(clamped)
  }

  /** Update the source language. */
  setSource(source: string): void {
    this.set({ source })
  }

  /** Update the target language. */
  setTarget(target: string): void {
    this.set({ target })
  }

  /** Swap source and target; an 'auto' source becomes concrete after a swap. */
  swap(): void {
    const { source, target } = this.snapshot
    this.set({ source: target, target: source })
  }

  /** Update the source text. */
  setText(text: string): void {
    this.set({ text })
  }

  /** Clear text and result. */
  clear(): void {
    this.set({ text: '', result: '', error: undefined })
  }

  /** Mark the result as copied for a short flash. */
  markCopied(): void {
    this.set({ copied: true })
    setTimeout(() => { this.set({ copied: false }) }, 1200)
  }

  /** Run one translation. */
  async translate(): Promise<void> {
    const text = this.snapshot.text.trim()
    if (text.length === 0 || this.snapshot.busy) return
    this.set({ busy: true, error: undefined })
    try {
      const response = await requestTranslate({
        text,
        source: this.snapshot.source,
        target: this.snapshot.target,
      })
      if (response.ok) {
        recordUsage(response.cost)
        this.set({
          result: response.translated,
          todayCost: todayCost(),
          last: {
            model: response.model,
            cost: response.cost,
            latencyMs: response.latencyMs,
            totalTokens: response.usage.totalTokens,
          },
        })
        void this.refreshBalance()
      } else {
        this.set({ error: errorOf(response) })
      }
    } catch (error) {
      this.set({ error: { code: 'internal', detail: String(error) } })
    } finally {
      this.set({ busy: false })
    }
  }

  /** Refresh the provider balance snapshot. */
  async refreshBalance(): Promise<void> {
    if (this.snapshot.balanceState === 'loading') return
    this.set({ balanceState: 'loading', balanceError: '' })
    try {
      const response = await requestBalance()
      if (response.ok) {
        this.set({ balanceState: 'ready', balance: response.balance, balanceError: '' })
      } else {
        this.set({ balanceState: 'error', balanceError: response.error })
      }
    } catch (error) {
      this.set({ balanceState: 'error', balanceError: String(error) })
    }
  }

  /** Open or close the settings popover. */
  toggleSettings(): void {
    this.set({ settingsOpen: !this.snapshot.settingsOpen, settingsSaved: false })
  }

  /** Close the settings popover (idempotent). */
  closeSettings(): void {
    if (this.snapshot.settingsOpen) this.set({ settingsOpen: false, settingsSaved: false })
  }

  /** Set the settings saving flag. */
  setSettingsSaving(saving: boolean): void {
    this.set({ settingsSaving: saving })
  }

  /** Mark the settings write as landed. */
  markSettingsSaved(): void {
    this.set({ settingsSaved: true })
    setTimeout(() => { this.set({ settingsSaved: false }) }, 1500)
  }
}

/** The singleton controller the window renders. */
export const translatorController = new TranslatorController()

/** React binding over the controller snapshot. */
export function useTranslatorSnapshot(): TranslatorSnapshot {
  return useSyncExternalStore(
    listener => translatorController.subscribe(listener),
    () => translatorController.getSnapshot(),
  )
}
