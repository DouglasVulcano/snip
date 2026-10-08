#!/usr/bin/env python3
"""Turns bench/results/{e2e,replay}.json into bench/results/summary.json and the charts in docs/img/.

    python bench/report.py [--e2e bench/results/e2e.json] [--replay bench/results/replay.json]

Needs numpy and matplotlib. Recall is paired by trial (every arm sees the same
seeded project) and its 95% intervals are bootstrapped over trials.
"""
import argparse
import json
import os
import random
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyBboxPatch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ARMS = ["control", "builtin", "bonsai", "bonsai-tight"]
ARM_LABEL = {
    "control": "No compaction",
    "builtin": "Built-in /compact (summary)",
    "bonsai": "Bonsai (defaults)",
    "bonsai-tight": "Bonsai (tight)",
}
CATEGORIES = [
    ("chat", "Decisions made\nin chat", ["port", "db"]),
    ("recent", "File read\nrecently", ["a", "f"]),
    ("old_edge", "Old file,\nfact at the end", ["c", "e"]),
    ("old_middle", "Old file,\nfact mid-file", ["b", "d"]),
]

# Reference palette (validated light/dark steps); the neutral is the baseline.
THEMES = {
    "light": {
        "surface": "#fcfcfb", "text": "#0b0b0b", "muted": "#52514e", "grid": "#e6e5e1",
        "control": "#9a998f", "builtin": "#eb6834", "bonsai": "#2a78d6", "bonsai-tight": "#1baf7a",
    },
    "dark": {
        "surface": "#1a1a19", "text": "#ffffff", "muted": "#c3c2b7", "grid": "#33332f",
        "control": "#8a897f", "builtin": "#d95926", "bonsai": "#3987e5", "bonsai-tight": "#199e70",
    },
}


def bootstrap_ci(per_trial, n=2000, seed=7):
    """Mean and 95% interval of a list of per-trial values, resampling trials."""
    if not per_trial:
        return (float("nan"),) * 3
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(per_trial, k=len(per_trial))) / len(per_trial) for _ in range(n))
    return sum(per_trial) / len(per_trial), means[int(0.025 * n)], means[int(0.975 * n)]


def summarize(e2e):
    runs = [r for r in e2e["runs"] if not r.get("error")]
    errors = [r["id"] for r in e2e["runs"] if r.get("error")]
    groups = defaultdict(list)
    for r in runs:
        groups[(r["arm"], r["mode"])].append(r)

    def recalled(run, keys):
        # A fact counts as recalled only if the answer is right and no tool was used to fetch it again.
        if run["ask"]["usedTools"]:
            return 0.0
        return sum(1 for k in keys if run["correct"].get(k)) / len(keys)

    out = {}
    for (arm, mode), rs in sorted(groups.items()):
        mean = lambda xs: sum(xs) / len(xs) if xs else None  # noqa: E731
        cell = {"runs": len(rs), "recall": {}}
        for key, _, facts in CATEGORIES:
            cell["recall"][key] = dict(zip(("mean", "lo", "hi"), bootstrap_ci([recalled(r, facts) for r in rs])))
        every = [k for _, _, facts in CATEGORIES for k in facts]
        cell["recall"]["all"] = dict(zip(("mean", "lo", "hi"), bootstrap_ci([recalled(r, every) for r in rs])))
        cell["claudeMdFollowed"] = mean([1.0 if r["followsClaudeMd"] else 0.0 for r in rs])
        cell["reReadRate"] = mean([1.0 if r["ask"]["usedTools"] else 0.0 for r in rs])
        cell["messageTokensBefore"] = mean([r["before"]["messageTokens"] for r in rs])
        cell["messageTokensAfter"] = mean([r["after"]["messageTokens"] for r in rs])
        cell["totalTokensAfter"] = mean([r["after"]["totalTokens"] for r in rs])
        cell["askInputTokens"] = mean([r["ask"]["inputTokens"] for r in rs])
        cell["compactSeconds"] = mean([r["compact"]["ms"] / 1000 for r in rs if r.get("compact")])
        cell["compactCostUsd"] = mean([r["compact"]["costUsd"] for r in rs if r.get("compact")])
        cell["engineSummaryRate"] = mean([1.0 if r["engine"]["engineSummary"] else 0.0 for r in rs])
        cell["bonsaiPrunedRate"] = mean([1.0 if r["engine"]["bonsaiPruned"] else 0.0 for r in rs])
        out[f"{arm}/{mode}"] = cell
    return {"model": e2e.get("model"), "trials": e2e.get("trials"), "errors": errors, "cells": out}


# ---------------------------------------------------------------- charts

def style(theme):
    t = THEMES[theme]
    plt.rcParams.update({
        "svg.fonttype": "path", "font.family": "DejaVu Sans", "font.size": 10,
        "figure.facecolor": t["surface"], "axes.facecolor": t["surface"], "savefig.facecolor": t["surface"],
        "text.color": t["text"], "axes.labelcolor": t["muted"], "xtick.color": t["muted"], "ytick.color": t["muted"],
        "axes.edgecolor": t["grid"], "axes.spines.top": False, "axes.spines.right": False,
    })
    return t


def legend(fig, t, arms, y=0.99):
    handles = [plt.Rectangle((0, 0), 1, 1, color=t[a]) for a in arms]
    fig.legend(handles, [ARM_LABEL[a] for a in arms], loc="upper center", ncol=len(arms), frameon=False,
               bbox_to_anchor=(0.5, y), labelcolor=t["muted"], fontsize=9, handlelength=1, columnspacing=1.6)


def save(fig, name, theme):
    out = ROOT / "docs" / "img"
    out.mkdir(parents=True, exist_ok=True)
    fig.savefig(out / f"{name}-{theme}.svg", format="svg")
    if os.environ.get("BONSAI_PREVIEW"):  # PNG previews for eyeballing; not committed
        preview = Path(os.environ["BONSAI_PREVIEW"])
        preview.mkdir(parents=True, exist_ok=True)
        fig.savefig(preview / f"{name}-{theme}.png", dpi=100)
    plt.close(fig)


def chart_recall(summary, theme):
    t = style(theme)
    arms = [a for a in ARMS if f"{a}/live" in summary["cells"]]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3), sharey=True)
    legend(fig, t, arms, y=0.995)
    for ax, mode, title in zip(axes, ("live", "resume"), ("Same session", "After claude --continue")):
        width = 0.8 / len(arms)
        for i, arm in enumerate(arms):
            cell = summary["cells"].get(f"{arm}/{mode}")
            if not cell:
                continue
            xs, ys, lo, hi = [], [], [], []
            for j, (key, _, _) in enumerate(CATEGORIES):
                r = cell["recall"][key]
                xs.append(j - 0.4 + width * (i + 0.5))
                ys.append(r["mean"] * 100)
                lo.append((r["mean"] - r["lo"]) * 100)
                hi.append((r["hi"] - r["mean"]) * 100)
            ax.bar(xs, ys, width=width * 0.86, color=t[arm], zorder=3)
            ax.errorbar(xs, ys, yerr=[lo, hi], fmt="none", ecolor=t["muted"], elinewidth=1, capsize=2, zorder=4)
        ax.set_xticks(range(len(CATEGORIES)), [c[1] for c in CATEGORIES], fontsize=9)
        ax.set_ylim(0, 108)
        ax.set_title(title, loc="left", fontsize=11, color=t["text"], pad=10)
        ax.yaxis.grid(True, color=t["grid"], zorder=0)
        ax.set_axisbelow(True)
        ax.tick_params(length=0)
    axes[0].set_ylabel("Facts recalled exactly (%)")
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    save(fig, "recall", theme)


def chart_tokens(summary, theme):
    t = style(theme)
    arms = [a for a in ARMS if f"{a}/live" in summary["cells"]]
    fig, ax = plt.subplots(figsize=(11, 3.9))
    legend(fig, t, arms, y=0.995)
    for i, arm in enumerate(arms):
        cell = summary["cells"][f"{arm}/live"]
        y = len(arms) - 1 - i
        before = cell["messageTokensBefore"] / 1000
        after = cell["messageTokensAfter"] / 1000
        ax.barh(y, after, height=0.62, color=t[arm], zorder=3)
        pct = (1 - after / before) * 100 if arm != "control" else 0
        label = f"{after:.0f}k tokens" + (f"   (−{pct:.0f}%)" if arm != "control" else "")
        ax.text(after + 1.2, y, label, va="center", color=t["text"], fontsize=9)
    ax.set_yticks([])
    ax.set_ylim(-0.5, len(arms) - 0.5)
    ax.set_xlabel("Conversation tokens after compaction (thousands) — /context \"Messages\"")
    ax.xaxis.grid(True, color=t["grid"], zorder=0)
    ax.set_axisbelow(True)
    ax.set_xlim(0, max(c["messageTokensBefore"] for c in summary["cells"].values()) / 1000 * 1.12)
    ax.tick_params(length=0)
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    save(fig, "tokens", theme)


def chart_cost(summary, theme):
    t = style(theme)
    arms = [a for a in ("builtin", "bonsai", "bonsai-tight") if f"{a}/live" in summary["cells"]]
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.4))
    legend(fig, t, arms, y=0.995)
    for ax, key, title, fmt in (
        (axes[0], "compactSeconds", "Time to compact", lambda v: f"{v:.2f} s" if v < 1 else f"{v:.1f} s"),
        (axes[1], "compactCostUsd", "Model cost of the compaction", lambda v: f"${v:.3f}" if v else "$0"),
    ):
        vals = [summary["cells"][f"{a}/live"][key] or 0 for a in arms]
        top = max(vals) or 1
        ax.bar(range(len(arms)), vals, color=[t[a] for a in arms], width=0.55, zorder=3)
        for i, v in enumerate(vals):
            ax.text(i, v + top * 0.03, fmt(v), ha="center", color=t["text"], fontsize=10)
        ax.set_xticks([])
        ax.set_ylim(0, top * 1.2)
        ax.set_title(title, loc="left", fontsize=11, color=t["text"], pad=10)
        ax.yaxis.grid(True, color=t["grid"], zorder=0)
        ax.set_axisbelow(True)
        ax.tick_params(length=0)
    fig.tight_layout(rect=(0, 0, 1, 0.88))
    save(fig, "cost", theme)


def chart_replay(replay, theme):
    t = style(theme)
    s = replay["summary"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.6), gridspec_kw={"width_ratios": [1, 1.1]})

    comp = s["composition"]
    parts = [("Tool results", comp["toolResultsPct"], t["builtin"]), ("Tool calls\n(inputs)", comp["toolCallsPct"], t["bonsai-tight"]),
             ("Assistant\ntext", comp["assistantTextPct"], t["control"]), ("Your\nmessages", comp["userTextPct"], t["bonsai"])]
    ax = axes[0]
    left = 0
    small = 0
    for name, pct, color in parts:
        ax.barh(0, pct, left=left, color=color, height=0.5, edgecolor=t["surface"], linewidth=2, zorder=3)
        center = left + pct / 2
        if pct > 8:
            ax.text(center, 0, f"{pct:.0f}%", ha="center", va="center", color="#ffffff", fontsize=10, fontweight="bold")
            ax.text(center, -0.52, name, ha="center", va="top", color=t["muted"], fontsize=8.5)
        else:
            # thin neighbours: both labelled above the bar, at different heights, so they never collide
            ax.text(center, 0.3 + 0.32 * (small + 1), f"{name.replace(chr(10), ' ')} {pct:.0f}%", ha="right", va="center",
                    color=t["muted"], fontsize=8.5)
            ax.plot([center, center], [0.25, 0.3 + 0.32 * (small + 1) - 0.08], color=t["muted"], linewidth=0.8, zorder=2)
            small += 1
        left += pct
    ax.set_xlim(0, 100)
    ax.set_ylim(-1.0, 1.4)
    ax.axis("off")
    ax.set_title(f"What fills a real session ({s['sessions']} sessions)", loc="left", fontsize=11, color=t["text"], pad=10)

    ax = axes[1]
    presets = [("resultsOnly", "Results only"), ("default", "Defaults"), ("aggressive", "Tight")]
    for i, (key, label) in enumerate(presets):
        p = s["presets"][key]
        y = len(presets) - 1 - i
        ax.barh(y, p["overallSavedPct"], color=t["bonsai"] if key != "resultsOnly" else t["control"], height=0.55, zorder=3)
        ax.text(p["overallSavedPct"] + 1, y, f"{p['overallSavedPct']:.0f}%", va="center", color=t["text"], fontsize=10)
        ax.text(-1, y, label, va="center", ha="right", color=t["muted"], fontsize=9.5)
    ax.set_xlim(0, 100)
    ax.set_yticks([])
    ax.xaxis.grid(True, color=t["grid"], zorder=0)
    ax.set_axisbelow(True)
    ax.set_xlabel("Characters removed from the conversation (%)")
    ax.set_title("What Bonsai removes", loc="left", fontsize=11, color=t["text"], pad=10)
    ax.tick_params(length=0)
    fig.tight_layout()
    save(fig, "replay", theme)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--e2e", default=str(ROOT / "bench/results/e2e.json"))
    ap.add_argument("--replay", default=str(ROOT / "bench/results/replay.json"))
    args = ap.parse_args()

    summary = None
    if Path(args.e2e).exists():
        summary = summarize(json.loads(Path(args.e2e).read_text()))
        (ROOT / "bench/results/summary.json").write_text(json.dumps(summary, indent=2))
    replay = json.loads(Path(args.replay).read_text()) if Path(args.replay).exists() else None

    for theme in THEMES:
        if summary:
            chart_recall(summary, theme)
            chart_tokens(summary, theme)
            chart_cost(summary, theme)
        if replay:
            chart_replay(replay, theme)
    print("charts → docs/img/")


if __name__ == "__main__":
    main()
