// Seeded generator of a small "project" for the end-to-end benchmark: six source
// files with a unique fact ("needle") hidden in some of them, plus a CLAUDE.md
// rule. The same seed always yields the same project, so every arm of the
// benchmark sees identical data.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['ledger', 'invoice', 'batch', 'settle', 'refund', 'tenant', 'quota', 'cursor', 'shard', 'replica', 'digest', 'token', 'window', 'router', 'schema', 'ticket', 'vendor', 'payout', 'retry', 'cache', 'audit', 'queue', 'worker', 'export', 'import', 'metric', 'signal', 'policy', 'limit', 'orbit']

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f']
const LINES = 420

/**
 * Which files carry a fact, where, and in what style. `comment` facts look
 * important to a summarizer ("do not change it"); `const` facts are one buried
 * line of code. Together with `where` that is a 2×2 grid of old facts (b, c, d,
 * e); a is read twice and f is read last, so both are still recent at question time.
 */
export const NEEDLES = {
  a: { where: 'middle', style: 'comment', label: 'payout rounding window (ms)' },
  b: { where: 'middle', style: 'const', name: 'RECONCILIATION_BATCH_CODE' },
  c: { where: 'end', style: 'comment', label: 'legacy export checksum seed' },
  d: { where: 'middle', style: 'comment', label: 'nightly settlement cutoff code' },
  e: { where: 'end', style: 'const', name: 'LEGACY_EXPORT_SEED' },
  f: { where: 'middle', style: 'const', name: 'RETRY_BACKOFF_CEILING_SECONDS' },
}

/** How the question refers to a file's fact. */
export const describeNeedle = n => (n.style === 'comment' ? `the number in its NOTE(ops) comment about the ${n.label}` : `the value assigned to the constant ${n.name}`)

export function makeProject(dir, seed) {
  const r = rng(seed * 7919 + 13)
  const pick = list => list[Math.floor(r() * list.length)]
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
  const id = () => `${pick(WORDS)}${pick(WORDS)[0].toUpperCase()}${pick(WORDS).slice(1)}${int(1, 99)}`
  const words = () => Array.from({ length: int(3, 6) }, () => pick(WORDS)).join(' ')

  // Decoys: dozens of look-alike constants and NOTE(ops) comments per file, so the
  // target fact is one item among many (as in real code) and not the only thing
  // worth remembering. A summary cannot keep them all; neither can a truncation.
  const upper = () => [pick(WORDS), pick(WORDS), pick(WORDS)].join('_').toUpperCase()
  const line = () => {
    switch (int(0, 11)) {
      case 10: return `export const ${upper()} = ${int(10000, 99999)};`
      case 11: return `// NOTE(ops): the ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} is ${int(10000, 99999)}; do not change it.`
      case 0: return `export function ${id()}(${id()}: number, ${id()}: string): number {`
      case 1: return `  const ${id()} = ${id()}.map((x) => x * ${int(2, 97)});`
      case 2: return `  if (${id()} > ${int(10, 9999)}) throw new Error('${words()}');`
      case 3: return `  return ${id()}(${id()}) + ${int(1, 500)};`
      case 4: return `}`
      case 5: return `// ${words()}`
      case 6: return `  const ${id()} = await ${id()}.fetch('${pick(WORDS)}/${pick(WORDS)}', { retries: ${int(1, 5)} });`
      case 7: return `  ${id()}.set('${pick(WORDS)}', ${int(1, 9999)});`
      case 8: return int(0, 6) === 0 ? `// TODO: ${words()}` : `  log.debug('${words()}', ${id()});`
      default: return `  for (const ${id()} of ${id()}) { total += ${id()}.${pick(WORDS)}; }`
    }
  }

  const truth = {
    port: String(int(4100, 8900)),
    db: `orders_${pick(WORDS)}${int(10, 99)}`,
  }
  mkdirSync(join(dir, 'src'), { recursive: true })

  for (const f of FILES) {
    const lines = Array.from({ length: LINES }, line)
    const needle = NEEDLES[f]
    if (needle) {
      const value = String(int(10000, 99999))
      truth[f] = value
      const text =
        needle.style === 'comment'
          ? `// NOTE(ops): the ${needle.label} is ${value}; do not change it.`
          : `export const ${needle.name} = ${value};`
      if (needle.where === 'end') lines[LINES - 1] = text
      else lines[Math.floor(LINES / 2)] = text
    }
    writeFileSync(join(dir, 'src', `module_${f}.ts`), lines.join('\n') + '\n')
  }

  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n- End every reply with the exact text [SNIP-OK] on its own line.\n')
  return truth
}
