# wiki-sidebar

A Claude Code mod for the LLM Wiki (`andreacavagna/llm-wiki`). It adds a sidebar next to the chat with:

- **Status**: sync with `main`, last commit, last daily and weekly runs, page and raw-source counts. Buttons: Refresh (fetches from GitHub), Run daily, Lint.
- **Ask the wiki**: a text box that sends `ask <question>` to Claude, which answers from the wiki per the repo's CLAUDE.md.
- **Open points**: unresolved `⚠️ Conflict` notes and 🔴 to-dos / open questions on wiki pages. Press one to ask Claude to help resolve it.
- **TODO**: your open action items (`- [ ] Andrea Cavagna — …`) from meeting notes of the last 14 days, plus "Action for Andrea" lines on wiki pages. Press to tick; ticks persist across sessions.

It refreshes after every turn. `/wiki` opens it (and prints the same content as text where an app can't draw panels); `/wiki <question>` asks the wiki directly.

It looks for the wiki in the session's working directory (open Claude Code in the vault folder), falling back to `/home/user/llm-wiki` for cloud sessions.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install wiki-sidebar --marketplace andreacavagna/wiki-sidebar
```

From a shell:

```
claude plugin install wiki-sidebar --marketplace andreacavagna/wiki-sidebar
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `andreacavagna/wiki-sidebar`, then Add plugin.

The repository is private: your machine needs a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).
