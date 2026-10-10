# Changing these mods (for Claude)

The user asked you to change how one of these mods works. Pick the lightest change that does the job, in this order.

The mods live in `~/.claude/my-mods` (on Windows, `C:\Users\<user>\.claude\my-mods`), a local directory marketplace named `my-mods`. Edit mods only here: Claude Code loads each one from `~/.claude/my-mods/<name>` (`claude plugin list --json` shows it as `readFromFolder`). The copy under `~/.claude/plugins/cache/my-mods` is the install record; never edit it, and keep it in sync with the bump-and-reinstall steps below.

## 1. A setting the mod already has

These are slash commands the user types. You can't run them for the user, so give them the exact command in one line.

| Mod | Change | Command |
|---|---|---|
| Cache Keeper | Size at which it asks before a cold send (default 150k) | `/cache big 100k` |
| Cache Keeper | Turn the cold-send question off or on | `/cache guard off` |
| Cache Keeper | Cache window if it guesses wrong (5 min, 1 hour, or learn it) | `/cache ttl 5`, `/cache ttl 60`, `/cache ttl auto` |
| Cache Keeper | Turn its alerts off or on | `/cache alerts off` |
| Cache Keeper | Keep this chat warm for N hours (max 24), or stop | `/keepwarm 2`, `/keepwarm off` |
| Recording Mode | Recording on, strict, off | `/rec`, `/rec strict`, `/rec off` |
| Recording Mode | Make the config file and reload it | `/rec config` |
| Goal Meter | Hide or show the bar above the prompt in this chat | `/goals hide`, `/goals show` |
| Goal Meter | Block file edits in a `/goal` until the plan exists | `/goals strict on`, `/goals strict off` |
| Goal Meter | Stop this chat's goal bar | `/goals clear` |
| Collision Guard | Turn it off or on | `/guard off`, `/guard on` |
| Collision Guard | How far back another chat's edits count (default 30 min) | `/guard window 60` |

Saved settings (`/cache`, `/goals strict`, `/guard`) apply in the chat where they're typed and in every chat opened after. If a command name was already taken by another plugin, the mod registers a fallback name: `/ck-cache`, `/ck-keepwarm`, `/ck-board`, `/ck-handoff`, `/recording`, `/goal-meter`, or `/collision-guard`.

## 2. Recording Mode's lists

Names to keep or hide, private folders, and extra tools to hide or block live in a config file you can edit yourself: `~/.claude/mods-data/recording-mode/config.json`. If it doesn't exist, make it with this shape:

```json
{
  "keepNames": ["Your Name"],
  "names": ["A Teammate", "A Client"],
  "privatePaths": ["clients/", "finance/", "my-private-notes.md"],
  "businessTools": [],
  "closedTools": []
}
```

- `keepNames`: the user's own name and brand, shown even while recording.
- `names`: people whose names are always masked. Names in emails and contact fields are picked up on their own.
- `privatePaths`: folders or file names Claude may not open while recording. Any part of a path matches, in any case.
- `businessTools`: tool or command names (any part) whose results draw as hidden.
- `closedTools`: tool names (any part) Claude may not call while recording.

Replace the example values; don't leave "Your Name" or "A Client" in it. Write valid JSON without a byte order mark. Then tell the user to type `/rec config` in any open chat that should pick up the change right away. New chats load it when they start.

## 3. Anything else: change the code

For behavior the settings don't cover (what a line shows, new patterns to mask, a different default, a new command), edit the source and reinstall.

**Where things are:**

- `<mod>/hooks/register.mjs` is the main file of each mod. The comment at its top explains what it does.
- `<mod>/.claude-plugin/plugin.json` holds the version.
- `privacy.mjs` (the masking rules used while recording) is copied into all four mods. `fmt.mjs` is in Cache Keeper, Goal Meter, and Collision Guard, and `pricing.mjs` is in Cache Keeper and Collision Guard. A hooks module can only import files inside its own plugin, so when you change one of these, make the same change in every copy and keep the copies identical.
- `goal-meter/hooks/plan.mjs` holds the goal math (weights, ETA). `collision-guard/hooks/coach.mjs` holds its shared helpers.
- `cache-keeper/skills/session-handoff/SKILL.md` is the handoff skill `/handoff` runs.

**Before you edit:** if this Claude Code has the `plugin-authoring` skill, load it for the mods API. The type reference is in `<mod>/.claude-plugin/types/` once a mod has loaded from a folder. Trust it over memory when they disagree.

**Rules for mod code:**

- Write every mods API call in full (`$.store.get(...)`), pass `$` only to top-level functions in the same file, use string literals for event names, and never pass `undefined` as an element prop. The validator checks these.
- Don't add changing text (times, counts, status) to Claude's prompt, and don't change the main chat's model or effort. Both break the prompt cache and cost the user money. Draw changing things on screen instead.
- Never write secrets (keys, `.env` values) to `$.store` or to files.
- Save files as UTF-8 without a byte order mark. On Windows PowerShell 5.1, `Set-Content -Encoding utf8` adds one, so use the Write tool.

**Then, every time:**

1. Bump `version` in `<mod>/.claude-plugin/plugin.json` (1.0.0 to 1.0.1, and so on). Installs are copies: without a new version, the update does nothing.
2. Validate: `claude plugin validate --strict "<home>/.claude/my-mods/<mod>"`. Fix everything it reports.
3. Reinstall: `claude plugin marketplace update my-mods`, then `claude plugin update <mod>@my-mods`.
4. Tell the user to open a new chat to load it (in the terminal, quit and run `claude` again). `/reload-plugins` and `/clear` don't reload mod code.
5. Add a line to `~/.claude/my-mods/CHANGES.md` (make it if needed): the date, the mod, the new version, and what changed in one sentence. A future reinstall or update from Nate replaces these files, and this list is how the change gets redone.

## Turning a mod off or removing it

- Off for now: `claude plugin disable <mod>@my-mods` (and `enable` to bring it back).
- Remove: `claude plugin uninstall <mod>@my-mods`.
- Either way, the user opens a new chat afterwards.

## Where the mods keep data

Everything is local, under `~/.claude/mods-data/`: Cache Keeper's chat heartbeats and saved handoffs, the recording flag (`recording.json`) and config, each chat's goal plan, and Collision Guard's per-chat file lists. Deleting a mod's folder there resets it. The mods make no network calls of their own. Cache Keeper's keep-warm pings are small model requests, sent only while `/keepwarm` is on.
