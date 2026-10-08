<div align="center">

# 🌳 Bonsai

**Prune your Claude Code context. Don't summarize it.**

A Claude Code plugin that replaces `/compact`'s model-written summary with a
deterministic prune: stale and oversized tool output goes, your conversation,
decisions and plans stay word for word. Instant, free, and no extra model call.

[![License: MIT](https://img.shields.io/badge/license-MIT-2a78d6.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-eb6834.svg)](https://docs.claude.com/en/docs/claude-code)
[![Tested on 2.1.293](https://img.shields.io/badge/tested%20on-Claude%20Code%202.1.293-1baf7a.svg)](#requirements)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20dependencies-3178c6.svg)](hooks/prune.ts)
[![Português](https://img.shields.io/badge/lang-pt--BR-8a897f.svg)](README.pt-BR.md)

</div>

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/recall-dark.svg">
  <img alt="Bonsai keeps recent and edge facts exactly; the built-in summary keeps less than half of the specifics" src="docs/img/recall-light.svg">
</picture>

<sub>Share of facts recalled exactly after compaction, 64 real runs against Claude Code
(8 trials × 4 arms × live/resume). Full method and every caveat in
[docs/benchmark.md](docs/benchmark.md).</sub>

## Why

`/compact` asks a model to **rewrite** your session as a summary. That takes
seconds, costs tokens, and is lossy in ways you cannot predict. But look at what
actually fills a long session: in real transcripts, **87% of the text is tool
calls and their output**, and only 13% is you and the assistant talking.

Bonsai removes the tool output you no longer need and leaves everything else alone.

```
before                                  after
──────────────────────────────          ──────────────────────────────
you: "use port 8472"           keep     you: "use port 8472"
assistant: plan: …             keep     assistant: plan: …
tool result: 18,000 chars      cut      tool result: first 600 + last 300 chars
tool result: same Read, again  drop     [Bonsai pruned this result: Read a.ts …]
tool result: latest, recent    keep     tool result: latest, recent
```

## Install

```text
/plugin install bonsai --marketplace DouglasVulcano/claude-bonsai
```

Answer `y` to add the marketplace, pick a scope, and you are done: the next
`/compact` is a prune. No API key, no network, no extra model calls.

<details>
<summary>Or run it from source</summary>

```bash
git clone https://github.com/DouglasVulcano/claude-bonsai
claude --plugin-dir ./claude-bonsai
```
</details>

## What you get

|  | Built-in `/compact` | **Bonsai** |
|---|---|---|
| Time to compact | 14.2 s | **0.16 s** |
| Cost of the compaction | $0.071 | **$0** |
| Conversation size after (from ~98k tokens) | 19k (−81%) | 40k (−59%) |
| Specific facts recalled, same session | 48% | **75%** |
| Facts from files read recently | 31% | **100%** |
| Your messages and decisions | 100% | 100% |
| `CLAUDE.md` rules still followed | 100% | 100% |
| Facts from the *middle* of old, long results | 13% | 0% |
| Deterministic | no | **yes** |

Bonsai compacts less than a summary can, and it cannot keep the middle of an old
tool result. It is the right trade when you would rather keep the text exact and
re-read a file than trust a paraphrase. [The numbers, and where they come from](docs/benchmark.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/cost-dark.svg">
  <img alt="Time and model cost of the compaction" src="docs/img/cost-light.svg">
</picture>

## How it works

Bonsai hooks `session.compact`, which every compaction goes through (your
`/compact`, Claude Code's automatic one and a plugin's), and walks the conversation
once:

1. **Protected:** your messages, the assistant's text, the last 8 messages and the
   results of `Agent`, `Task`, `AskUserQuestion` and `ExitPlanMode` are never touched.
2. **Superseded:** a result is dropped for a one-line marker if the same `Read`,
   `Bash`, `Grep`, `Glob` or `WebFetch` ran again later.
3. **Oversized:** an old result over 2,000 characters keeps its first 600 and last
   300 (errors and conclusions sit at the end).
4. **Oversized calls:** the same cut applies to long fields of old tool calls, such
   as the content of a `Write`.

`tool_use` / `tool_result` pairs are never split. If a prune would save under 15%,
Claude Code's own summary runs instead, so you are never worse off. Details in
[docs/how-it-works.md](docs/how-it-works.md).

On 9 real sessions Bonsai removes **49%** of the conversation's characters (median
40%); tool-call inputs, not only results, are half of that.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/replay-dark.svg">
  <img alt="What fills a real session and what Bonsai removes" src="docs/img/replay-light.svg">
</picture>

## Configuration

Everything has a default. Options appear in `/config`, or in `settings.json`:

```json
{ "pluginConfigs": { "bonsai": { "options": { "preserveRecent": 4, "keepMaxChars": 1000 } } } }
```

| Option | Default | |
|---|---|---|
| `preserveRecent` | `8` | messages at the end that are never touched |
| `keepMaxChars` | `2000` | old results longer than this are cut |
| `headChars` / `tailChars` | `600` / `300` | what survives a cut |
| `minSavingsPercent` | `15` | below this, fall back to the built-in summary |
| `pruneInputs` | `true` | also cut long fields of old tool calls |
| `keepTools` | `Agent,Task,…` | tools whose output is never pruned |
| `triggerPercent` | `35` | prune on its own above this share of the window (interactive only) |
| `relink` | `true` | keep the prune after `--continue` / `--resume` |

All options, with tuning advice: [docs/configuration.md](docs/configuration.md).
Lower `preserveRecent` and `keepMaxChars` for the *tight* profile in the charts:
−72% of the conversation, at the price of forgetting more of the recent reads.

## Limitations

Read these before you rely on it.

- **Cut results are gone.** A fact in the middle of an old, long tool result is no
  longer in the context. Claude can read the file again; it will not remember it.
- **Resuming a session is noisier.** The prune survives `--continue` (about 43k
  tokens against 106k), but I measured the engine sometimes bringing part of the cut
  content back and, in 1 of 16 resumed runs, losing a recent fact. I could not fully explain
  it. [Details](docs/benchmark.md#3-after---continue).
- **The proactive trigger is untested.** Pruning on its own at a share of the window
  needs `$.session.compact()`, which does not exist in headless sessions, so I could
  only exercise `/compact`. Treat `triggerPercent` as experimental.
- **One model, one synthetic scenario, small samples.** Haiku, 8 trials per cell.
  The benchmark page lists how the design shaped the result.
- **Early-access API.** Function hooks may change between Claude Code releases.

## Requirements

Claude Code with function hooks. Tested on **2.1.293**, where no flag is needed.
Older releases that ship them as early access may need
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the `env` block of `settings.json`.

## Benchmark it yourself

```bash
node bench/replay.mjs                     # free: replays your own transcripts, keeps only aggregates
node bench/e2e.mjs --trials 8             # real runs against the engine (uses your usage)
python bench/report.py                    # charts + summary.json
```

## Contributing

Issues and pull requests are welcome, especially new pruning rules backed by a
number from the benchmark, and an adapter for other agents (the pruner in
[`hooks/prune.ts`](hooks/prune.ts) has no Claude Code dependency). See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Douglas Vulcano
