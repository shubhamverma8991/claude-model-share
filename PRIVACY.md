# Privacy policy

_Last updated: November 15, 2026_

model-share is a Claude Code mod that runs entirely on your own computer. It collects no data about you, and it sends nothing anywhere.

## What it reads

- **Your Claude Code session files**, under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). These files contain your conversations with Claude. The mod's script reads only the records of Claude's replies, and from each one uses only the model name, the token counts, the timestamp and the reply's ID (to count each reply once). It does not keep, display or pass on any message text.
- **Your weekly limit figure and reset time**, which Claude Code itself provides.

## What it stores

Three values, in Claude Code's own per-plugin storage on your computer:

- your auto-refresh setting,
- whether the In / out token split is shown, and
- the last weekly limit percentage a session saw (so clients that don't receive it can still show it).

It keeps no usage history: totals are recounted from your session files each time and shown on screen only.

## What it sends

Nothing. The mod makes no network requests, has no analytics or telemetry, and shares no data with the author or anyone else.

## Removing it

Uninstalling the mod (`claude plugin uninstall model-share`) stops it from running. The three stored values are part of Claude Code's plugin data on your computer.

## Contact

Questions or concerns: open an issue at https://github.com/shubhamverma8991/claude-model-share/issues
