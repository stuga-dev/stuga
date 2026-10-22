# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. One line per change, as someone running or using a node sees it; the docs have the details.
The release workflow turns each entry into its release notes ([RELEASING.md](RELEASING.md#the-changelog)).

Releases before 0.1.7 were previews. Their notes are on their
[GitHub Releases](https://github.com/stuga-dev/stuga/releases).

## [Unreleased]

### Upgrade notes

- A node set up by a 0.1 release starts over with a new data directory: 0.1 releases were previews, and the database schema starts again here. Export each workspace from 0.1 first (**Settings → This workspace → General → Export workspace**) and import it into the new node ([Workspace archives](docs/workspace-archive.md)).

### Added

- Say **Save to Stuga** to your AI, in any of Stuga's languages, and it files what you told it into the right page and section of your team's wiki, corrects the sentence it changes, starts a page in the folder where it belongs, or adds it to your own **My notes**, then tells you what it saved where, what was there already, and what waits for approval. The new `remember` tool finds the places, the sentences that say a point already and those it may make untrue, and takes the meeting, email or document a point came from as its `source`; each write follows the page's review level ([Save to Stuga and Ask Stuga](docs/agents.md#save-to-stuga-and-ask-stuga)). What you tell your AI yourself is saved without your name or a date, which version history keeps; a point from a meeting or an email cites it. Points keep the language they came in, and with semantic search off, a point no page is about says its page may be written in another language.
- **My notes**: a folder of your own in each workspace, made the first time your AI saves there, shared with nobody until you share it. AI edits in it apply directly; once a page or folder in it is shared, every agent's edits there wait for review ([My notes](docs/agents.md#my-notes)).
- Say **Ask Stuga**, or ask what your team decided, and your AI answers from Stuga first. `search` and `retrieve` tell an agent who last changed each document and when, and which AI changes to it still wait for approval and for whom, listing the ones you asked for as they would land, the approved text now beside what it reads after approval, those about the question first and on the passage they change, and saying when some are not listed; an agent's `markdown` read lists the same, as your own changes. So your AI answers in one go with what is approved and what waits: "the page says 14 days; a change to 30 days waits for a colleague".
- Your AI is told whom it works for, by your Stuga name and username, so it never names you by a name guessed from a file path or an email address.
- An agent's `search` that finds no document holding every word lists those holding some of them and says the answer is partial; with semantic search off, an agent's `retrieve` answers from the passages that hold the question's words, says so when they hold only some of them, and reminds the agent that pages may be written in another language. Your own search box still matches every word.
- An agent's `markdown_edit` takes `old_string` and `new_string` for a `str_replace`'s `find` and `replace`.
- **Save to Stuga** and **Ask Stuga** as MCP prompts in your AI app's prompt menu; a read-only connection gets Ask Stuga.
- Each Claude Code session with the Stuga plugin starts with an index of the wiki pages Claude can read, with room kept for your own notes and a count of each ([The Stuga plugin](docs/agents.md#the-stuga-plugin), [`GET /api/agent/session-index`](docs/api.md#the-session-index)).
- While the node is out of reach or the sign-in waits, the stdio server lists the tools and prompts the node last gave that connection, so Claude Desktop keeps them when it lists them once at launch.
- When the AI co-author needs a fact or a choice only you can give, it asks in a comment on the passage and goes on with the rest. Reply with **Send to AI** ticked, and it edits the document as usual and answers in the thread ([Questions in comments](docs/agents.md#questions-in-comments)).
- A reply in a comment thread notifies the people in it, so you hear when someone answers your AI co-author's or your agent's question.
- Agents can reply in comment threads and attach a comment to a passage by quoting it, and hear of replies in threads they started ([Agents in comment threads](docs/agents.md#agents-in-comment-threads)).
- Amazon Bedrock as an AI chat provider: a Bedrock API key and a region; models such as Claude through the account's inference profiles ([Amazon Bedrock](docs/configuration.md#amazon-bedrock)).
- A review card for each AI change, laid out for a phone: who asked through which AI, the review level and who may decide, each change in its paragraph before and after with the sources it cites, and **Approve**, **Ask for changes…** and **Decline…**. Whoever may not approve reads why beside the button. Notifications, the inbox and review channel posts open it ([The review card](docs/agents.md#the-review-card)).
- A Slack review channel for a workspace or a folder: each AI change that waits for a colleague is posted there once, with its title, who asked, the level and a link to its card, never its text, in the language of whoever added the channel ([The Slack review channel](docs/agents.md#the-slack-review-channel)).
- A run's detail tells whoever reads its waiting text who may decide it (`deciders`), and `?full=1` carries the sources its footnotes cite (`citations`) ([API](docs/api.md#documents)).
- One piece of an AI's work across several pages, such as an ingest of a meeting or one Save to Stuga, is one change, reviewed on one card: the AI's summary first, then each page with its level and who decides it, and **Approve all**, which approves page by page what you may approve and says what is left and why. Whoever asked and each approver hear of it once, a review channel posts it once, and the inbox lists it as one row. Agents open one with `change_title` and pass its `change_id` to every write ([Changes](docs/agents.md#changes-one-piece-of-work-reviewed-as-one)).
- A page an AI makes in a folder where a colleague approves AI edits stays visible only to whoever asked and whoever may approve it until it is approved, then takes its folder's access; declined, it goes to the trash ([New pages in a change](docs/agents.md#new-pages-in-a-change)).
- An AI's later change to a page that still has its earlier change waiting queues behind it, so one hub page, such as a customer list, takes every ingest; the card and the agent's answer say what it waits behind ([A queue on a page](docs/agents.md#a-queue-on-a-page)).

### Changed

- A release carries the Mac package as `Stuga-<version>.pkg` only, and [stuga.dev/download/mac](https://stuga.dev/download/mac) always downloads the newest. Links to `releases/latest/download/Stuga.pkg` stop working once this release is out.
- **Reranking** lists the models the service offers to choose from: Jev's versions on TypeSafe, and every decision model on OpenRouter, such as Microsoft-Decision-1, Perplexity's decider and Liquid's d1.
- AI setup forms no longer link to each service's key page.
- Comments and their notifications name an agent by the person it works for, such as "Liv's agent", never by its own name. So does version history, for the changes an agent applies.
- An agent's comment may mention at most 5 people: more is refused with `400` and nothing is saved, where REST used to keep the first 20. One person's agents send at most 60 comment notices an hour in a workspace; past that the comment is still saved, and the answer carries `notifications_held` ([Agents in comment threads](docs/agents.md#agents-in-comment-threads)).
- Keyword search runs on Postgres's own full-text search, ranked by BM25 over the documents you can see, and matches Chinese, Japanese, Korean and Thai better, in any text and with no setting ([Search languages](docs/configuration.md#search-languages)).
- **Languages in your documents** chooses the languages search matches by stem: Arabic, Danish, Dutch, Finnish, French, German, Greek, Hungarian, Italian, Norwegian, Portuguese, Romanian, Russian, Spanish, Swedish, Tamil and Turkish. English, Chinese, Japanese, Korean and Thai are always on. A change applies to searches at once, while the index is written again in the background.
- The node's Postgres needs pgvector and the extensions Postgres ships with, so the Mac package is smaller and a Postgres you run yourself needs only pgvector added ([packaging/contract.md](packaging/contract.md#postgres)).
- Deleting a folder puts every document in it in the trash. While one of them is locked, nothing is deleted and the confirmation says how many to unlock.
- Appending under a heading that has subsections, such as a page's title heading, adds the text at the end of that heading's own text, before its first subsection, and the answer says so; it used to land at the end of the last subsection. A heading that is not there is refused with the headings the page has ([api.md](docs/api.md#proposing-an-edit)).
- A heading with no text of its own, such as a page's title heading, is no longer a passage that search and retrieval answer with.
- **Review AI edits** has three tabs, **Needs you**, **Waiting on others** and **Done**, in place of its **Show** filter, and a run opens its review card. A run's **⋯** menu offers **Ask for changes…** and **Decline** as the card does, and a decided run counts what was approved and declined. `GET /api/runs` takes `filter=waiting` and `filter=done` in place of `open` and `closed` ([The review inbox](docs/agents.md#the-review-inbox)).
- **Who reviews AI edits…** shows every floor under an item: its folder's level, a row page's database's, and at least **Reviewed by whoever asked the AI** for a page shared out of My notes, offering nothing below the last two. Such a page now shows the level the node holds agents to, where it showed its folder's **AI edits apply directly**; summaries carry `agent_mode_floors` ([API](docs/api.md#documents)).

### Removed

- Czech and Polish as search languages; their words match as written.

### Security

- The Mac package and the Docker image run Node.js 26.12.1, a security release.
- A workspace or folder webhook receives events only for documents its creator can read, checked again at each delivery. A workspace admin's webhook used to receive the titles and comment excerpts of documents shared with others but not with them ([Webhooks](docs/api.md#webhooks)).

### Fixed

- Mermaid diagrams render again: their colours came through in a form the diagram renderer refused.
- A comment posted, resolved or deleted while the AI co-author is working on the document no longer waits for it to finish.
- An agent's comment notifies the people it mentions, as documented.
- An agent's comment over REST is attached to a passage only by `quote`, held to the same rule as over MCP: its `anchor_quote` must appear once in the text as written, and positions are refused with `400`.
- The Comments panel offers **Resolve** and **Delete** only on comments you may change, and says why when one is refused.
- On a phone, the review bar's buttons stay inside the bar.
- An AI answer no longer shows source markers that point at nothing.
- Going back to an earlier version on a Mac or with Docker no longer notes that the node will migrate the backup's schema: the earlier version serves it at its own.
- `GET /api/node/version` names a `previous_version` only when another version served the data before, so a restart or going back to the backup's own version answers null.
- `stuga list` on a Mac, and `stuga-node`'s `list`, `verify`, `restore` and `backup`, write their answer to stdout, so it can be piped or saved; progress and notes stay on stderr.
- The node no longer prints a warning about `localStorage` each time it starts or runs a command.
- On a Mac, `/Library/Logs/Stuga/helper.log` has a line for each step of an update it installs, naming the version and why one did not install, and for each change to remote access.
- Going back on a Mac without a connection names the address of the package to download and pass with `--pkg`.
- A restore asks for the backup's name after saying that work done since the backup is kept aside, on a Mac and with Docker.
- A backup name piped into a restore ends the prompt's line, so the next step starts on a line of its own.

## [0.1.15] - 2026-10-12

Security fixes: the node checks the address of every connection it makes for someone else's URL, and
the Docker images move to Debian 13 with its current security updates. Search moves to pg_search
0.26, which is why there is no going back from this release.

### Upgrade notes

- Going back from 0.1.15 to an earlier release is refused, even with the backup taken before upgrading: 0.1.15 updates the search engine (pg_search 0.26), and an earlier release can't use its indexes.
- The first start after upgrading rebuilds the keyword search indexes once, so a large node takes longer to be ready.

### Security

- Images and files by URL, webhook deliveries and apps' metadata documents check the address of each connection as it is made, so a name that resolves to a public address when checked and a private one when fetched no longer reaches the node's network. Reserved ranges, the node's own addresses and its IPv6 network are refused too. Behind a fake-IP proxy such as Clash or Surge, these need real DNS ([Troubleshooting](docs/troubleshooting.md#uploads-and-disk)).
- The Docker images are built on Debian 13 (trixie) and carry its current security updates, and the node image no longer carries npm.

### Changed

- Search runs on pg_search 0.26.1, and the node on Node.js 26.11.1.

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
