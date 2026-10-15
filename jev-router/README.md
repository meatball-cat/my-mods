# jev-router

Uses [Jev](https://typesafe.ai) (TypeSafe's judgment model) as a second opinion on two routing choices, each with an on/off button so you can compare results with and without it.

| Feature | What it does | Toggle |
|---|---|---|
| Skill routing | On each prompt you send, Jev picks the best-fitting skill. A confident pick (≥ 0.6, not `none`) reaches Claude as a hint it may ignore, and the transcript logs `Jev → <skill> (<confidence>)`. When Claude loads a skill, a line shows what it loaded next to Jev's pick. | `Jev ● on` button, `/jev` |
| Subagent model routing | When Claude starts a subagent without naming a model, Jev scores the task 1–4 and the subagent runs on Haiku (1), Sonnet (2–3) or Opus (4). The main conversation's model never changes, so its prompt cache stays intact. | `Model ● on` button, `/jev-model` |

Both settings are saved across sessions.

## Rules it keeps

- **Fails open.** If Jev errors, times out (5 s) or is unsure, nothing is added or changed. After a failure Jev is skipped for 2 minutes, so an offline session doesn't wait on every prompt.
- **Never overrides a model** Claude or you set, a `fork` subagent, or a plugin's agent type (`plugin:agent`, which names its own model).
- **Only your own prompts** are routed: notifications, peer messages and scheduled prompts are left alone.

## Setup

Needs `python3` and a TypeSafe API key, read from `TYPESAFE_API_KEY` or, on macOS, the keychain item with service `ai.typesafe.api` and your user name as the account (the same one the Jev MCP server uses):

```bash
security add-generic-password -s ai.typesafe.api -a "$USER" -w
```

The key is never written to a file, a log or a command line. Prompts reach the router on stdin, not as arguments.

## What it sends and keeps

- Sent to `api.typesafe.ai`: your prompt (first 8,000 characters) with every skill's name and description from `~/.claude/skills` and the project's `.claude/skills`; or a subagent's task text.
- Kept locally: `~/.claude/jev_log.jsonl`, one line per skill pick with the time, choice and confidence (no prompt text).

## Files

- `hooks/register.tsx`: the mod (buttons, commands, hooks).
- `scripts/jev_skill_router.py`: the Jev calls, Python standard library only. `--json <prompt>` prints `{"choice", "confidence"}`; `--complexity <task>` prints `{"score", "confidence"}`; `-` reads the text from stdin.
