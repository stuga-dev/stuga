---
name: stuga
description: Use whenever the user mentions Stuga or a Stuga workspace, asks whether Stuga is accessible, or wants to find, search, read, summarize, create, or edit documents, notes, folders, databases, collections, or knowledge stored in Stuga. Do not use for a local coding workspace unless the user means Stuga.
---

# Stuga

Treat a Stuga workspace as an external collaborative knowledge service, not as a directory on disk. Never read "Stuga workspace" as a local folder path or look for it on the filesystem.

Before saying that Stuga is unavailable or asking for a local path:

1. Discover the configured MCP server named `stuga`. Do not use differently named MCP servers.
2. Call its `workspaces` tool with `action: list`. For an access question, report the returned node and workspaces.

For document discovery, use `docs` with `action: list` or `action: search`. Use `retrieve` when answering a question from content across documents, and `markdown` with `action: read` when the exact document is known. Follow the server and item instructions returned by Stuga.

If several Stuga servers or workspaces match and the request does not identify one, ask which one to use. Only report that no Stuga connection is available after searching the available MCP tools and finding no configured Stuga server.
