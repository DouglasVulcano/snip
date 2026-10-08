import type { Register } from 'claude-code'

import { approxTokens, prune, readConfig, savedPercent } from './prune'

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const triggerPercent = num(options.triggerPercent, 35)
  const retryGrowth = num(options.retryGrowth, 5)
  const minSavings = num(options.minSavingsPercent, 15)

  // Context percentage at which the last proactive prune found nothing; avoids retrying every turn.
  let lastFutileAt: number | undefined

  // Every compaction (/compact, automatic, proactive, precompute) goes through here:
  // prune the tool results and hand back the original conversation, with no summary.
  on('session.compact', ($, e, next) => {
    const result = prune(e.messages, cfg)
    const saved = savedPercent(result)

    if (saved < minSavings) {
      // Proactive: give up. Everything else falls back to Claude Code's own summary.
      return e.trigger === 'plugin'
        ? { skip: `snip: nothing worth pruning (${saved.toFixed(0)}%)` }
        : next(e)
    }

    if (e.trigger !== 'precompute') {
      const tokens = approxTokens(result.chars.before - result.chars.after)
      $.ui.toast(
        `snip: pruned ~${tokens} tokens (estimate): ` +
          `${result.dropped} stale results dropped, ${result.truncated} truncated`,
        { timeoutMs: 6000 },
      )
    }
    return { messages: result.messages }
  }).catch(($, e, next) => next(e))

  if (triggerPercent <= 0) return

  // Prune before the window fills up: Claude Code only compacts close to the limit.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.reason !== 'answer' || e.agentId !== undefined) return out

    const { context } = await $.session.usage()
    const percent = context.percent
    if (percent === undefined) return out

    if (percent < triggerPercent) {
      lastFutileAt = undefined
      return out
    }
    if (lastFutileAt !== undefined && percent < lastFutileAt + retryGrowth) return out

    // compact only runs between turns; turn.complete itself is the allowed point.
    try {
      const done = await $.session.compact()
      if (done.skip !== undefined) lastFutileAt = percent
    } catch (err) {
      lastFutileAt = percent
      $.ui.toast(`snip: proactive prune failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return out
  })
}
