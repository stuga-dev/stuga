# Stuga for Claude

Lets Claude search, read and edit the documents and databases in your own
[Stuga](https://stuga.dev) workspaces. Claude's edits arrive in Stuga as suggestions, shown change by
change, that you accept or reject.

The plugin has two parts: the Stuga skill, which teaches Claude how to work with Stuga, and a
connector that runs on your computer and talks to your Stuga node.

## Use it

You need a running Stuga node, on this computer or one your computer can reach, and Node.js 18 or
newer.

1. Install the plugin. In Claude Code:

   ```
   /plugin marketplace add stuga-dev/stuga-plugin
   /plugin install stuga@stuga
   ```

2. Enter your **Stuga address**, the address you open Stuga at. Keep `http://127.0.0.1:8787` when
   Stuga runs on this computer.
3. The first time Claude uses Stuga, your browser opens Stuga's sign-in page. Choose the workspaces
   Claude may use and whether it may suggest changes.

Then ask, for example:

- "What does our onboarding doc in Stuga say about laptops?"
- "Find everything we wrote about the pricing change and summarize it, with links."
- "Add a row for Acme to the Leads table in Stuga."

The connector runs in Claude Code and in Cowork sessions on your computer. Cowork uses the default
address, `http://127.0.0.1:8787`. In Claude on the web, the plugin brings the skill only; add your
node as a custom connector there when it has a public https address.

## Data

The connector is the npm package [`@stuga/mcp`](https://www.npmjs.com/package/@stuga/mcp), at the
exact version in `.mcp.json`, which `npx` downloads from the npm registry the first time it starts.
Its source is in [services/mcp](https://github.com/stuga-dev/stuga/tree/main/services/mcp).

The connector sends Claude's requests to your Stuga node, at the address you entered, and nowhere
else. It keeps your sign-in in `~/.config/stuga/oauth.json`, readable only by you. What Claude reads
and writes is processed by Anthropic, as with any conversation. Revoke Claude's access at any time
under **Settings → Your own AI → Connected agents** in Stuga.

## License

MIT ([LICENSE](LICENSE)). The connector is part of Stuga, AGPL-3.0-only.

Each Stuga release publishes this plugin to
[stuga-dev/stuga-plugin](https://github.com/stuga-dev/stuga-plugin) from
[integrations/](https://github.com/stuga-dev/stuga/tree/main/integrations) in stuga-dev/stuga, where
its source and issues are.
