# How Bonsai works

Claude Code's `/compact` asks a model to **rewrite** your conversation as a
summary. That is slow (seconds), costs tokens, and is lossy in ways you cannot
predict: whatever the summarizer did not think was important is gone.

Bonsai takes the opposite approach. It **removes** the parts of the conversation
that are cheap to lose and keeps everything else word for word. Nothing is
rewritten, so nothing is paraphrased wrongly.

```
before                                  after
──────────────────────────────          ──────────────────────────────
user: "use port 8472"          keep     user: "use port 8472"
assistant: Read a.ts           keep     assistant: Read a.ts
tool result: 18,000 chars      cut      tool result: first 600 + last 300 chars
assistant: "plan: …"           keep     assistant: "plan: …"
assistant: Read a.ts (again)   keep     assistant: Read a.ts (again)
tool result: 18,000 chars      keep     tool result: 18,000 chars   (recent)
```

## Where it plugs in

Bonsai is a Claude Code *function-hooks* plugin. It registers two hooks:

| Hook | What it does |
|---|---|
| `session.compact` | Runs for **every** compaction: your `/compact`, Claude Code's automatic one, a plugin's, and the engine's precompute. Bonsai prunes the messages it is handed and returns them. The built-in summarizer never runs. |
| `turn.complete` | After each answer, checks how full the window is. Above `triggerPercent` it asks for a compaction, which then goes through the hook above. |

If a prune would save less than `minSavingsPercent`, the hook calls `next(e)` and
Claude Code summarizes as usual, so you are never worse off than without the
plugin. The proactive trigger simply gives up in that case.

## What gets pruned

Bonsai walks the conversation once and decides, per tool result and per tool
call, in this order:

1. **Protected?** The last `preserveRecent` messages, and the results and calls
   of tools in `keepTools` (default: `Agent`, `Task`, `AskUserQuestion`,
   `ExitPlanMode`), are never touched.
2. **Superseded?** If the same query ran again later, the earlier result is dead
   weight and becomes a one-line marker: a `Read` of the same file and range, the
   same `Bash` command, the same `Grep`, `Glob` or `WebFetch`. A failed result
   keeps the first line of its error in the marker.
3. **Oversized?** An old result longer than `keepMaxChars` keeps its first
   `headChars` and last `tailChars` characters (errors and conclusions tend to
   sit at the end), with a note saying how much was removed.
4. **Oversized call?** The long string fields of an old tool call, such as the
   `content` of a `Write` or the strings of an `Edit`, are cut the same way. The
   file on disk is the source of truth, so the old text is dead weight.

The `tool_use` / `tool_result` pairing is never broken, so the API always accepts
the pruned conversation. Your messages and the assistant's text are never altered.

## Why `relink` exists

This one is subtle and worth knowing about if you write hooks.

When a `session.compact` hook returns messages, the engine stores them in the
session transcript. A message that comes back **with its engine `handle`** is kept
as is, including its original `parentUuid`. That is fine inside a live session,
but `claude --continue` rebuilds the conversation by walking `parentUuid` links
backwards from the last row, and a kept message still points into the
**pre-compaction** history. The walk follows it, skips the compaction boundary,
and quietly resurrects the unpruned conversation.

Messages that come back **without** a `handle` are rebuilt by the engine from
`role`, `text` and tool blocks, and get correct links. So Bonsai rebuilds every
message from the call behind the first pruned result onwards, and leaves the earlier
ones alone. Measured: before `relink`, a resumed session was the size of the
unpruned one (77.3k tokens against 76.9k for the control); with it, the prune
persists (about 43k against 106k in the [benchmark](benchmark.md#3-after---continue)).

It starts at the first change on purpose. Context attachments (the skill list, the
date, environment details) hang off the earliest messages; an earlier version that
rebuilt *every* message dropped them, and the model would have lost its skill list.
The cost of `relink` is that attachments hung on the messages **after** the first
pruned one, and any thinking blocks there, are not carried over.

Resuming is still noisier than a live session: in some runs the engine brought part
of the cut content back, and in one it lost a recent fact. See the
[benchmark](benchmark.md#3-after---continue) for what was measured and what is
unexplained.

## Proactive pruning

Claude Code only compacts when the window is nearly full. Bonsai can act earlier:
the `turn.complete` hook reads `$.session.usage()` and, above `triggerPercent`
(default 35), calls `$.session.compact()`. If that finds nothing worth pruning it
backs off until the context has grown by `retryGrowth` more points.

`$.session.compact()` is not available in headless (`-p` / SDK) sessions, so the
proactive trigger only works in the interactive terminal UI. In headless mode the
failure is caught and reported, and `/compact` keeps working.

## Token estimates

The toast Bonsai shows (`pruned ~12k tokens (estimate)`) uses a rough
characters ÷ 4 rule. It only counts the messages the hook sees, not the system
prompt or attachments. Treat it as an order of magnitude; the benchmark uses the
engine's own `/context` numbers instead.

## Known limits

- **Not a summary.** Bonsai never compresses what it keeps. A very long session
  of short messages will not shrink much.
- **Cut results are gone.** A fact that sat in the middle of an old, long tool
  result is no longer in the context. Claude can read the file or run the command
  again, but it will not remember the content.
- **`relink` side effects**, described above.
- **Function hooks are early access** in Claude Code and may change between
  releases. Bonsai is tested on 2.1.293.
