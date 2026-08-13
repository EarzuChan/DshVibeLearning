import type { Context } from '@deepseek-ai/cordis'

/** Plugin display name — also the fiber name in diagnostics. */
export const name = 'dsh-vibe-learning'

/**
 * Plugin entry point. Cordis calls `apply` once the declared injections are
 * ready. Every contribution — tools, skill providers, event listeners — is an
 * effect registered through `ctx`, and unwinds automatically when this
 * plugin's fiber unloads.
 */
export function apply(_ctx: Context): void {
  console.log('[dsh-vibe-learning] plugin loaded')
}
