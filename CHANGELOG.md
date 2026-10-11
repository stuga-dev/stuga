# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. One line per change, as someone running or using a node sees it; the docs have the details.
The release workflow turns each entry into its release notes ([RELEASING.md](RELEASING.md#the-changelog)).

Releases before 0.1.7 were previews. Their notes are on their
[GitHub Releases](https://github.com/stuga-dev/stuga/releases).

## [Unreleased]

## [0.1.14] - 2026-10-10

Stuga in nine languages; open pages follow what others do to them, live; safer sharing with links
you can turn off; database grids that work like a spreadsheet, with CSV in and out; task lists,
download and print for documents; and AI rewrites that read as whole sentences.

### Added

- Stuga speaks your language: the app, its notifications and alerts, and the Mac menu bar and installer come in English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español and Português (Brasil). The app follows your browser until you pick a language in **Settings → Appearance**, which then goes with your account; the menu bar follows your Mac.
- A database grid works like a spreadsheet from the keyboard: typing on a cell starts editing with that character, the arrow keys move between cells, F2 edits, Delete clears, and Enter moves down.
- Paste a block copied from a spreadsheet into a database: it fills the cells right and down, adding rows as needed. Copy a cell with ⌘C or Ctrl+C.
- A number column can show money, percentages, fixed decimals and grouped thousands (**Number format…** in the column's menu). Numbers show in your locale, and each column header shows its type.
- An image in a files column opens in a preview, and removing a file offers Undo.
- **Download as CSV** in a database's menu and each table's menu writes the rows and columns on screen, filters and sort included, as a file Excel and Numbers open, Chinese text too.
- Import a spreadsheet as it is: each of the file's columns goes to a column you pick, to a new column, or nowhere, and **New database from CSV…** makes a database from a file. A file can also land in a new table of its own.
- **Search this table** in a database's toolbar, and the workspace search finds a database by what its cells say, such as an order number or a product name.
- Task lists in documents: type `[ ] `, or choose **Task list** in the toolbar or the `/` menu. Markdown, Notion and Obsidian to-dos import as tasks, and agents read and write them as `* [ ]`.
- **Download as Markdown**, **Print…** (which also saves a PDF) and **Make a copy** in a document's ⋯ menu; a library row offers Download and Make a copy.
- An attached file shows as a chip with its name and size, and a link to a Stuga page shows its title.
- A summary after importing a workspace: what came in, which files were left out and why, and what changed on the way in. An export holds a README and a CSV copy of each table.
- **Settings → This workspace → Groups**, where an admin makes groups and changes who is in them.
- An invite link can say who it is for, and the sign-in page has **Forgot password?**.
- A share link can be turned off, and someone without access can ask for it; the people who manage the document see the request in **Share**.
- **Keyboard shortcuts** (press `?`, or ⌘/ or Ctrl+/) lists the shortcuts the app has.

### Fixed

- Typing into a database cell reached with Tab no longer loses what comes before the first space.
- A number cell refuses what is not one number, such as "1.2.3" or "abc", reads "4,50" as four and a half, and refuses a whole number too large to store exactly.
- A date cell refuses years before 1900 or after 2100, and a refused date no longer leaves its editor stuck open.
- A new database's table takes the database's name, and keeps following it until you name the table yourself.
- Deleting a table says how many rows and columns go with it, counted when you ask.
- An import no longer says "All 4 columns matched" under "None of the rows can be imported", nor suggests a column that merely looks alike, and lines of only commas are no longer imported as rows.
- The table assistant says where to let it read your documents when a request needs them.
- When someone else changed a cell while you were editing it, your edit no longer replaces theirs unseen: the cell shows their value and **Use mine** puts yours back. A column deleted while you edit it says so in plain words.
- Open pages follow a lock, unlock, trash, restore, permanent delete, change of access or role, or removal at once: read-only, with a banner and the text kept to copy. A page whose sign-in ended says so and comes back after signing in again.
- A page left open across an upgrade reloads into the new version before it syncs, so it can no longer drop what it cannot show, such as a task list.
- Leaving a document whose latest changes have not reached the node asks first. A lost connection shows within seconds, in plain words ("Offline", "Reconnecting", "Changes not sent yet"), and a page that failed to load while offline loads by itself when the network is back.
- Comments, replies, resolves and renames reach everyone with the document open, a mention notification opens its comment, and the bell shows what is unread.
- A new document's header takes its first line as you type, restoring a version tells the other editors who restored which version, and version history says how much was added or removed.
- Collaborators' colours no longer clash in a document, their name flags no longer cover the line above, and `@` lists the people who can open the document.
- A new document or folder is shared no wider than the folder it is made in, and people added in **Share** start at Can view.
- Rejecting an AI edit on a locked document or database works, and so does undoing that rejection; only accepting waits for an unlock.
- **Review AI edits** counts only the changes you can decide.
- Pasting lines into a database cell you are editing keeps them in that cell; a range copied from a spreadsheet still fills the cells around it.
- A workspace export keeps each number column's format.
- Renaming selects the whole name, so typing replaces it, and a new item no longer starts with the text "Untitled".
- Inserting an image or a file after another, or with the caret in the title, adds it below instead of replacing what was there.
- An AI rewrite shows the old sentence struck through and the new one in full, instead of interleaved words, and the AI calls its edits suggestions and leaves the count to the page.
- Opening a cited passage from an answer no longer reports that it could not be found, and leaving Ask mid-answer shows **Stopped** with **Try again**.
- With **Let AI edits apply directly**, the open page shows at once what the AI changed.
- Error messages go away by themselves, show once, and no longer cover Send or the panel's buttons.
- On a phone, search opens inside the screen, and buttons are large enough to tap.
- The library updates as others add, rename or move items, a folder opens from its name, and a right click opens the item's menu.
- Moving an item into a folder that shares it more widely asks first and names who gains access; **Share** shows where each person's access comes from.
- A browser tab shows the name of the page it holds.
- Search for a one-letter or Chinese word no longer lists unrelated documents.

## [0.1.13] - 2026-10-08

A security fix for search excerpts; Settings shows a model's full name and lists each of Ollama's
models once; a note under a change outlasts a failed rejection, and choosing a Chinese or Japanese
input candidate no longer sends what you are typing.

### Security

- A search hit's excerpt no longer depends on how often a word appears in documents you cannot read or in other workspaces: it is the passage of the document showing the most of your search's words ([Postgres](docs/architecture.md#postgres)).

### Fixed

- Remote access orders no certificate once the CA's new terms wait for an administrator, or the service has refused the node, even when that is recorded while a renewal is starting.
- The model field in **Settings → This node → AI providers → Edit** takes the row's width, so a long id such as `embeddinggemma-2:270m` shows whole.
- A model Ollama 0.40 lists twice, such as `embeddinggemma:300m`, shows once among the models to choose from.
- **Test** for **Semantic search** says how long the service took to answer, as it does for **Built-in AI** and **Reranking**.
- A note written under a change in the document is still there, as written, when its rejection fails ([Reject with a note](docs/agents.md#reject-with-a-note)).
- A note left unsent under a change no longer comes back when that change, decided another way (**Reject all**, a collaborator), returns for review.
- The document repainting around a note you are writing keeps your caret and selection, and waits while an input method is composing.
- The Enter that picks a Chinese or Japanese input candidate, in Safari too, no longer sends or applies what you are typing: a note, comment, chat message, **Edit with AI** request, question, search, link, caption, cell or filter, or a pick in the slash or mention menu.
- Closing the note opened from the menu beside **Reject all** puts the focus back on that menu's button.

## [0.1.12] - 2026-10-08

**Reject with note** on an AI edit, so the agent revises from your note; undo for every review
decision; search that fits each embedding model, EmbeddingGemma 2 among them, and shows why each hit
matched; one command to go back to an earlier version on a Mac; and two security fixes: agents'
pending changes stay out of database queries, and a shared subfolder no longer reveals the folders
above it.

### Upgrade notes

- Each document and database is brought forward when it first opens, keeping everything in it; an older version can't open it afterwards, so go back only with the backup taken before upgrading.

### Security

- A database query no longer reads the review ledger. Before, anyone who could read a database could select agents' pending changes from it.
- Someone given a subfolder no longer sees the names, owners and dates of the folders above it that they cannot read; the path shows each as **…**.

### Added

- One command goes back to an earlier version on a Mac: `sudo "/Library/Application Support/Stuga/current/bin/stuga" restore <backup>` ([macOS](docs/install/macos.md#go-back-to-an-earlier-version)). **Settings → This node → Backups** shows it for each backup.
- `stuga-node list` marks backups taken before an upgrade.
- **Reject with note…** rejects an AI edit with a note for the agent that made it; on the co-author's own edits in the document, with AI chat on, it is **Revise…**, and the button that sends the note says the same. Under a change in the document the note is written in place of its buttons; for a whole run it sits in the menu beside **Reject all** ([Reject with a note](docs/agents.md#reject-with-a-note)).
- **Revert with note…** in the review inbox takes back a run that landed and tells the agent why.
- The note leads the agent's reads and proposals there until it answers it, you mark the run reviewed, or 14 days pass.
- The co-author offers **Revise now**, changing only the passages you turned down.
- The `events` tool's `mine: true` lists the decisions on an agent's own proposals.
- **Undo** after every accept or reject, and the editor's undo walks back decisions and typing in the order they happened.
- Search finds a word you are still typing ("whe" finds "where"), and each hit shows the passage that matched and opens at it. Before you type, the search box lists recent documents.
- **Search strictness** (Strict, Balanced, Loose or Off) sets how far a match by meaning may sit in the search box. The node measures its embedding model when it is saved and sets the distance from how far that model places unrelated text, where one fixed distance suited a single model ([Search strictness](docs/configuration.md#search-strictness)).
- Semantic search takes an embedding model that returns fewer dimensions than the node stores, such as EmbeddingGemma 2 (768 on the default 1024), with no database change ([What is embedded](docs/rag-cross-doc-qa.md#what-is-embedded)).

### Changed

- Stuga on a Mac needs macOS 15 or later, the versions Apple still updates.
- A change shown in several places carries its buttons once; parts set apart link to them with **Go to decision**. A change the document can't show says why, in the banner and the change list.
- Stuga on a Mac takes about 330 MB instead of 480 MB.
- An earlier release started on a later one's data changes nothing and says which backup to restore.
- `./stuga restore` going back pins the whole stack to the backup's release.
- With **Chinese** on, keyword search reads traditional characters as simplified, in documents and searches alike, so either script finds the other ([Search languages](docs/configuration.md#search-languages)).
- Ask, agents' `retrieve` and the assistants' document search take the nearest passages at any distance, and reranking decides what is relevant.
- `/api/node/ai-settings` takes and returns `embed.search_strictness`, and returns `embed.cutoff`, `embed.calibration` and `strictness_default`, in place of `embed.search_max_distance`, `embed.retrieval_max_distance` and `max_distance_defaults`; `POST /api/node/ai-settings/calibrate` measures again.
- Queries and passages carry the instruction each known embedding model was trained with (EmbeddingGemma, Qwen3-Embedding, Nomic, E5, mxbai, Arctic Embed), so these models rank as their authors measured them.
- Settings suggests `embeddinggemma:300m` when Ollama has no embedding model yet.

### Fixed

- Installing on a Mac takes about 20 seconds less.
- A deletion between two edits no longer turns an AI's rewrite of a page into one change to accept or reject whole.
- `./stuga upgrade` refuses a `compose.yml` older than the data.
- `./stuga restore` works without a node container.
- After a failed upgrade, `./stuga` offers the backup the new version took.
- `install.sh` stops at once when the node refuses its data.
- The menu bar runs the new Stuga.app after an update.
- A patch to an older release line leaves the `:<major>` image tags alone.
- A passage Ollama refuses as longer than the embedding model's context (bge-m3 on long Korean text) is cut to fit and embedded, as Ollama cuts other long text, instead of staying out of search by meaning.
- Setting up a local Ollama that has no model yet lists its models again when you come back to the page, so one pulled in the meantime shows up.
- **Edit** asks for no API key for a local Ollama, as **Set up** does.

## [0.1.11] - 2026-10-02

### Fixed

- Search by meaning finds what you can read when many passages you can't read sit closer to the question.

## [0.1.10] - 2026-10-01

Stronger sign-in: wrong-password pauses, a costlier password hash, sessions that end at once, and
**Revoke everything**.

### Upgrade notes

- Everyone signs in again after upgrading, and apps connected over OAuth connect again.
- Over plain http, the node takes passwords only from its own network. Add public ranges that belong to it with `LOCAL_PASSWORD_NETWORKS` ([Network access](docs/network-access.md#passwords-over-plain-http)).

### Added

- **Revoke everything** in **Settings → Profile** ends every session, connected app, API key and shared link; administrators do it for others under **Account recovery**.
- Alerts say whether the node's notifications sent them.
- Changing your email or the node's notification channel is told to you and the administrators.

### Changed

- Reviewing an agent's edits, a rewritten sentence shows as one removal and one insertion.
- Wrong passwords pause sign-in for that account, longer each time; a browser that signed in before keeps working ([Privacy](docs/privacy.md#what-the-node-stores)).
- Passwords are stored with a stronger hash, upgraded at the next sign-in.
- A long passphrase needs no letter-and-number mix.
- Signing out, a password change or a reset ends a session's access at once.
- Sensitive changes ask you to confirm it's you if you signed in more than five minutes ago.
- An invite made through the API without limits admits one person for seven days.
- Slack, Discord and Teams notifications show names as written, never as links or mentions.

### Fixed

- An old browser waking up after a password change no longer signs you out of the one you just used.
- On a Mac, **Login Items** lists Stuga's background services under Stuga, not as `bash`.
- Removing a chat provider deletes its API key too.

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
