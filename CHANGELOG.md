# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

First public release.

### Added
- `session.compact` hook that replaces Claude Code's model-written summary with a
  deterministic prune of the conversation. It handles `/compact`, automatic
  compaction and precompute alike.
- Pruning rules: stale tool results (a later identical `Read`, `Bash`, `Grep`,
  `Glob` or `WebFetch`) become a one-line marker; oversized old results and
  oversized fields of old tool calls keep only their start and end.
- Never touched: your messages, the assistant's text, the most recent messages,
  and the results of `Agent`, `Task`, `AskUserQuestion` and `ExitPlanMode`.
- Fallback to Claude Code's own summary when a prune would save too little.
- Proactive prune from a `turn.complete` hook once the context passes a
  configurable share of the window (interactive sessions only).
- `relink`: keeps the prune effective after `claude --continue` / `--resume`.
- Nine options exposed through `userConfig`.
- Benchmark suite in `bench/`: offline replay of real transcripts and an
  end-to-end A/B/C run against the real engine with paired recall questions.
