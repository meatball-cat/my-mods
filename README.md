# my-mods

A personal Claude Code plugin marketplace named `my-mods`: 9 mods kept in this folder, plus 1 built-in mod that ships with Claude Code. Claude Code loads each mod from `~/.claude/my-mods/<mod>`.

## Mods

| Mod | Version | What it does | Source |
|---|---|---|---|
| cache-keeper | 1.0.3 | Keeps a big chat's prompt cache warm, warns before an expensive cold restart, shows every local chat on one board (`/board`), and hands a chat off to a fresh one (`/handoff`) | [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods) |
| collision-guard | 1.0.1 | Asks before Claude edits a file another open chat changed in the last 30 minutes: Proceed, Move to a worktree, or Cancel (`/guard`) | [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods) |
| goal-meter | 1.0.0 | A progress bar for `/goal` built from Claude's own task plan: tasks done, elapsed time, an ETA, and every chat's goal in `/goals` | [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods) |
| recording-mode | 1.0.0 | `/rec` before you record: masks keys, personal details and business figures on screen and keeps private files closed | [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods) |
| savvy-flow | 1.2.1 | Skill: the session model plans, owns design and reviews; five tiered worker subagents implement | [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) |
| savvy-progress | 1.2.1 | Progress bar above the prompt for `/savvy-flow`, plus an agents panel (`/agents-info`) | [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) |
| jev-router | 0.1.0 | Jev picks the skill for each prompt (a hint Claude may ignore) and the model for each subagent; on/off buttons above the prompt (`/jev`, `/jev-model`) | local |
| session-pulse | 0.1.5 | Every open session on one live board above the prompt: progress bar, rough time left, state; click a title to switch (`/pulse`) | local |
| you-should-know | 0.1.4 | `/you-should-know`: a "You should know" summary on demand, shown above the prompt | local |

Built-in: `cc-plugin-you-should-know@builtin` ([docs](https://code.claude.com/docs/en/plugins/mods/overview)), turned on in `~/.claude/settings.json`. It has no folder here.

## Install

```bash
claude plugin marketplace add ~/.claude/my-mods
```

```bash
claude plugin install <mod>@my-mods
```

Open a new chat after installing or updating a mod to load it.

## Changing a mod

Follow [CUSTOMIZE.md](CUSTOMIZE.md): use a setting the mod already has first, then config files, and edit code only as a last resort. Edit mods only in this folder, never in `~/.claude/plugins/cache/my-mods/`.

## Updates

```bash
python3 scripts/check_updates.py
```

It prints one line per mod and flags untracked mods. It also runs weekly (Mondays 03:40) through a LaunchAgent; install the schedule with `scripts/install_schedule.sh`. Upstream sources and last synced commits are tracked in [CLAUDE.md](CLAUDE.md) and `TRACKED` in `scripts/check_updates.py`.

## CI

`scripts/ci.sh` validates the marketplace and each mod (`claude plugin validate --strict`), runs mod tests, and runs `scripts/check_repo.py`. It runs on every pull request and push to `main`, and locally before each push through `scripts/hooks/pre-push`:

```bash
bash scripts/ci.sh origin/main
```

## Adding a mod

In one commit, add it to `.claude-plugin/marketplace.json`, the Upstream sources table in [CLAUDE.md](CLAUDE.md), and `TRACKED` in `scripts/check_updates.py`. User data from `~/.claude/mods-data` is never committed.
