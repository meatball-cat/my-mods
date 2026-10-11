# you-should-know

Ask for a "You should know" summary whenever you want one.

Claude Code's built-in You should know mod (`cc-plugin-you-should-know@builtin`) checks on its own, at every 6th step of a long turn, and you can't start it yourself. This mod adds a command that runs the same kind of check right away. A side copy of the model reads the conversation and lists up to 5 things you might miss: results that look like success but aren't, risky actions, unstated assumptions, changes outside the ask, costs and loose ends.

| Command | What it does |
|---|---|
| `/you-should-know` | Check now |
| `/you-should-know <focus>` | Check with a focus, e.g. `/you-should-know tests` |
| `/you-should-know clear` | Hide the last summary |

While a check runs, the band shows a spinner and the seconds so far (`⠹ You should know · checking… 4s`). The command also works mid-turn. If another plugin already took the name, it registers as `/ysk`.

Each point is one numbered line, most urgent first: a colored tag, a headline of a few words, and an optional dim detail after a dash.

```
You should know · tests · 3 points
1  Risk     Only test is skipped — "OK" is not a pass
2  Verify   Edge cases untested — run with the skip removed
3  Changed  pricing.py rewritten — clamp added
```

| Tag | Meaning |
|---|---|
| Risk | Could break, lose data or mislead |
| Verify | Looks done but isn't confirmed |
| To do | Left unfinished |
| Changed | Touched outside the ask |
| Assumed | Decided without saying so |
| Cost | Time, money or tokens |

The summary shows above the prompt with two buttons:

- **Understood** hides it.
- **Ask Claude** puts the points in the prompt box as a draft, so you choose whether the main chat sees them.

It's also added to the transcript as a dim line. Neither one is sent to the model.

Each check is one model call on your usage. It reuses the main chat's prompt cache, so it costs little while the cache is warm. It doesn't change the main chat's prompt, model or cache.
