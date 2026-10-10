# my-mods

Local Claude Code plugin marketplace `my-mods` (6 mods). Claude Code loads each mod from `~/.claude/my-mods/<mod>`. Git remote: github.com/meatball-cat/my-mods (private). To change a mod, follow `CUSTOMIZE.md`.

## Upstream sources

| Mod | Upstream repo | Path in upstream | Last synced commit |
|---|---|---|---|
| cache-keeper, collision-guard, goal-meter, recording-mode | nateherkai/claude-code-mods | `<mod>/` | 33a936f2ec6b (2026-10-02) |
| savvy-flow, savvy-progress | johnnyvizz/claude-kit | `plugins/<mod>/` | 272a877f39b6 (2026-10-04) |

## Checking for updates

Run this when the user asks to check or update the mods. This only reads, so it's always safe.

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
6. Update "Last synced commit" in the table above. Commit with a message naming the mods and upstream SHA, then `git push`.
7. Tell the user to open a new chat to load the new version.

## Rules

- Never edit `~/.claude/plugins/cache/my-mods/`; it's the install record.
- Each mod keeps its own copy of `fmt.mjs`, `privacy.mjs` and `pricing.mjs`. Do not deduplicate them.
- Never commit anything from `~/.claude/mods-data` or other user data.
