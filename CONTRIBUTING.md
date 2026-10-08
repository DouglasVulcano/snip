# Contributing

Thanks for taking a look. Bonsai is small on purpose, so contributions that keep
it simple and measurable are the most welcome.

## Setup

```bash
git clone https://github.com/DouglasVulcano/claude-bonsai
cd claude-bonsai
claude --plugin-dir .          # run Claude Code with the plugin loaded from source
```

## Before you open a pull request

```bash
claude plugin test .           # unit tests (the pruner is a pure function)
claude plugin validate .       # manifest, marketplace and hooks module
```

- The pruning logic lives in `hooks/prune.ts` and has no engine dependencies, so
  it is easy to test. New behaviour needs a test in `hooks/prune.test.ts`.
- A change that affects what is kept or removed should come with a number: run
  `node bench/replay.mjs` and, if it touches recall, `node bench/e2e.mjs`, and
  paste the before/after in the pull request.
- Function hooks are early access in Claude Code. If an API call changes,
  `.claude-plugin/types/` (written by the engine when it loads the plugin) is the
  reference.

## Ideas that would be great

- Pruning rules for more tools (MCP results, `WebSearch`).
- A smarter "is this result still needed?" score, for example with a small model.
- A Codex adapter: the pruner is engine-independent, only `hooks/register.ts` is
  Claude Code specific.
- Benchmarks on larger models and on real repositories.

## Reporting a bug

Include the Claude Code version (`claude --version`), your Bonsai options, and,
if you can, the debug log (`claude --debug-file bonsai.log`). Do not paste
conversation content you would not want public.
