#!/usr/bin/env node
// Replays real Claude Code transcripts through Snip's pruner and reports how
// much of each conversation it would remove. Offline: no API calls, no model.
//
//   node bench/replay.mjs [--projects <dir>] [--min-messages 30] [--out bench/results/replay.json]
//
// Only aggregate numbers are written. Nothing from your sessions' content is kept.

import { createReadStream, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'

import { prune, readConfig } from '../hooks/prune.ts'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const projectsDir = args.projects ?? join(homedir(), '.claude', 'projects')
const minMessages = Number(args['min-messages'] ?? 30)
const outFile = args.out ?? 'bench/results/replay.json'

const textOf = c =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : ''

/** Rebuilds the engine's message view (`SessionMessage`) from a transcript file. */
async function loadSession(file) {
  let messages = []
  let lastAssistantId
  // Streamed: transcripts of long sessions can exceed what a single string holds.
  for await (const line of createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      messages = [] // a compaction happened here: only what follows counts
      lastAssistantId = undefined
      continue
    }
    if (row.isSidechain || !row.message || (row.type !== 'user' && row.type !== 'assistant')) continue

    const content = row.message.content
    if (row.type === 'assistant') {
      const id = row.message.id
      let m = id && id === lastAssistantId ? messages.at(-1) : undefined
      if (!m) {
        m = { role: 'assistant', text: '', toolUses: [] }
        messages.push(m)
        lastAssistantId = id
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text') m.text += (m.text ? '\n' : '') + b.text
        else if (b.type === 'tool_use') m.toolUses.push({ tool_use_id: b.id, tool: b.name, input: b.input ?? {} })
      }
    } else {
      lastAssistantId = undefined
      const m = { role: 'user', text: '', toolUses: [] }
      if (typeof content === 'string') m.text = content
      else {
        m.text = textOf(content)
        const results = (content ?? []).filter(b => b?.type === 'tool_result')
        if (results.length)
          m.toolResults = results.map(b => ({
            tool_use_id: b.tool_use_id,
            text: textOf(b.content) || (typeof b.content === 'string' ? b.content : ''),
            isError: Boolean(b.is_error),
          }))
      }
      messages.push(m)
    }
  }
  return messages.map((m, i) => ({ ...m, handle: `h${i}` })) // as the engine hands them to a hook
}

const chars = m =>
  m.text.length + (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0) + m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length, 0)

function composition(messages) {
  const byTool = {}
  const toolOf = new Map(messages.flatMap(m => m.toolUses.map(u => [u.tool_use_id, u.tool])))
  let userText = 0
  let assistantText = 0
  let toolCalls = 0
  let toolResults = 0
  for (const m of messages) {
    if (m.role === 'user') userText += m.text.length
    else assistantText += m.text.length
    toolCalls += m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length, 0)
    for (const r of m.toolResults ?? []) {
      toolResults += r.text.length
      const t = toolOf.get(r.tool_use_id) ?? 'unknown'
      const key = t.startsWith('mcp__') ? 'mcp' : ['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'Task'].includes(t) ? t : 'other'
      byTool[key] = (byTool[key] ?? 0) + r.text.length
    }
  }
  return { userText, assistantText, toolCalls, toolResults, byTool }
}

function* transcripts(dir) {
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const f of readdirSync(join(dir, project.name), { withFileTypes: true }))
      if (f.isFile() && f.name.endsWith('.jsonl')) yield join(dir, project.name, f.name)
  }
}

const presets = {
  default: {},
  resultsOnly: { pruneInputs: false },
  gentle: { keepMaxChars: 4000, preserveRecent: 16 },
  aggressive: { keepMaxChars: 1000, preserveRecent: 4, headChars: 400, tailChars: 200 },
}

const sessions = []
for (const file of transcripts(projectsDir)) {
  if (statSync(file).size < 20_000) continue
  const messages = await loadSession(file)
  if (messages.length < minMessages) continue
  const before = messages.reduce((n, m) => n + chars(m), 0)
  const row = { messages: messages.length, chars: before, composition: composition(messages), presets: {} }
  for (const [name, opts] of Object.entries(presets)) {
    const cfg = readConfig(opts)
    const t0 = performance.now()
    const r = prune(messages, cfg)
    const ms = performance.now() - t0
    row.presets[name] = {
      after: r.chars.after,
      dropped: r.dropped,
      truncated: r.truncated,
      inputsTruncated: r.inputsTruncated,
      ms: Number(ms.toFixed(2)),
    }
  }
  sessions.push(row)
}

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0)
const pct = (a, b) => (b === 0 ? 0 : (a / b) * 100)
const median = xs => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const buckets = [
  ['< 10k tokens', 0, 40_000],
  ['10k–50k', 40_000, 200_000],
  ['50k–150k', 200_000, 600_000],
  ['> 150k', 600_000, Infinity],
]

const summary = { sessions: sessions.length, totalChars: sum(sessions, s => s.chars), presets: {}, buckets: {}, composition: {} }
for (const name of Object.keys(presets)) {
  const saved = sessions.map(s => pct(s.chars - s.presets[name].after, s.chars))
  summary.presets[name] = {
    overallSavedPct: Number(pct(sum(sessions, s => s.chars - s.presets[name].after), summary.totalChars).toFixed(1)),
    medianSavedPct: Number(median(saved).toFixed(1)),
    p90SavedPct: Number([...saved].sort((a, b) => a - b)[Math.floor(saved.length * 0.9)]?.toFixed(1) ?? 0),
    droppedPerSession: Number((sum(sessions, s => s.presets[name].dropped) / sessions.length).toFixed(1)),
    truncatedPerSession: Number((sum(sessions, s => s.presets[name].truncated) / sessions.length).toFixed(1)),
    maxMs: Math.max(...sessions.map(s => s.presets[name].ms)),
    medianMs: median(sessions.map(s => s.presets[name].ms)),
  }
}
for (const [label, lo, hi] of buckets) {
  const group = sessions.filter(s => s.chars >= lo && s.chars < hi)
  if (!group.length) continue
  summary.buckets[label] = {
    sessions: group.length,
    medianSavedPct: Number(median(group.map(s => pct(s.chars - s.presets.default.after, s.chars))).toFixed(1)),
    overallSavedPct: Number(pct(sum(group, s => s.chars - s.presets.default.after), sum(group, s => s.chars)).toFixed(1)),
  }
}
const c = sessions.map(s => s.composition)
const totalComp = sum(c, x => x.userText + x.assistantText + x.toolCalls + x.toolResults)
summary.composition = {
  userTextPct: Number(pct(sum(c, x => x.userText), totalComp).toFixed(1)),
  assistantTextPct: Number(pct(sum(c, x => x.assistantText), totalComp).toFixed(1)),
  toolCallsPct: Number(pct(sum(c, x => x.toolCalls), totalComp).toFixed(1)),
  toolResultsPct: Number(pct(sum(c, x => x.toolResults), totalComp).toFixed(1)),
  toolResultsByTool: Object.fromEntries(
    Object.entries(c.reduce((acc, x) => (Object.entries(x.byTool).forEach(([k, v]) => (acc[k] = (acc[k] ?? 0) + v)), acc), {})).map(([k, v]) => [
      k,
      Number(pct(v, sum(c, x => x.toolResults)).toFixed(1)),
    ]),
  ),
}

// Per-session numbers are anonymous: sizes and counts only.
const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  minMessages,
  tokenEstimate: 'characters / 4',
  summary,
  sessions: sessions.map((s, i) => ({ id: i + 1, messages: s.messages, chars: s.chars, default: s.presets.default })),
}
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(out, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.error(`\n${sessions.length} sessions replayed → ${outFile}`)
