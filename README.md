# claude-mods

Mods for [Claude Code](https://code.claude.com): plugins built from function
hooks. This repository is a plugin marketplace, so one command adds all of
them and you install the ones you want.

| Mod | What it does |
| --- | --- |
| [thread-pulse](plugins/thread-pulse) | Live cards for every shell command Claude runs, with the output as it runs (Command Watch). A status line for long calls, and a live line in Claude project thread checklists. |

## Install

    claude plugin marketplace add max06/claude-mods
    claude plugin install thread-pulse@claude-mods

Start a new session (or run `/reload-plugins`). Update later with
`claude plugin marketplace update claude-mods` and `claude plugin update thread-pulse@claude-mods`.

Mods need a Claude Code build with function-hook plugin support
(tested on 2.1.289).

## Develop

Each mod is a folder under `plugins/`. Check one before you push:

    claude plugin validate plugins/<mod>
    claude plugin test plugins/<mod>

To run your working copy, add this folder as a marketplace
(`claude plugin marketplace add .`): Claude Code then reads the mod from
the folder and `/reload-plugins` picks up edits.

## License

MIT, see [LICENSE](LICENSE).
