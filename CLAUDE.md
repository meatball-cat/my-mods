# my-mods

Local Claude Code plugin marketplace `my-mods` (7 mods, plus 1 built-in mod tracked below). Claude Code loads each mod from `~/.claude/my-mods/<mod>`. Git remote: github.com/meatball-cat/my-mods (private). To change a mod, follow `CUSTOMIZE.md`.

## Upstream sources

Every mod in this folder must have a row here. When a mod is added, add its row in the same commit: the repository link (`https://github.com/<owner>/<repo>`), the mod's path inside that repo, and the upstream HEAD commit it was copied from. A mod with no upstream (written locally) gets `local` in the repo column and is skipped by update checks. A mod without a row is an error. Before checking for updates, compare the folders here with this table and report any mod that's missing.

| Mod | Upstream repo | Path in upstream | Last synced commit |
|---|---|---|---|
| cache-keeper | https://github.com/nateherkai/claude-code-mods | `cache-keeper/` | 33a936f2ec6b (2026-10-02) |
| collision-guard | https://github.com/nateherkai/claude-code-mods | `collision-guard/` | 33a936f2ec6b (2026-10-02) |
| goal-meter | https://github.com/nateherkai/claude-code-mods | `goal-meter/` | 33a936f2ec6b (2026-10-02) |
| recording-mode | https://github.com/nateherkai/claude-code-mods | `recording-mode/` | 33a936f2ec6b (2026-10-02) |
| savvy-flow | https://github.com/johnnyvizz/claude-kit | `plugins/savvy-flow/` | 272a877f39b6 (2026-10-04) |
| savvy-progress | https://github.com/johnnyvizz/claude-kit | `plugins/savvy-progress/` | 272a877f39b6 (2026-10-04) |
| session-pulse | local | `session-pulse/` | local |

For `gh api` calls, `<repo>` is the `owner/repo` part of the link.

## Built-in mods

Mods that ship inside Claude Code. They have no folder here and no `marketplace.json` entry, so the rules above don't apply; nothing is synced or copied. Each one has a row here and a matching entry in `BUILTIN` in `scripts/check_updates.py`, which reports a problem when the mod is no longer turned on in `~/.claude/settings.json` (`enabledPlugins`). Built-ins always land in user scope: `--scope local` is ignored. To add one: `claude plugin enable <plugin id>`, then add the row and the `BUILTIN` entry in the same commit. To remove one: `claude plugin disable <plugin id>` and delete both.

| Mod | Plugin id | Docs |
|---|---|---|
| you-should-know | `cc-plugin-you-should-know@builtin` | https://code.claude.com/docs/en/plugins/mods/overview |

## Checking for updates

Run this when the user asks to check or update the mods. This only reads, so it's always safe.

Quick check: `python3 scripts/check_updates.py`. It prints one line per mod, flags untracked mods, and appends the report to `~/.local/share/my-mods-updater/update-check.log`. It also runs weekly, Mondays at 03:40, through the LaunchAgent `com.meatball-cat.my-mods.update-check`; that schedule's source is `scripts/com.meatball-cat.my-mods.update-check.plist`. To change the schedule, edit that file and run `scripts/install_schedule.sh`. The script sends a macOS notification only when an update or problem is found. For details on an update, use the steps below.

1. For each upstream repo, get HEAD: `gh api repos/<repo>/commits/HEAD --jq '.sha[0:12]+" "+.commit.committer.date'`. If it equals "Last synced commit", that repo is up to date.
2. Otherwise, see what changed since the last sync: `gh api repos/<repo>/compare/<last-sha>...HEAD --jq '.files[].filename'`. Keep only paths under each mod's upstream path.
3. Compare versions: the upstream `<path>/.claude-plugin/plugin.json` `version` against the local `<mod>/.claude-plugin/plugin.json`. A mod counts as changed when its files changed, even if the version stayed the same.
4. Report one line per mod: up to date / update available (old → new version, a one-line summary from the commit messages). Change nothing yet.

## Applying an update (only after the user says yes, per mod)

1. Clone the upstream repo shallowly into a temp dir outside this folder.
2. Before overwriting, check for local edits: diff the local mod against upstream at the **last synced commit**, and read `CHANGES.md` if it exists. Any local customization must be re-applied after the update. If it conflicts, show the user and ask.
3. Replace `<mod>/` with the upstream copy, re-apply local edits, and keep the mod name and its entry in `.claude-plugin/marketplace.json` unchanged. Never copy upstream's `marketplace.json`, `README.md` or `LICENSE` over the local ones.
4. If the version didn't change but files did, bump the patch version locally so the reinstall picks it up.
5. Run `claude plugin validate --strict ~/.claude/my-mods/<mod>`, then `claude plugin marketplace update my-mods` and `claude plugin update <mod>@my-mods`.
6. Update "Last synced commit" in the table above **and** the mod's `synced` value in `TRACKED` in `scripts/check_updates.py`. Commit with a message naming the mods and upstream SHA, then `git push`.
7. Tell the user to open a new chat to load the new version.

## CI

`.github/workflows/ci.yml` runs `scripts/ci.sh` on every pull request and every push to `main`. It runs `claude plugin validate --strict` on the marketplace and each mod, `claude plugin test` on each mod that has `*.test.ts(x)` files, and `scripts/check_repo.py`, which checks the rules below: every mod is listed in all three places and they agree, the shared helper copies are identical, no user data is committed, and on a pull request every changed mod has a higher version than on the base branch. Before pushing, run `bash scripts/ci.sh origin/main` and fix whatever it reports. `scripts/hooks/pre-push` runs it before every push and blocks the push if it fails; Claude sessions turn the hook on automatically (a SessionStart hook in `.claude/settings.json`), a plain terminal clone needs `git config core.hooksPath scripts/hooks` once, and `git push --no-verify` skips it. CI pins Claude Code in `CLAUDE_CODE_VERSION` in the workflow; bump it after updating Claude Code locally.

## Rules

- **Adding a new mod:** in the same commit, add it to (1) `.claude-plugin/marketplace.json`, (2) the Upstream sources table above, and (3) the `TRACKED` dict in `scripts/check_updates.py`, using the same repo (`owner/repo`, or `local`), path and synced commit as in the table. Then run `python3 scripts/check_updates.py` and confirm the new mod shows `ok` with no `PROBLEM` lines. Removing a mod means removing it from all three.

- Never edit `~/.claude/plugins/cache/my-mods/`; it's the install record.
- Each mod keeps its own copy of `fmt.mjs`, `privacy.mjs` and `pricing.mjs`. Do not deduplicate them.
- Never commit anything from `~/.claude/mods-data` or other user data.
