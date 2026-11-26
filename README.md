# wiki-sidebar

A Claude Code mod for the LLM Wiki Obsidian vault. It opens a "To-do quests" pane beside the chat that reads `todo.md` from the vault and shows the open to-dos that link to Slack, Notion or a Claude artifact, with level, streak and badges. Each to-do opens its link, and ticking one rewrites `todo.md`.

## Use
- Two sections, each folds from its header: **To do** (open by default) and **Meetings today** (folded; the header still shows how many are left and the next one).
- Meetings come from Google Calendar (the claude.ai connector, read with `$.mcp.call`). Declined, all-day, out-of-office and focus blocks are left out; past ones fold under "N earlier today".
- Each meeting shows a call to action by kind (you host, 1:1, daily, listen-in, meeting) and a **Prepare** button: it asks Claude to retrieve the context (earlier notes in `raw/meetings`, wiki pages, links in the invite, Slack/Notion, `todo.md`) and write a prep note to `meeting-prep/YYYY-MM-DD-<slug>.md` in the vault. Once the note exists the card shows **Open prep** (in Obsidian). **Prep my day** does all the unprepared ones in one go.
- The pane opens when a session starts.
- `/wiki` reopens it and prints the to-do list.
- Each open to-do has a **Start** button: it sends "Start working on: <item> (<link>) · <source>" to the chat, with the vault rule that anything outward-facing is a draft for review. Done items have none.
- Asking in plain words also opens it: "open the wiki sidebar", "show the sidebar", "apri la sidebar".

## Install
`/plugin install wiki-sidebar --marketplace andreacavagna/wiki-sidebar`, then enable `wiki-sidebar@wiki-sidebar` in the vault's `.claude/settings.json`.
