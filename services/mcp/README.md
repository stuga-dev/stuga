# @stuga/mcp

Connects an MCP client that starts local servers, such as Claude Code, Codex or Cursor, to your
[Stuga](https://stuga.dev) node. It forwards every call to the node's `/mcp`, so the tools, their
instructions and every permission check are the node's own. It adds one thing only a process on your
computer can do: importing a CSV or JSONL file from a local path into a database.

```json
{
  "mcpServers": {
    "stuga": {
      "command": "npx",
      "args": ["-y", "@stuga/mcp"],
      "env": { "STUGA_URL": "http://192.168.1.50:8787" }
    }
  }
}
```

Set `STUGA_URL` to the address you open Stuga at; without it the server uses
`http://127.0.0.1:8787`. The first time a client uses it, the node's sign-in page opens in your
browser, where you choose the workspaces the client may use and whether it may suggest changes. The
sign-in is kept in `~/.config/stuga/oauth.json`, readable only by you. To send an access key
instead, set `STUGA_TOKEN`.

It talks to your node and nothing else. What the client's model reads and writes is seen by the
client's AI provider.

Settings and details: [docs/agents.md](https://github.com/stuga-dev/stuga/blob/main/docs/agents.md#the-stdio-server).
AGPL-3.0-only; the npm packages bundled into `stuga-mcp.js` are listed in `third-party-licenses.txt`.
