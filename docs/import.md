# Importing from Notion or Obsidian

**Create a workspace → Start with → Import** takes a Notion export or a zipped folder of
Markdown, such as an Obsidian vault, and makes a new workspace of it. The node converts the export
into a [workspace archive](workspace-archive.md) and imports that, with the same checks.

## Notion

Export as **Markdown & CSV** with subpages: a page from its **⋯ → Export**, or everything from
**Settings → Workspace → General → Export all workspace content**. Upload the zip Notion sends, parts and all.
If Safari unzipped it, compress the folder again. The workspace takes the Notion workspace's name.

| In Notion | In Stuga |
|---|---|
| A page | A document |
| A page with subpages | A folder holding the page and its subpages |
| A teamspace | A folder |
| A database | A database, each column typed by what its cells hold: checkbox, number, date, select or text |
| A linked view | A link to its database |
| A row's page | The row's page, when it holds more than the row's properties |
| A link to a page or row | A link to the document, row page or row |
| An image | The image |
| A PDF or other file on a page | The file, linked from the document, where it downloads |
| A Files & media property | A files column holding its files |
| A callout | A block quote |
| A toggle | Its title in bold, then what it holds |
| A to-do | ☐ or ☑ |

Multi-select, relation, person, formula and rollup cells come across as text, a date with a
time as its date, and a date range as text. Comments, sharing and icons do not come across. Notion's
HTML export is refused.

## Obsidian and other Markdown folders

Zip the vault's folder (on a Mac, **Compress**) and upload the zip. Anything under a name starting
with a dot, such as `.obsidian` and `.trash`, is left aside.

| In the vault | In Stuga |
|---|---|
| A folder with notes | A folder |
| A note | A document, titled by its first-level heading, else its `title` property, else its file name |
| `[[Note]]`, `[[Note\|text]]`, `[[Note#Heading]]` | A link to the note; to a note that does not exist, its text |
| `![[image.png]]` | The image |
| `![[Note]]` | A link to the note |
| `![[Slides.pdf]]`, `[[Slides.pdf]]` | A link to the file, which goes along |
| `> [!note] Title` | A block quote headed by the title in bold |
| `==highlight==` | Bold |
| `- [ ] Task` | ☐ Task |
| `%%comment%%`, `^block-id`, properties | Left out |

A link finds its note as Obsidian does: by path from the note's folder or the vault's top, else the
note of that name nearest the linking note.

## What is left out

A file no page or note links to has nowhere to go, and a file over the node's upload limit, 10 MB
unless an administrator raises it, is not kept; nor is a note over 4 MiB. When an export holds any,
Stuga lists them first and imports only once you choose **Import**. The node keeps the checked file
for an hour, so it is sent once.

The zip may be up to 512 MB, whatever the node's upload limit. A proxy in front of the node may take
less: Cloudflare's takes 100 MB.
