#!/usr/bin/env python3
"""Check the CLAUDE.md rules that `claude plugin validate` doesn't.

Read-only and offline. CI runs it through scripts/ci.sh; by hand:
`python3 scripts/check_repo.py [--base <git-ref>]`.

- every mod folder is in marketplace.json, the CLAUDE.md "Upstream sources"
  table and TRACKED in check_updates.py, and the table and TRACKED agree
- the shared copies of privacy.mjs, fmt.mjs and pricing.mjs are identical
- nothing from ~/.claude/mods-data and no .env file is committed
- with --base: every mod whose files changed since <base> has a higher version
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

from check_updates import BUILTIN, ROOT, TRACKED, mod_folders

SHARED = ("privacy.mjs", "fmt.mjs", "pricing.mjs")


def git(*args):
    return subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True, check=True).stdout


def read_json(*path):
    with open(os.path.join(ROOT, *path)) as f:
        return json.load(f)


def table_rows(section):
    """Data rows of the table under "## <section>" in CLAUDE.md, as lists of cells."""
    rows, in_section = [], False
    with open(os.path.join(ROOT, "CLAUDE.md")) as f:
        for line in f:
            if line.startswith("## "):
                in_section = line.strip() == f"## {section}"
            if not in_section or not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells[0] == "Mod" or set(cells[0]) <= set("-: "):
                continue
            rows.append(cells)
    return rows


def upstream_table():
    """Rows of the "Upstream sources" table in CLAUDE.md: mod -> repo, path, synced."""
    rows = {}
    for cells in table_rows("Upstream sources"):
        if len(cells) != 4:
            continue
        mod, repo, path, synced = cells
        rows[mod] = {
            "repo": repo.removeprefix("https://github.com/").rstrip("/"),
            "path": path.strip("`").rstrip("/"),
            "synced": synced.split()[0] if synced else "",
        }
    return rows


def check_listed(mods, problems):
    entries = {p["name"]: p for p in read_json(".claude-plugin", "marketplace.json")["plugins"]}
    table = upstream_table()
    for mod in mods:
        name = read_json(mod, ".claude-plugin", "plugin.json").get("name")
        if name != mod:
            problems.append(f"{mod}: plugin.json name is {name!r}, not the folder name")
        if mod not in entries:
            problems.append(f"{mod}: missing from .claude-plugin/marketplace.json")
        elif entries[mod].get("source") != f"./{mod}":
            problems.append(f"{mod}: marketplace.json source is {entries[mod].get('source')!r}, not './{mod}'")
        if mod not in table:
            problems.append(f"{mod}: no row in the CLAUDE.md Upstream sources table")
        if mod not in TRACKED:
            problems.append(f"{mod}: missing from TRACKED in scripts/check_updates.py")
        if mod in table and mod in TRACKED:
            for key in ("repo", "path", "synced"):
                if table[mod][key] != TRACKED[mod][key]:
                    problems.append(f"{mod}: {key} is {table[mod][key]!r} in CLAUDE.md "
                                    f"but {TRACKED[mod][key]!r} in TRACKED")
    for where, names in (("marketplace.json", entries), ("CLAUDE.md", table), ("TRACKED", TRACKED)):
        for name in sorted(set(names) - set(mods)):
            problems.append(f"{name}: listed in {where} but has no mod folder")


def check_builtin(mods, problems):
    table = {cells[0]: cells[1].strip("`") for cells in table_rows("Built-in mods") if len(cells) == 3}
    for mod in sorted(set(table) | set(BUILTIN)):
        if mod in mods:
            problems.append(f"{mod}: listed as built in but has a mod folder")
        if mod not in table:
            problems.append(f"{mod}: in BUILTIN but no row in the CLAUDE.md Built-in mods table")
        elif mod not in BUILTIN:
            problems.append(f"{mod}: in the CLAUDE.md Built-in mods table but missing from BUILTIN")
        elif table[mod] != BUILTIN[mod]:
            problems.append(f"{mod}: plugin id is {table[mod]!r} in CLAUDE.md but {BUILTIN[mod]!r} in BUILTIN")


def check_shared(mods, problems):
    for name in SHARED:
        groups = {}
        for mod in mods:
            path = os.path.join(ROOT, mod, "hooks", name)
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    groups.setdefault(hashlib.sha256(f.read()).hexdigest(), []).append(mod)
        if len(groups) > 1:
            sets = " | ".join(", ".join(g) for g in groups.values())
            problems.append(f"hooks/{name} differs between mods ({sets}); keep every copy identical")


def check_user_data(problems):
    for path in git("ls-files").splitlines():
        parts = path.split("/")
        if "mods-data" in parts or parts[-1] == ".env":
            problems.append(f"{path}: user data or secrets must not be committed")


def version_key(version):
    return tuple(int(p) for p in version.split("-")[0].split("."))


def check_bumps(mods, base, problems):
    fork = git("merge-base", base, "HEAD").strip()
    changed = {p.split("/")[0] for p in git("diff", "--name-only", fork, "HEAD").splitlines()}
    for mod in sorted(changed & set(mods)):
        try:
            old = json.loads(git("show", f"{fork}:{mod}/.claude-plugin/plugin.json")).get("version", "")
        except subprocess.CalledProcessError:
            continue  # a new mod
        new = read_json(mod, ".claude-plugin", "plugin.json").get("version", "")
        try:
            bumped = version_key(new) > version_key(old)
        except ValueError:
            bumped = False
        if not bumped:
            problems.append(f"{mod}: files changed but version {new} is not above {old}; "
                            "bump .claude-plugin/plugin.json (and its marketplace.json entry, if it has one)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="git ref to compare against for the version-bump check")
    args = parser.parse_args()

    mods, problems = mod_folders(), []
    check_listed(mods, problems)
    check_builtin(mods, problems)
    check_shared(mods, problems)
    check_user_data(problems)
    if args.base:
        check_bumps(mods, args.base, problems)

    prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") else "PROBLEM "
    for p in problems:
        print(prefix + p)
    checked = f"{len(mods)} mods" + (f", version bumps since {args.base}" if args.base else "")
    print(f"{'FAILED' if problems else 'ok'}: repo rules ({checked})")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
