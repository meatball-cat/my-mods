#!/usr/bin/env python3
"""Compare each mod's local version with its author's GitHub repo.

Read-only: never changes a mod. Runs weekly via launchd (see install_schedule.sh)
or by hand: `python3 scripts/check_updates.py`. Prints a report, appends it to
the log, and shows a macOS notification when something needs attention.

To track a new mod, add it to TRACKED below (see CLAUDE.md).
"""
import json
import os
import subprocess
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.expanduser("~/.local/share/my-mods-updater/update-check.log")

# mod folder -> upstream repo ("owner/repo", or "local" for mods with no upstream),
# path of the mod inside that repo, and the upstream commit it was last synced from.
TRACKED = {
    "cache-keeper":    {"repo": "nateherkai/claude-code-mods", "path": "cache-keeper",            "synced": "33a936f2ec6b"},
    "collision-guard": {"repo": "nateherkai/claude-code-mods", "path": "collision-guard",         "synced": "33a936f2ec6b"},
    "goal-meter":      {"repo": "nateherkai/claude-code-mods", "path": "goal-meter",              "synced": "33a936f2ec6b"},
    "recording-mode":  {"repo": "nateherkai/claude-code-mods", "path": "recording-mode",          "synced": "33a936f2ec6b"},
    "savvy-flow":      {"repo": "johnnyvizz/claude-kit",       "path": "plugins/savvy-flow",      "synced": "272a877f39b6"},
    "savvy-progress":  {"repo": "johnnyvizz/claude-kit",       "path": "plugins/savvy-progress",  "synced": "272a877f39b6"},
    "session-pulse":   {"repo": "local",                       "path": "session-pulse",           "synced": "local"},
    "you-should-know": {"repo": "local",                       "path": "you-should-know",         "synced": "local"},
}

# Mods built into Claude Code (no folder here): mod -> plugin id. Each must stay
# turned on in ~/.claude/settings.json. Keep in step with "Built-in mods" in CLAUDE.md.
BUILTIN = {
    "cc-plugin-you-should-know": "cc-plugin-you-should-know@builtin",
}
SETTINGS = os.path.expanduser("~/.claude/settings.json")


def enabled_plugins():
    try:
        with open(SETTINGS) as f:
            return json.load(f).get("enabledPlugins", {})
    except (OSError, ValueError):
        return {}


class FetchError(Exception):
    pass


def fetch_json(url, headers=()):
    # curl uses the macOS system certificates; some Python installs ship without any.
    cmd = ["/usr/bin/curl", "-fsSL", "--max-time", "30", "-H", "User-Agent: my-mods-update-check"]
    for h in headers:
        cmd += ["-H", h]
    r = subprocess.run(cmd + [url], capture_output=True, text=True)
    if r.returncode != 0:
        raise FetchError(r.stderr.strip() or f"curl exit {r.returncode}")
    return json.loads(r.stdout)


def gh_api(path):
    headers = ["Accept: application/vnd.github+json"]
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers.append(f"Authorization: Bearer {token}")
    return fetch_json(f"https://api.github.com/{path}", headers)


def raw_json(repo, ref, path):
    return fetch_json(f"https://raw.githubusercontent.com/{repo}/{ref}/{path}")


def local_version(mod):
    with open(os.path.join(ROOT, mod, ".claude-plugin", "plugin.json")) as f:
        return json.load(f).get("version", "?")


def mod_folders():
    return sorted(d for d in os.listdir(ROOT)
                  if os.path.isfile(os.path.join(ROOT, d, ".claude-plugin", "plugin.json")))


def notify(title, text):
    if sys.platform != "darwin":
        return
    script = f'display notification {json.dumps(text)} with title {json.dumps(title)}'
    subprocess.run(["osascript", "-e", script], capture_output=True)


def main():
    lines, updates, problems = [], [], []

    for d in mod_folders():
        if d not in TRACKED:
            problems.append(f"{d}: not tracked — add it to TRACKED in scripts/check_updates.py")
    for d in TRACKED:
        if not os.path.isdir(os.path.join(ROOT, d)):
            problems.append(f"{d}: tracked but folder is missing")
    enabled = enabled_plugins()
    for mod, plugin_id in BUILTIN.items():
        if enabled.get(plugin_id) is True:
            lines.append(f"  ok      {mod}: built in, enabled")
        else:
            problems.append(f"{mod}: built-in mod is not enabled; run `claude plugin enable {plugin_id}`")

    repo_state = {}
    for repo in sorted({t["repo"] for t in TRACKED.values() if t["repo"] != "local"}):
        try:
            head = gh_api(f"repos/{repo}/commits/HEAD")
            synced = {t["synced"] for t in TRACKED.values() if t["repo"] == repo}
            changed = {}
            for base in synced:
                cmp = gh_api(f"repos/{repo}/compare/{base}...{head['sha']}")
                changed[base] = [f["filename"] for f in cmp.get("files", [])]
            repo_state[repo] = (head["sha"], head["commit"]["committer"]["date"][:10], changed)
            lines.append(f"{repo}: HEAD {head['sha'][:12]} ({repo_state[repo][1]})")
        except (FetchError, KeyError, ValueError) as e:
            problems.append(f"{repo}: could not reach GitHub ({e})")

    for mod, t in TRACKED.items():
        if t["repo"] == "local" or t["repo"] not in repo_state or not os.path.isdir(os.path.join(ROOT, mod)):
            continue
        sha, _, changed = repo_state[t["repo"]]
        files = [f for f in changed[t["synced"]] if f.startswith(t["path"] + "/")]
        lo = local_version(mod)
        try:
            up = raw_json(t["repo"], sha, f"{t['path']}/.claude-plugin/plugin.json").get("version", "?")
        except (FetchError, ValueError):
            up = "?"
        if files or up != lo:
            updates.append(mod)
            lines.append(f"  UPDATE  {mod}: local {lo} → upstream {up}, {len(files)} file(s) changed")
        else:
            lines.append(f"  ok      {mod}: {lo}")

    lines += [f"  PROBLEM {p}" for p in problems]
    report = f"[{datetime.now():%Y-%m-%d %H:%M}] my-mods update check\n" + "\n".join(lines)
    print(report)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(report + "\n\n")

    if updates or problems:
        parts = []
        if updates:
            parts.append(f"Updates: {', '.join(updates)}")
        if problems:
            parts.append(f"{len(problems)} problem(s)")
        notify("my-mods", "; ".join(parts) + ". Ask Claude in ~/.claude/my-mods to check.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
