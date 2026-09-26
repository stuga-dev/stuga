# Workspace archive

A workspace archive holds one workspace as plain files: Markdown for documents and row pages, JSON
Lines for database rows, images, and a manifest, `stuga.json`, that ties them together. Zipped, it
is `<name>.stuga.zip`.

This page is format version 1. `services/node/src/archive/format.ts` is its code.

An archive carries folders, documents, databases (tables, columns, rows, views and row pages),
images, comments, agent instructions, and each document's review mode, lock and search setting. It
does not carry version history, the review and Activity history, sharing, members, collections,
favorites, or when rows were created and updated.

A workspace owner or admin exports one with **Settings → This workspace → General → Export
workspace**. **Create a workspace** with **Start with → From a file** imports one into a new
workspace.

## Layout

```
stuga.json                      the manifest
Start here.md                   a document
Laws/个人信息保护法.md          a document in the folder Laws
Obligations/                    a database's folder
  Obligations.jsonl             a table's rows
  pages/gdpr-breach.md          a row's page
media/<sha256>.png              an image, named for its bytes
```

Text files are UTF-8, with `\n` line ends and no byte order mark. A folder needs no entry of its
own: the manifest lists it. Nothing else belongs in an archive.

An import also reads a zip whose files all sit in one folder at its top, which is what a Mac's
**Compress** makes of the folder Safari unzips a download into, and leaves `__MACOSX/` aside.

## Paths

Every path in the manifest is relative to the archive's top, uses `/`, and is in Unicode NFC form.
Each segment is a name Windows, macOS and Linux can all create:

- at most 200 UTF-8 bytes, and at most 1,024 for the whole path;
- no `< > : " \ | ? *`, control characters or direction marks;
- no leading dot, no leading or trailing space, no trailing dot;
- not a Windows device name (`CON`, `NUL`, `COM1`, `CONIN$` …), alone or before spaces or an
  extension: `NUL .md` is one;
- not `data`, `dist`, `backups`, `node_modules` or `*.tsbuildinfo`, in lower case, which a Docker
  build of Stuga leaves out.

No two paths, or folders a path lies in, differ only in letter case, as macOS and Windows compare
them: `σ` and `ς` are one letter, and `ẞ`, `ß` and `ss` one name. `stuga.json` and `media` are the
archive's own top-level names. Folders nest at most 32 deep. A name need not be its item's title,
since the manifest holds titles, so a long title can have a shorter name that keeps every path
within 1,024 bytes. Stuga's export names items that share a title in one folder `Minutes.md`,
`Minutes (2).md` and on, oldest first, so a workspace gets the same names on every export.

## The manifest

| Field | Value |
|---|---|
| `format` | `"stuga-workspace"` |
| `version` | `1` |
| `generator` | What wrote it, such as `stuga 0.2.0`: one line of up to 200 characters, with no space at either end. |
| `exported_at` | A time. |
| `workspace` | `{name, agent_instructions}`. The name is 1 to 100 characters, one line, with no space at either end. |
| `start` | Optional. The path of the document to open first. |
| `items` | Folders, documents and databases, each parent before its children. |
| `sample` | Optional. `{steps}`, [below](#sample-steps). |

Text on one line holds no line break (U+2028 and U+2029 included), and no other control character
but a tab. A time is ISO 8601, `YYYY-MM-DDTHH:MM:SS` with an optional fraction of a second, then `Z`
or an offset from `-15:59` to `+15:59`, from year 1: `2026-09-25T10:00:00Z`.

Every item has `kind`, `path` and `parent`. `parent` is the path of a folder listed earlier, or
`null` at the top level, and `path` lies directly in it.

A **folder** (`kind: "folder"`) has `title`, as a document's, and `agent_instructions`.

A **document** (`kind: "doc"`) has a `.md` path, and these settings, which databases and row pages
share:

| Field | Value |
|---|---|
| `title` | 1 to 200 characters, one line. A line break or other control character in a title is written as a space. |
| `title_source` | `heading`: the body's first line gives the title. `user`: someone named it. |
| `agent_mode` | `review` or `auto`. |
| `locked` | `true` or `false`. |
| `search_hidden` | `true` or `false`. |
| `agent_instructions` | Up to 20,000 characters; `""` for none. |
| `comments` | Optional. [Comments](#comments). |

A **database** (`kind: "database"`) has a folder as its path, the settings above, and `tables`: at
most 20, each `{name, file, columns, views, pages}`. Table, column and view names are 1 to 200
characters, one line, with no space at either end.

- `name` is unique in the database, ignoring case. `file` is a `.jsonl` file directly in the
  database's folder.
- `columns`: at most 64, each `{name, type, choices?, description?}`. `type` is `text`, `number`,
  `checkbox`, `date` or `single_select`. A name is unique in the table ignoring case, and is not
  `_id`, `_created_at`, `_updated_at` or `_doc_id`. Only a `single_select` column has `choices`: 1
  to 50 distinct strings. A `description` is 1 to 500 characters, with no space or line break at
  either end.
- `views`: at most 20, each `{name, kind, position, filter, sorts, group_by, hidden_columns,
  config}`, with names unique in the table ignoring case. `kind` is `table`, and `position` a whole
  number, 0 or more. A view names columns by name; `filter`, `sorts` and `group_by` may also name
  `_id`, `_created_at`, `_updated_at` and `_doc_id`. `filter` and `group_by` are `null` for none.
  - A filter is a condition `{column, op, value}` or a group, `{and: […]}` or `{or: […]}`: at most
    20 conditions, groups at most 3 deep. `op` is `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`
    or `not_contains`, which take a `value`, or `empty` or `not_empty`, which take none.
  - A value is a string, a number, `true` or `false`; on a `number` or `checkbox` column, a string
    value reads as a number, except with `contains` and `not_contains`. An `_id` value is the key
    of a row in the table's rows file, and `_doc_id` takes only `empty` and `not_empty`.
  - `sorts`: at most 4 `{column, dir}`, each column once; `dir` is `asc` or `desc`.
    `hidden_columns` lists columns of the table, each once. `config` is a JSON object of at most
    16 KiB, `{}` for none.
- `pages`: each `{row, file}` and the settings above. `row` is the row's key, one page per row, and
  `file` is a `.md` file inside the database's folder.

## Bodies

A body file holds the document's Markdown as Stuga writes it, followed by one newline; an empty
document is an empty file. Stuga's Markdown is CommonMark with strikethrough, GFM tables and
footnotes, and no raw HTML.

With `title_source: "heading"`, the first line of the body's text, written as a title is, is the
title, as a heading or not: `# Start here` gives `Start here`.

## Rows

A rows file holds one JSON object per line, each ending in `\n`: `_id` and any of the table's
columns by name. An absent column is empty.

```
{"_id":"gdpr-breach","Law":"GDPR","Topic":"Breach notification","Deadline (hours)":72,"Checked":false}
```

`_id` is the row's key: 1 to 64 ASCII letters, digits, `.`, `_` and `-`, starting with a letter or
digit, unique in the file. A table holds at most 50,000 rows.

| Column type | Value |
|---|---|
| `text` | A string of at most 16,384 UTF-8 bytes. |
| `number` | A finite number. |
| `checkbox` | `true` or `false`. |
| `date` | `"YYYY-MM-DD"`, a real day. |
| `single_select` | One of the column's choices. |
| any | `null` |

## Links and images

A link to another item is relative to the body that holds it, as on the web: `../Start%20here.md`.
It leads to a document, a row page, a folder or a database. Whitespace, `%`, `#`, `?`, `(`, `)`,
`&`, `[`, `]`, `^`, `` ` ``, `{` and `}` in a path are %-encoded; other characters, Chinese or
Arabic included, stay as they are.

A link to a database may open a table, a view and a row, each value %-encoded:
`Obligations#table=Main&view=Breach&row=gdpr-breach`. Without `table`, it is the database's first
table.

An image is a file in `media/`, named for the SHA-256 of its bytes, with `png`, `jpg`, `gif` or
`webp` to match its type: `![Chart](../media/3f…a9.png)`. Each image is shown by at least one
body.

A link or image outside the archive is a full URL, and a bare `#fragment` is kept as it is. Every
other destination leads to something in the archive. A link that leads nowhere in Stuga, such as
`[Contributing](CONTRIBUTING.md)` kept from an imported Markdown file, is written as its text
alone, and such an image is left out. A person is plain `@name` text: an archive holds no mentions.

## Comments

`comments` lists a document's comments in `num` order:

| Field | Value |
|---|---|
| `num` | A whole number, unique in the document. |
| `parent` | `null` for a thread's first comment; else that comment's `num`. Threads are one level deep. |
| `author_name` | The author's name: 1 to 200 characters, one line, with a visible character, no space at either end, and no tab, direction mark or byte order mark. It names no account. |
| `created_at` | A time. |
| `resolved` | `true` or `false`. |
| `quote` | The text a thread's first comment is on, at most 2,000 characters; `null` or `""` for none. A reply's is `null`. |
| `body` | 1 to 20,000 characters, with no space or line break at either end. |

A document holds at most 5,000 comments.

## Sample steps

`sample.steps` holds what Sample agent does after a published sample is imported, in order. They
run only for a sample from [the samples index](#the-samples-index), never for an archive from a
file. Sample agent is an agent with no key, acting for the person importing the sample through the
routes an agent's key calls, so each change waits for that person's review. The steps run after the
comments are written and before any document's review mode and lock are set. A step that does not
land, or a change that would not wait for review, fails the import.

A step names a document or row page (`doc`, and a citation's `doc`) or a database (`database`)
by its path in `items`.

- `{kind: "edit", doc, edits: [{old_string, new_string}], citations?: [{n, doc, heading_path?, content}]}`:
  a cited edit to a document or row page, proposed for review. Each `old_string` occurs once in the
  body as the earlier steps' edits leave it, and could not occur in a link or image destination as
  an import writes it: a URL of the node, such as `/doc/<id>?table=tbl_<id>&row=row_<id>`, where
  each id is up to 12 random ASCII letters and digits. So in a body with an archive link or image,
  an `old_string` of 12 or fewer such letters and digits alone is refused, as is a part of such a
  URL, like `row`. Neither string holds an archive link or image: a step points to another
  document through `citations`. A `new_string`'s footnote markers are this step's citations: each
  `[^n]` in one has a citation with that `n`, and each citation's `[^n]` is in one. To keep a
  footnote the body has, leave its marker out of the `old_string`. A citation's `content`, 1 to
  1,000 characters, occurs in the cited body, and its `heading_path` is one line of 1 to 500. The
  edit changes the body as Stuga writes it. At least one edit and at most 200, and at most 50
  citations. An `old_string` is 1 to 1,000,000 characters. The `new_string`s add up to at most
  4 MiB, and so does the body the step leaves, as an import writes it.
- `{kind: "row", database, table, row, values}`: a change to at least one of a row's cells, by
  column name and written as in a rows file, proposed for review.
- `{kind: "comment", doc, body, quote?}`: a comment, its `body` as a comment's. `{{me}}` in the
  body becomes the importing person's `@username`, and is the only `{{…}}` it may hold. A `quote`
  occurs once in the document's text.

A sample holds at most 200 steps.

## Caps

| What | Cap |
|---|---|
| The zipped archive | 50 MiB, and within the node's upload limit when uploaded to it |
| All files, unpacked | 256 MiB |
| Files | 20,000 |
| `stuga.json` | 16 MiB |
| A body | 4 MiB of Markdown, and its closing newline |
| A rows file | 64 MiB |
| An image | 50 MiB, and within the node's upload limit |
| Items | 10,000 |
| Row pages | 10,000 |
| Rows, across every table | 500,000 |

A node's upload limit is 10 MB unless an administrator raises it, up to 50 MB, in **Settings → This
node → Storage**.

## Compatibility

Stuga reads version 1, ignores fields it does not know, and refuses an archive of a newer version.

## Checking an archive

From a checkout of stuga, after `pnpm install`:

```sh
node services/node/bin/stuga-node.js archive check <directory> [--json]
```

checks an unzipped archive against this page: the manifest, that every file it names is there and
nothing else is, that each body is Markdown as Stuga writes it (it prints the lines that differ)
and gives its title, every row, every link and image, and every sample step, replayed as an import
proposes it. It holds images to 10 MB, the upload limit every node starts with. Names starting with
a dot are skipped, and a top-level `README.md` that no item uses is allowed. It exits 0 when the
archive passes and 2 when it does not. `--json` writes one object: `{ok, counts, issues: [{at,
message, diff?}]}`.

## The samples index

A samples index lists sample workspaces: archives published as assets of one release of
[stuga-dev/samples](https://github.com/stuga-dev/samples), which carries the index as `index.json`:

| Field | Value |
|---|---|
| `format` | `"stuga-samples"` |
| `version` | `1` |
| `tag` | The release: `vYYYY.MM.DD`, or `vYYYY.MM.DD.N` for another that day. |
| `samples` | Each `{id, title, description, name, langs, file, sha256, bytes, archive_version}`. |

`id` is 1 to 40 of `a-z`, `0-9` and `-`, starting with a letter or digit. `title` is at most 60
characters, `description` 60, and `name`, the new workspace's name, 100. `langs` lists the
languages of its text as primary language tags (`en`, `zh`): 1 to 20, each 2 or 3 lowercase letters
and listed once. `file` is `<id>.stuga.zip`, `sha256` and `bytes` are the file's, and
`archive_version` is the format version it is written in.

Stuga reads the first 100 samples it can import, and leaves out, unread, one written in a newer
`archive_version` or larger than 50 MiB. It also leaves out, and logs, one whose other fields break
these rules, such as a longer description than it takes; only an index whose `format`, `version`,
`tag` or `samples` it cannot read gives no samples.

A node reads the index from `<SAMPLES_URL>/latest/download/index.json`, the newest release
([SAMPLES_URL](configuration.md#network)), at most 256 KiB, and keeps it an hour. When a look fails,
it keeps the index it has but lists no samples until a look works, and looks again a minute later at
the soonest. It downloads a sample from
`<SAMPLES_URL>/download/<tag>/<id>.stuga.zip`, a path it builds from the index's `tag` and `id`, so
the index names no address. The download must have the index's `bytes` and `sha256`, and passes
the same checks as an archive from a file. Its `sample.steps` then run as
[Sample steps](#sample-steps) says.
