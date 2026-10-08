# Configuration

Every option has a sensible default; most people never change anything. Options
show up as rows in Claude Code's `/config` menu, or you can set them in
`settings.json` (user scope) under `pluginConfigs`:

```json
{
  "pluginConfigs": {
    "bonsai": {
      "options": {
        "triggerPercent": 30,
        "preserveRecent": 6
      }
    }
  }
}
```

The key under `pluginConfigs` is the plugin name (`bonsai`; for a plugin installed
from a marketplace it is `bonsai@claude-bonsai`).

## Options

| Option | Default | What it does |
|---|---|---|
| `triggerPercent` | `35` | Prune on its own once the context passes this percentage of the window. `0` turns it off. Interactive sessions only. |
| `retryGrowth` | `5` | If a prune found nothing, retry only after the context grew by this many points. |
| `preserveRecent` | `8` | How many messages at the end of the conversation are never touched. A tool call and its result are two messages. |
| `keepMaxChars` | `2000` | Old tool results (and long tool-call fields) longer than this are cut. |
| `headChars` | `600` | Characters kept from the start of a cut text. |
| `tailChars` | `300` | Characters kept from the end of a cut text. |
| `minSavingsPercent` | `15` | If pruning saves less than this, `/compact` and automatic compaction fall back to Claude Code's own summary. |
| `pruneInputs` | `true` | Also cut the long fields of old tool calls (a `Write`'s content, an `Edit`'s strings). |
| `relink` | `true` | Keep the prune effective after `--continue` / `--resume`. See [how it works](how-it-works.md#why-relink-exists). |
| `keepTools` | `Agent,Task,AskUserQuestion,ExitPlanMode` | Comma-separated tools whose calls and results are never pruned. |

## Tuning

- **Prune more:** lower `preserveRecent` and `keepMaxChars`, for example 4 and
  1000. In the [benchmark](benchmark.md) this is the `bonsai-tight` arm: a
  smaller conversation, at the price of forgetting more of the recent file reads.
- **Prune less:** raise `preserveRecent` to 16 or `keepMaxChars` to 4000.
- **Only on demand:** set `triggerPercent` to `0` and Bonsai acts only when you
  run `/compact` or Claude Code compacts on its own.
- **Keep a tool's output whole:** add its name to `keepTools`, for example
  `Agent,Task,AskUserQuestion,ExitPlanMode,mcp__docs__search`.

## Requirements

- Claude Code with function hooks. Tested on **2.1.293**, where no flag is needed.
  Older releases that ship function hooks as early access may need
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the `env` block of `settings.json`.
- Nothing else: no API key, no network access, no extra model calls.
