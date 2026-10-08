import type { PluginOptions, SessionMessage } from 'claude-code'

export type PruneConfig = {
  /** Trailing messages that are never touched. */
  preserveRecent: number
  /** Old tool results longer than this are cut. */
  keepMaxChars: number
  /** Characters kept from the start of a cut result. */
  headChars: number
  /** Characters kept from the end of a cut result. */
  tailChars: number
  /** Tools whose calls and results are never pruned. */
  keepTools: ReadonlySet<string>
  /** Also cut the long fields of old tool calls (the content of a `Write`, say). */
  pruneInputs: boolean
  /**
   * Rebuilds, without the engine's `handle`, the untouched messages that come
   * after the first pruned one. A message the engine keeps retains its old
   * `parentUuid` in the transcript, so on resume the chain walks back through
   * the original history and the pruning is lost. Messages before the first
   * pruned one stay as they are, with their context attachments (skill list,
   * date, environment) hanging off them.
   */
  relink: boolean
}

export type PruneResult = {
  messages: SessionMessage[]
  chars: { before: number; after: number }
  /** Tool results replaced by a one-line marker. */
  dropped: number
  /** Tool results cut down to head and tail. */
  truncated: number
  /** Long fields of old tool calls (a `Write`'s content, say) cut down to head and tail. */
  inputsTruncated: number
}

type ToolResult = NonNullable<SessionMessage['toolResults']>[number]
type ToolUse = SessionMessage['toolUses'][number]

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function readConfig(options: PluginOptions): PruneConfig {
  const tools = typeof options.keepTools === 'string' ? options.keepTools : ''
  return {
    preserveRecent: num(options.preserveRecent, 8),
    keepMaxChars: num(options.keepMaxChars, 2000),
    headChars: num(options.headChars, 600),
    tailChars: num(options.tailChars, 300),
    keepTools: new Set(
      tools
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
    ),
    pruneInputs: options.pruneInputs !== false,
    relink: options.relink !== false,
  }
}

/** The message without a `handle`: the engine builds it again from role, text and tool blocks. */
const rebuilt = (m: SessionMessage, toolResults = m.toolResults, toolUses = m.toolUses): SessionMessage =>
  toolResults ? { role: m.role, text: m.text, toolUses, toolResults } : { role: m.role, text: m.text, toolUses }

/**
 * Cuts the long string fields of a tool call's input (the content of a `Write`,
 * the strings of an `Edit`), keeping the shape. The file on disk is the truth,
 * so the old text is dead weight. Returns the same object when nothing is cut.
 */
function truncateInput(input: Record<string, unknown>, cfg: PruneConfig): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > cfg.keepMaxChars) {
      out ??= { ...input }
      out[k] = truncateText(v, cfg.headChars, cfg.tailChars)
    }
  }
  return out ?? input
}

/**
 * Key of "the same query": a later identical call makes the earlier one
 * obsolete. `undefined` when repeating the call does not replace the earlier one.
 */
export function supersedeKey(use: ToolUse): string | undefined {
  const i = use.input
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  switch (use.tool) {
    case 'Read':
      // Reading another range of the same file does not replace the earlier read.
      return s(i.file_path) && `Read\0${s(i.file_path)}\0${i.offset ?? ''}\0${i.limit ?? ''}`
    case 'Bash':
      return s(i.command) && `Bash\0${s(i.command)}`
    case 'Grep':
      return s(i.pattern) && `Grep\0${JSON.stringify(i)}`
    case 'Glob':
      return s(i.pattern) && `Glob\0${s(i.pattern)}\0${s(i.path) ?? ''}`
    case 'WebFetch':
      return s(i.url) && `WebFetch\0${s(i.url)}\0${s(i.prompt) ?? ''}`
    default:
      return undefined
  }
}

/** Short label of a call, for the marker that takes the place of its result. */
export function describeUse(use: ToolUse | undefined): string {
  if (!use) return 'tool call'
  const i = use.input
  const first = [i.file_path, i.command, i.pattern, i.url, i.query, i.path].find(
    v => typeof v === 'string' && v.length > 0,
  ) as string | undefined
  const arg = first ? ` ${first.replace(/\s+/g, ' ').slice(0, 100)}` : ''
  return `${use.tool}${arg}`
}

export function truncateText(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n[… ${cut} characters pruned by Bonsai …]\n${tail > 0 ? text.slice(-tail) : ''}`
}

const messageChars = (m: SessionMessage): number =>
  m.text.length +
  (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0) +
  m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length, 0)

export function prune(messages: readonly SessionMessage[], cfg: PruneConfig): PruneResult {
  const uses = new Map<string, ToolUse>()
  // Last call of each query: every earlier occurrence is obsolete.
  const lastSeen = new Map<string, string>()
  for (const m of messages) {
    for (const u of m.toolUses) {
      uses.set(u.tool_use_id, u)
      const key = supersedeKey(u)
      if (key) lastSeen.set(key, u.tool_use_id)
    }
  }

  const protectedFrom = Math.max(0, messages.length - cfg.preserveRecent)
  let dropped = 0
  let truncated = 0
  let inputsTruncated = 0

  const pruned = messages.map((m, index): SessionMessage => {
    if (index >= protectedFrom) return m

    let changed = false
    let toolUses = m.toolUses
    if (cfg.pruneInputs) {
      toolUses = m.toolUses.map((u): ToolUse => {
        if (cfg.keepTools.has(u.tool)) return u
        const input = truncateInput(u.input, cfg)
        if (input === u.input) return u
        changed = true
        inputsTruncated++
        return { ...u, input }
      })
    }

    if (!m.toolResults?.length) return changed ? rebuilt(m, undefined, toolUses) : m

    const toolResults = m.toolResults.map((r): ToolResult => {
      const use = uses.get(r.tool_use_id)
      if (use && cfg.keepTools.has(use.tool)) return r

      const key = use && supersedeKey(use)
      const isSuperseded = key !== undefined && lastSeen.get(key) !== r.tool_use_id
      if (isSuperseded) {
        changed = true
        dropped++
        const firstLine = r.isError ? ` — error: ${r.text.split('\n')[0]?.slice(0, 120)}` : ''
        return {
          ...r,
          text: `[Bonsai pruned this result: ${describeUse(use)} (${r.text.length} chars); the same call was repeated later${firstLine}]`,
        }
      }

      if (r.text.length > cfg.keepMaxChars) {
        changed = true
        truncated++
        return { ...r, text: truncateText(r.text, cfg.headChars, cfg.tailChars) }
      }
      return r
    })

    return changed ? rebuilt(m, toolResults, toolUses) : m
  })

  // Where the rebuilding starts. A changed tool result also pulls in the assistant
  // message that made the call, so the call and its result are rewritten together.
  let relinkFrom = -1
  pruned.forEach((m, i) => {
    if (m === messages[i]) return
    const from = messages[i]!.toolResults?.length ? Math.max(0, i - 1) : i
    if (relinkFrom < 0 || from < relinkFrom) relinkFrom = from
  })
  const next =
    cfg.relink && relinkFrom >= 0
      ? pruned.map((m, i) => (i >= relinkFrom && m.handle !== undefined ? rebuilt(m) : m))
      : pruned

  return {
    messages: next,
    chars: {
      before: messages.reduce((n, m) => n + messageChars(m), 0),
      after: next.reduce((n, m) => n + messageChars(m), 0),
    },
    dropped,
    truncated,
    inputsTruncated,
  }
}

/** Rough token estimate: ~4 characters per token. */
export const approxTokens = (chars: number): number => Math.round(chars / 4)

export const savedPercent = (r: PruneResult): number =>
  r.chars.before === 0 ? 0 : ((r.chars.before - r.chars.after) / r.chars.before) * 100
