# wiki-sidebar

A Claude Code mod for the LLM Wiki Obsidian vault. It opens a "To-do quests" pane beside the chat that reads `todo.md` from the vault and shows the open to-dos that link to Slack, Notion or a Claude artifact, with level, streak and badges. Each to-do opens its link, and ticking one rewrites `todo.md`.

## Use
- The pane opens when a session starts.
- `/wiki` reopens it and prints the to-do list.
- Each open to-do has a **Start** button: it sends "Start working on: <item> (<link>) · <source>" to the chat, with the vault rule that anything outward-facing is a draft for review. Done items have none.
- Asking in plain words also opens it: "open the wiki sidebar", "show the sidebar", "apri la sidebar".

## Install
`/plugin install wiki-sidebar --marketplace andreacavagna/wiki-sidebar`, then enable `wiki-sidebar@wiki-sidebar` in the vault's `.claude/settings.json`.
