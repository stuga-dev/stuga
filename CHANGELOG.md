# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. One line per change, as someone running or using a node sees it; the docs have the details.
The release workflow turns each entry into its release notes ([RELEASING.md](RELEASING.md#the-changelog)).

Releases before 0.1.7 were previews. Their notes are on their
[GitHub Releases](https://github.com/stuga-dev/stuga/releases).

## [Unreleased]

### Added

- **Revoke everything**, in **Settings → Profile**: every session ends, and the identity provider link, connected apps, API keys and the links you shared go; a new password is the way back in. Administrators do it for someone under **Account recovery**, which hands back a password link.
- An alert about your account or the node says whether it also went out through the node's notifications: sending, sent, or not sent and why.
- Changing your email tells you and the node's administrators; when notifications go by email, yours goes to the address it was. Changing where the node sends notifications tells every administrator through the channel it had, and an alert not yet sent then is not sent through the new one.
- On a node whose address is `localhost`, invite and password links say they open only on this computer.

### Changed

- Reviewing an agent's edits, a sentence rewritten in other words shows as one removal and one insertion, not interleaved words.
- Wrong passwords pause sign-ins for that account, for longer each time; every route that checks a password counts them.
- Passwords are stored with a costlier hash, and a stored one is hashed again at the next sign-in.
- A long passphrase, such as `trumpet walnut ceiling`, needs no letter-and-number mix.
- Over plain http the node takes passwords only from its own network; `LOCAL_PASSWORD_NETWORKS` adds public ranges that belong to it. `reset-password` prints the SSH tunnel to open its link from outside the network.
- A session's access tokens stop working the moment it ends, by signing out, a password change or a reset link, rather than up to an hour later; a password change or reset also closes the account's live document connections. Everyone signs in again after upgrading, and apps connected over OAuth are connected again.
- Minting or rotating an API key, keeping one working longer, changing your email, setting a first password, linking or unlinking the identity provider, appointing an administrator, a password link, and changing the identity provider or notifications ask you to confirm it's you when you signed in more than five minutes ago.
- A browser that signed in before keeps signing in while wrong passwords from elsewhere pause the account. Each browser keeps a cookie for this ([Privacy](docs/privacy.md#what-the-node-stores)).
- A password change, an API key, Revoke everything and an hour-long pause after wrong passwords are notified to the person, in the app and through the node's notifications; Revoke everything to the administrators too.
- An invite link made through the API without limits admits one person for seven days, as the dialog's does; `null` asks for no limit or no expiry.
- In Slack, Discord and Teams notifications, a document's or an app's name shows as written, never as a link or a mention.

### Fixed

- On a Mac, **Login Items** no longer lists Stuga's four background services as `bash` from an unidentified developer: they are listed under Stuga.
- Removing a chat provider under **Settings → This node → AI providers** deletes its API key from the node too.

## [0.1.8] - 2026-09-30

### Changed

- Reviewing an agent's edits, a reworded passage reads as before → after with the line it sits in, and an edit beside a deleted section is a change of its own.

### Fixed

- **Uninstall Stuga…** in the Mac's menu bar no longer stalls for two minutes.
- On a Mac with no Apple Account signed in and nothing shared, the Mac's `.local` address now works: Stuga advertises itself over Bonjour while it runs.
- On a Mac, the setup page opens once Stuga has started, and **Set Up Stuga…** no longer asks the Mac's administrators for a password.
- **Copy link** on a document copies it at the node's address, not the one the browser reached it at.

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
