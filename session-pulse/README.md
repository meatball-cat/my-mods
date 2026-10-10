# Session Pulse

Every open Claude Code session on one live board, above the prompt:

```
● Edit the opening animation   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  72%  ~30m      ×
✓ Fix the login bug            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%  3m ago    ×
● Write the newsletter         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  45%  ~12m      ×
● Review the payments PR       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  60%  needs you ×
```

- **A row per live session**: working, waiting on you, or finished within the last hour. The bar warms from orange to yellow-green as it fills, green with a check when done, blue when the session needs you (a permission or a question), grey when interrupted, red on an error.
- **A rough time left** at the end of each row (`~30m`, `<1m`).
- **Click a row to switch to that session.** A desktop session opens in the Claude app (`claude://code/continue?session=local_…`). A terminal session can't be focused from here, so its `cd … && claude --resume …` command is copied.
- **× hides a row** until that session starts its next turn.
- **Alerts**: a toast when another session finishes or needs you.
- **`/pulse`** opens the whole board in a pane: idle, hidden and silent sessions too, each with what it is doing (`Editing register.tsx`, `plan 3/5`, `running 4m`).

## Commands

| Command | Does |
|---|---|
| `/pulse` | Open or close the board pane |
| `/pulse compact` · `full` · `off` | One summary line, a row per session, or no band |
| `/pulse alerts on` · `off` | Toasts when another session finishes or needs you |
| `/pulse show` | Bring hidden rows back |
| `/pulse name <title>` | Rename this session on the board (no title: back to automatic) |
| `/pulse demo` · `demo off` | Five made-up sessions for three minutes, to see every state |

If another plugin owns `/pulse`, the command is `/session-pulse`.

## How the percent is worked out

- **With a plan** (TodoWrite, the Task tools, savvy-progress, or a goal-meter goal): finished tasks out of the plan, with the task in progress creeping forward at the pace the earlier tasks took. Time left is that pace times the work left.
- **Without a plan**: how long turns usually take, learned from this session's last turns and every session's median (90 s before anything is learned). At the usual length the bar shows two thirds; it slows as a turn runs long and only reaches 100% when the turn ends. Time spent waiting on you doesn't count.

It's an estimate, marked with `~`. It never moves backwards during a turn.

## Where it keeps things

- `~/.claude/mods-data/session-pulse/s-<session>.json`: each session's heartbeat (state, title, timing, plan), rewritten at least every 15 s. A session silent for 75 s shows as not responding; files older than 12 h are removed.
- `~/.claude/mods-data/session-pulse/hide-<session>.json`: rows you hid.
- The plugin's store: settings and recent turn lengths.
- Titles come from the desktop app's own session title when there is one, else the first prompt.
- While Recording Mode is on (`~/.claude/mods-data/recording.json`), rows show as `Session 1`, `Session 2` with no activity or folder.

No network calls, no model requests, nothing added to Claude's prompt.
