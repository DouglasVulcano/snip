#!/usr/bin/env node
// End-to-end benchmark against the real Claude Code engine.
//
// Every run builds the same small project, walks a model through a realistic
// exploration session (reads, a grep, a re-read), compacts it (or not), then asks
// recall questions. Arms:
//
//   control  no compaction at all
//   builtin  Claude Code's own /compact (model-written summary)
//   bonsai   /compact with this plugin loaded
//
// Modes: `live` asks in the same process; `resume` closes the process and asks
// after `claude --continue`.
//
//   node bench/e2e.mjs --trials 5 --concurrency 3 --out bench/results/e2e.json
//
// It spends real API/subscription usage (see `cost` in the output).

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NEEDLES, describeNeedle, makeProject } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const trials = Number(args.trials ?? 5)
const concurrency = Number(args.concurrency ?? 3)
const model = args.model ?? 'haiku'
const arms = (args.arms ?? 'control,builtin,bonsai').split(',')
const modes = (args.modes ?? 'live,resume').split(',')
const pluginDir = resolve(args.plugin ?? join(here, '..'))
const workRoot = resolve(args.work ?? join(tmpdir(), 'bonsai-bench'))
const outFile = args.out ?? join(here, 'results', 'e2e.json')
const pluginOptions = args['plugin-options'] ? JSON.parse(args['plugin-options']) : undefined
const TURN_TIMEOUT_MS = 240_000

// `bonsai` runs with the plugin's defaults; `bonsai-tight` trades safety margin for savings.
const ARM_OPTIONS = {
  bonsai: {},
  'bonsai-tight': { preserveRecent: 4, keepMaxChars: 1000, headChars: 400, tailChars: 200 },
}

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)

/** One `claude -p` process fed over stream-json, one message at a time. */
class Session {
  constructor({ cwd, plugin, resume, debugFile, settingsFile }) {
    const flags = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--allowedTools', 'Read,Grep', '--debug-file', debugFile]
    if (plugin) flags.push('--plugin-dir', pluginDir)
    if (settingsFile) flags.push('--settings', settingsFile)
    if (resume) flags.push('--continue')
    this.proc = spawn('claude', flags, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.buffer = ''
    this.waiting = null
    this.toolUses = 0
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk
      let nl
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (line.startsWith('{')) this.#event(JSON.parse(line))
      }
    })
    this.proc.on('exit', code => this.waiting?.reject(new Error(`claude exited (${code}) before answering`)))
  }

  #event(e) {
    if (e.type === 'assistant') this.toolUses += (e.message?.content ?? []).filter(b => b.type === 'tool_use').length
    if (e.type === 'result') this.waiting?.resolve(e)
  }

  /** Sends one user message and resolves with the `result` event plus wall-clock time. */
  send(text) {
    const started = Date.now()
    this.toolUses = 0
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout waiting for: ${text.slice(0, 40)}`)), TURN_TIMEOUT_MS)
      this.waiting = {
        resolve: e => (clearTimeout(timer), res({ event: e, ms: Date.now() - started, toolUses: this.toolUses })),
        reject: err => (clearTimeout(timer), rej(err)),
      }
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    })
  }

  async close() {
    this.proc.stdin.end()
    await new Promise(r => (this.proc.exitCode !== null ? r() : this.proc.on('exit', r)))
  }
}

const toNumber = s => {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim())
  return m ? Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()])) : NaN
}

/** Reads the `/context` table: total tokens in use and the Messages row. */
function parseContext(text) {
  const total = /\*\*Tokens:\*\*\s*([\d.]+[km]?)/i.exec(text)?.[1]
  const messages = /\|\s*Messages\s*\|\s*([\d.]+[km]?)\s*\|/i.exec(text)?.[1]
  return { totalTokens: total ? toNumber(total) : null, messageTokens: messages ? toNumber(messages) : null }
}

function parseAnswer(text) {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

const norm = v => (v == null ? '' : String(v).toLowerCase().replace(/[^a-z0-9_]/g, ''))

const SETUP = (truth, dir) => [
  { kind: 'chat', text: `Project decisions for this session: the API listens on port ${truth.port} and uses the database named ${truth.db}. Acknowledge in one short sentence.` },
  ...['a', 'b', 'c', 'd', 'e'].map(f => ({ kind: 'read', text: `Read src/module_${f}.ts with the Read tool, then reply with only the word "done".` })),
  { kind: 'grep', text: 'Use the Grep tool to search for "TODO" under src/, then reply with only the word "done".' },
  { kind: 'read', text: 'Read src/module_a.ts again with the Read tool, then reply with only the word "done".' },
  { kind: 'read', text: 'Read src/module_f.ts with the Read tool, then reply with only the word "done".' },
]

const ASK =
  'Without using any tools, answer from memory only. Reply with a single JSON object with the keys ' +
  `port, db, ${Object.keys(NEEDLES).join(', ')}: the API port and the database name decided earlier; and, for each file, ` +
  Object.entries(NEEDLES)
    .map(([f, n]) => `${f}: src/module_${f}.ts, ${describeNeedle(n)}`)
    .join('; ') +
  '. Use null for anything you no longer have. Do not guess.'

async function run({ arm, mode, trial }) {
  const id = `${arm}-${mode}-${trial}`
  const dir = join(workRoot, id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const truth = makeProject(dir, trial)
  const plugin = arm.startsWith('bonsai')
  let settingsFile
  const options = { ...ARM_OPTIONS[arm], ...pluginOptions }
  if (plugin && Object.keys(options).length) {
    settingsFile = join(dir, '.bench-settings.json')
    writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { bonsai: { options } } }))
  }
  const debug1 = join(dir, '.debug-1.log')
  const debug2 = join(dir, '.debug-2.log')
  const out = { id, arm, mode, trial, truth, error: null }
  let session
  try {
    session = new Session({ cwd: dir, plugin, resume: false, debugFile: debug1, settingsFile })
    let costSoFar = 0
    const cost = e => {
      const d = e.total_cost_usd - costSoFar
      costSoFar = e.total_cost_usd
      return d
    }
    out.setup = { turns: 0, costUsd: 0 }
    for (const step of SETUP(truth, dir)) {
      const r = await session.send(step.text)
      out.setup.turns++
      out.setup.costUsd += cost(r.event)
    }
    const before = await session.send('/context')
    out.before = parseContext(before.event.result ?? '')

    if (arm !== 'control') {
      const r = await session.send('/compact')
      out.compact = { ms: r.ms, costUsd: cost(r.event), isError: r.event.is_error }
    }
    if (mode === 'resume') {
      await session.close()
      session = new Session({ cwd: dir, plugin, resume: true, debugFile: debug2, settingsFile })
      costSoFar = 0
    }
    const after = await session.send('/context')
    out.after = parseContext(after.event.result ?? '')

    const ask = await session.send(ASK)
    out.ask = { ms: ask.ms, costUsd: cost(ask.event), usedTools: ask.toolUses > 0, inputTokens: totalInput(ask.event.usage) }
    const reply = ask.event.result ?? ''
    out.reply = reply
    const answer = parseAnswer(reply)
    const keys = ['port', 'db', ...Object.keys(NEEDLES)]
    out.correct = Object.fromEntries(keys.map(k => [k, answer != null && norm(answer[k]) === norm(truth[k])]))
    out.followsClaudeMd = reply.includes('[BONSAI-OK]')
  } catch (err) {
    out.error = String(err?.message ?? err)
  } finally {
    await session?.close().catch(() => {})
  }

  out.engine = engineFacts([debug1, debug2])
  return out
}

const totalInput = u => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null)

/** What the debug logs say actually happened during compaction. */
function engineFacts(files) {
  const text = files.filter(existsSync).map(f => readFileSync(f, 'utf8')).join('\n')
  return {
    pluginLoaded: /hooks module bonsai@inline loaded/.test(text),
    engineSummary: /reactive-compact/.test(text),
    bonsaiPruned: /bonsai: pruned/.test(text),
  }
}

// ---- schedule: paired design, every trial runs every arm/mode with the same seed ----
const jobs = []
for (let trial = 1; trial <= trials; trial++)
  for (const mode of modes) for (const arm of arms) jobs.push({ arm, mode, trial })

mkdirSync(dirname(outFile), { recursive: true })
const results = []
let next = 0
log(`${jobs.length} runs, concurrency ${concurrency}, model ${model}, plugin ${pluginDir}`)
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const t0 = Date.now()
      const r = await run(job)
      results.push(r)
      log(`${r.id} ${r.error ? 'ERROR ' + r.error : 'ok'} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      writeFileSync(outFile, JSON.stringify({ model, trials, generatedAt: new Date().toISOString(), runs: results }, null, 2))
    }
  }),
)
log(`done → ${outFile}`)
