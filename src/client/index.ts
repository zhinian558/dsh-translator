/**
 * Translator plugin, browser half: one entry in the frame-wide
 * `shell.overlay` slot rendering the floating translation window and its
 * toggle button, plus the `translator` locale namespace. All provider work
 * stays on the host routes; this half only renders and persists the window's
 * own state.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settingsScope Context merge (dsh-client-ui-settings) and the
// shell.overlay SlotMap declaration (dsh-client-ui-layout). The `remote` and
// `connection` services in the inject list carry no type needs here.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TranslatorOverlay } from './TranslatorWindow.tsx'
import { en, zh, type TranslatorKey } from './locales.ts'
import { initTranslatorSettings } from './settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The translator window's copy. */
    'translator': TranslatorKey
  }
}

/** Namespace owning the translator copy. */
const NS = 'translator'

/** Required services: slot registration, locale dictionaries, and the settings scope transport. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: bind the settings scope, register the dictionaries,
 * and mount the overlay entry once the frame declares `shell.overlay`.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  initTranslatorSettings(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'translator: window dictionaries')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'translator',
    order: 20,
    locale: NS,
  }, TranslatorOverlay))
}
