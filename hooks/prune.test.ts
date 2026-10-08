import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { prune, readConfig, savedPercent, truncateText } from './prune'

const cfg = readConfig({
  preserveRecent: 2,
  keepMaxChars: 100,
  headChars: 20,
  tailChars: 10,
  keepTools: 'Agent',
  pruneInputs: false,
  relink: false,
})

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({
  role: 'assistant',
  text: `calling ${tool}`,
  toolUses: [{ tool_use_id: id, tool, input }],
  handle: `h-${id}-use`,
})

const result = (id: string, text: string, isError = false): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }],
  handle: `h-${id}-res`,
})

const say = (role: 'user' | 'assistant', text: string): SessionMessage => ({
  role,
  text,
  toolUses: [],
  handle: `h-${text}`,
})

const tail = [say('user', 'continue'), say('assistant', 'ok')]

test('cuts a large old result and keeps its start and end', ({ }) => {
  const big = 'A'.repeat(50) + 'M'.repeat(500) + 'Z'.repeat(50)
  const msgs = [call('1', 'Bash', { command: 'ls' }), result('1', big), ...tail]
  const out = prune(msgs, cfg)

  const text = out.messages[1]!.toolResults![0]!.text
  expect(out.truncated).toBe(1)
  expect(text.startsWith('A'.repeat(20))).toBe(true)
  expect(text.endsWith('Z'.repeat(10))).toBe(true)
  expect(text.length).toBeLessThan(big.length)
  expect(text).toContain('characters pruned')
  // the rebuilt message loses its handle; the others are untouched
  expect(out.messages[1]!.handle).toBeUndefined()
  expect(out.messages[0]).toBe(msgs[0])
  expect(out.messages[2]).toBe(msgs[2])
})

test('drops the old read when the same file is read again later', ({ }) => {
  const msgs = [
    call('1', 'Read', { file_path: 'a.ts' }),
    result('1', 'old content of a.ts'),
    call('2', 'Read', { file_path: 'a.ts' }),
    result('2', 'new content of a.ts'),
    ...tail,
  ]
  const out = prune(msgs, cfg)

  expect(out.dropped).toBe(1)
  expect(out.messages[1]!.toolResults![0]!.text).toContain('pruned this result: Read a.ts')
  expect(out.messages[3]).toBe(msgs[3])
})

test('reading different ranges of the same file does not supersede', ({ }) => {
  const msgs = [
    call('1', 'Read', { file_path: 'a.ts', offset: 0, limit: 10 }),
    result('1', 'range 1'),
    call('2', 'Read', { file_path: 'a.ts', offset: 10, limit: 10 }),
    result('2', 'range 2'),
    ...tail,
  ]
  expect(prune(msgs, cfg).dropped).toBe(0)
})

test('preserves recent messages and protected tools', ({ }) => {
  const big = 'x'.repeat(500)
  const msgs = [
    call('1', 'Agent', { prompt: 'investigate' }),
    result('1', big),
    call('2', 'Bash', { command: 'cat large' }),
    result('2', big),
  ]
  const out = prune(msgs, cfg)

  expect(out.messages[1]).toBe(msgs[1]) // Agent is protected
  expect(out.messages[3]).toBe(msgs[3]) // inside the 2 most recent messages
  expect(out.truncated).toBe(0)
})

test('keeps tool_use/tool_result pairing and the conversation', ({ }) => {
  const big = 'x'.repeat(500)
  const msgs = [
    say('user', 'decision: use Postgres'),
    call('1', 'Grep', { pattern: 'foo' }),
    result('1', big),
    say('assistant', 'plan: migrate the table'),
    ...tail,
  ]
  const out = prune(msgs, cfg)

  expect(out.messages.length).toBe(msgs.length)
  expect(out.messages[0]).toBe(msgs[0])
  expect(out.messages[3]).toBe(msgs[3])
  expect(out.messages[1]!.toolUses[0]!.tool_use_id).toBe('1')
  expect(out.messages[2]!.toolResults![0]!.tool_use_id).toBe('1')
})

test('a superseded error keeps the first line of the failure', ({ }) => {
  const msgs = [
    call('1', 'Bash', { command: 'npm test' }),
    result('1', 'FAIL src/a.test.ts\n  lots of output', true),
    call('2', 'Bash', { command: 'npm test' }),
    result('2', 'PASS'),
    ...tail,
  ]
  const text = prune(msgs, cfg).messages[1]!.toolResults![0]!.text
  expect(text).toContain('FAIL src/a.test.ts')
  expect(text).not.toContain('lots of output')
})

test('savedPercent reflects the savings and is zero with nothing to prune', ({ }) => {
  const big = 'x'.repeat(5000)
  const some = prune([call('1', 'Bash', { command: 'a' }), result('1', big), ...tail], cfg)
  expect(savedPercent(some)).toBeGreaterThan(80)

  const none = prune([say('user', 'hi'), say('assistant', 'hello')], cfg)
  expect(savedPercent(none)).toBe(0)
})

test('relink rebuilds from the call behind the first pruned result onwards', ({ }) => {
  const linked = readConfig({ preserveRecent: 2, keepMaxChars: 100, headChars: 20, tailChars: 10, keepTools: '' })
  const big = 'x'.repeat(500)
  const msgs = [
    say('user', 'decision: use Postgres'), // 0: before the prune, keeps handle and attachments
    say('assistant', 'plan: migrate'), //     1: before the prune
    call('1', 'Bash', { command: 'ls' }), //  2: the call behind the first pruned result: rebuilt too
    result('1', big), //                      3: the first one altered
    call('2', 'Bash', { command: 'pwd' }), // 4: after it, rebuilt
    result('2', 'short'), //                  5
    ...tail, //                               6, 7
  ]
  const out = prune(msgs, linked)

  expect(out.messages.length).toBe(msgs.length)
  expect(out.messages[0]).toBe(msgs[0])
  expect(out.messages[1]).toBe(msgs[1])
  for (const i of [2, 3, 4, 5, 6, 7]) {
    expect(out.messages[i]!.handle).toBeUndefined()
    expect(out.messages[i]!.role).toBe(msgs[i]!.role)
    expect(out.messages[i]!.text).toBe(msgs[i]!.text)
    expect(out.messages[i]!.toolUses).toEqual(msgs[i]!.toolUses)
  }
  expect(out.messages[5]!.toolResults).toEqual(msgs[5]!.toolResults)
})

test('relink leaves everything alone when there is nothing to prune', ({ }) => {
  const linked = readConfig({ preserveRecent: 2, keepMaxChars: 100, headChars: 20, tailChars: 10, keepTools: '' })
  const msgs = [say('user', 'hi'), say('assistant', 'hello'), ...tail]
  const out = prune(msgs, linked)
  expect(out.messages.every((m, i) => m === msgs[i])).toBe(true)
})

test('pruneInputs cuts the long content of an old Write and keeps the call valid', ({ }) => {
  const withInputs = readConfig({ preserveRecent: 2, keepMaxChars: 100, headChars: 20, tailChars: 10, keepTools: '' })
  const content = 'H'.repeat(20) + 'm'.repeat(500) + 'T'.repeat(10)
  const msgs = [
    call('1', 'Write', { file_path: 'src/a.ts', content }),
    result('1', 'File created'),
    ...tail,
  ]
  const out = prune(msgs, withInputs)

  const input = out.messages[0]!.toolUses[0]!.input
  expect(out.inputsTruncated).toBe(1)
  expect(input.file_path).toBe('src/a.ts') // short fields are untouched
  expect(String(input.content).startsWith('H'.repeat(20))).toBe(true)
  expect(String(input.content).endsWith('T'.repeat(10))).toBe(true)
  expect(String(input.content).length).toBeLessThan(content.length)
  expect(out.messages[0]!.toolUses[0]!.tool_use_id).toBe('1')
})

test('pruneInputs: false leaves tool-call inputs alone', ({ }) => {
  const msgs = [
    call('1', 'Write', { file_path: 'src/a.ts', content: 'x'.repeat(5000) }),
    result('1', 'File created'),
    ...tail,
  ]
  const out = prune(msgs, cfg)
  expect(out.inputsTruncated).toBe(0)
  expect(out.messages[0]).toBe(msgs[0])
})

test('truncateText returns short text untouched', ({ }) => {
  expect(truncateText('short', 20, 10)).toBe('short')
})
