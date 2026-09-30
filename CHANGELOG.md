# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. One line per change, as someone running or using a node sees it; the docs have the details.
The release workflow turns each entry into its release notes ([RELEASING.md](RELEASING.md#the-changelog)).

Releases before 0.1.7 were previews. Their notes are on their
[GitHub Releases](https://github.com/stuga-dev/stuga/releases).

## [Unreleased]

## [0.1.7] - 2026-09-30

The first release: documents, databases and search for a team, on your own machine, with AI agents
whose edits wait for review.

### Added

- Documents edited together in real time, with comments, @mentions and version history.
- Databases with views, row pages and CSV import.
- Search in 22 languages; semantic search once an AI provider or Ollama is set up.
- AI agents connect over MCP; their edits wait for a person to accept them ([docs/agents.md](docs/agents.md)).
- Built-in AI with a hosted provider or Ollama, off until an administrator turns it on.
- Import from Notion and Obsidian; export a workspace as a `.stuga.zip`.
- Invite links, groups, guests and sign-in through your own OpenID Connect provider.
- A Mac package and a Docker stack for Linux, with daily backups and **Update now**.
- Remote access, by invitation for now ([docs/remote-access.md](docs/remote-access.md)).
