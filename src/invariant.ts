/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-translator`.
 * @module @deepseek-ai/dsh-translator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-translator'

/** Cordis companion plugin name. */
export const name = 'dsh-translator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant today: the translator is a stateless HTTP route set
 * over provider APIs plus a browser window; its only mutable state (the
 * daily-usage ledger) lives in the browser and is reset by the window.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
