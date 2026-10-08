# Benchmarks

Two independent suites. Results live in `results/`; charts are rendered into
`../docs/img/`. The write-up is in [`../docs/benchmark.md`](../docs/benchmark.md).

## 1. Replay (offline, free)

Reads your own Claude Code transcripts from `~/.claude/projects`, rebuilds each
conversation the way the engine hands it to a hook, runs the pruner and reports
how much it would remove. No API calls. **Only aggregate numbers are written;
none of your sessions' content is kept.**

```bash
node bench/replay.mjs                      # all sessions with >= 30 messages
node bench/replay.mjs --min-messages 10 --out /tmp/replay.json
```

Needs Node 22.18+ (it imports the TypeScript pruner directly).

## 2. End-to-end (real engine, spends usage)

Drives real `claude -p` processes and asks recall questions after compaction.

```bash
node bench/e2e.mjs --trials 8 --concurrency 4 --out bench/results/e2e.json
```

Every trial builds the same seeded project and runs it through every arm:

| Arm | What happens at the compaction step |
|---|---|
| `control` | nothing, the conversation is left alone |
| `builtin` | Claude Code's own `/compact` (model-written summary) |
| `bonsai` | `/compact` with this plugin loaded, default options |
| `bonsai-tight` | same, with `preserveRecent=4`, `keepMaxChars=1000`, `headChars=400`, `tailChars=200` |

and two modes: `live` (the questions are asked in the same process) and `resume`
(the process is closed and the questions are asked after `claude --continue`).

The project is six ~23 KB source files. Each hides one fact; every file also holds
about 30 look-alike constants and 30 look-alike `NOTE(ops)` comments, so a target
is one item among many, as in real code. The session walks through five reads, a
`Grep`, a re-read and a last read, so that two facts are *recent*, two sit at the
*edge* of an old file and two in its *middle*. A chat decision (a port and a
database name) and a `CLAUDE.md` rule (end every reply with a marker) are added.

After compaction the model is asked, with no tools allowed *by instruction*, to
return the eight facts as JSON, or `null` for anything it no longer has. A fact is
**recalled** only if the value is exactly right and the model did not call a tool
to fetch it again.

Useful flags: `--arms`, `--modes`, `--model`, `--work <dir>`, `--plugin <path>`,
`--plugin-options '{"preserveRecent":4}'`.

> It uses real model calls (Haiku by default). The 64 published runs cost about
> US$ 9.5 of API-equivalent usage, roughly US$ 0.15 per run: every session carries
> ~100k tokens of file reads. Try `--trials 2` first.

## 3. Report

```bash
pip install matplotlib numpy
python bench/report.py
```

Writes `results/summary.json` and the SVG charts in `docs/img/` (light and dark).
Intervals are 95% bootstrap intervals over trials.

## Methodology notes

- **Paired design.** The same seed gives every arm identical files, facts and
  decisions, so differences are not noise from the data.
- **Token counts come from the engine** (`/context`, the `Messages` row), not
  from an estimate.
- **Fixture bias is real.** A haystack of random code is not your repository.
  Early versions of this benchmark had unique, meaningful names for the target
  facts and the built-in summary found all of them; the look-alike decoys were
  added after that. Expect your own results to differ.
- **One model.** Results are for Claude Haiku. A stronger summarizer may keep
  more.
