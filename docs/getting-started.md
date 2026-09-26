# Getting started

The first hour with a new node, in order. At the end, people can reach it, an agent can work in it,
and you have restored a backup once.

## 1. Install

Install Stuga on your platform:

- [Docker](install/docker.md), on any machine that runs Docker Compose.
- [macOS](install/macos.md), on a Mac with Apple silicon.

**Check:** on the node's machine, `curl -s http://127.0.0.1:8787/ready` answers `{"ok":true}`. The
node's log has a line like this, which names the address, whether anyone has claimed the node yet,
its identity provider and whether AI is on, and while nobody has, the link that sets it up:

```
[node] listening on http://0.0.0.0:8787 (public origin http://192.168.1.50:8787, unclaimed, identity provider none, ai off)
[node] nobody has set up this node yet. Open http://192.168.1.50:8787/login?setup=7KD2M-X9QPA to create its administrator (setup code 7KD2M-X9QPA).
```

## 2. Claim the node

Open the setup link: the Mac package and `install.sh` open or print it, and the node's log has it. A node nobody has claimed
opens on **Welcome to Stuga**: pick a username and a password and choose **Create administrator
account**. The link carries the node's setup code. Opened at the node's plain address instead, the
page asks for the code. On a Mac, **Set Up Stuga…** in the menu bar opens the page with it filled in,
and **Copy Setup Link** copies that link for another browser;
with Docker, `./stuga status` prints the link. The log shows it too, and the node keeps it in
`DATA_DIR/setup-code` until it is claimed. Only whoever holds the code can claim the node, so it is safe on a network from its first
start.

You sign in with the username; an email is optional, and you can add one later under
**Settings → Profile**. The first account administers the node: it configures AI, appoints other
administrators and recovers accounts. Its password stays a way in even after you add an
[identity provider](configuration.md#identity-provider). From then on an account is created only
with an invite link.

**Check for new versions** on that page is ticked: once a day the node asks GitHub for the list of
releases, says nothing about itself, and tells its administrators when a newer one is out. Untick it
on a node that cannot or should not reach the internet, and the node never asks
([Operations](operations.md#learning-of-a-new-version)). The next page reads the list of samples
from GitHub as well, unless [SAMPLES_URL](configuration.md#network) points the node at a mirror.

**Check:** the node's log says `first account created; it administers this node`.

## 3. Create a workspace

Stuga asks you to **Create your workspace**. Documents, databases, members and permissions all
belong to one workspace, and nothing crosses between workspaces. You can add more later. The
workspace switcher in the top bar lists them, and **Add another node…** there keeps a shortcut to
another Stuga node ([Several nodes](network-access.md#several-nodes)).

**Start with** picks what the workspace holds at first:

- **Empty workspace**.
- A sample, such as **Privacy laws**: a workspace of real, openly licensed material. The node reads
  the list of samples from [github.com/stuga-dev/samples](https://github.com/stuga-dev/samples) when
  the page or dialog opens, keeps it an hour, and downloads the sample you choose when you create the
  workspace. When its last look for the list failed, as it does without internet access, it says
  **Samples need an internet connection**; [SAMPLES_URL](configuration.md#network) points the node at
  a mirror. The new workspace opens at the sample's **Start here** document. **Sample agent**'s
  changes, written in advance, wait for your review in **Review AI edits**, and its comment mentions
  you.
- **From a file**: a `.stuga.zip` exported from Stuga ([Workspace archive](workspace-archive.md)).
  With no name typed, the workspace keeps the one it had.

**Check:** you reach the document list and can create a document.

## 4. Connect AI

AI comes in three ways, each optional and each set up on its own:

- **Your own AI**: Claude, Codex or another agent connects over MCP and brings its own model, so a
  subscription you already have is enough and the node needs no key. It is yours alone: the agent
  acts with your access, and each member connects their own. See [5. Connect an agent](#5-connect-an-agent).
- **Built-in AI** (chat): the co-author, Ask and the table assistant, for every member of the node,
  on the API key you enter (or a local Ollama).
- **Search by meaning** (semantic search): finds text by meaning, not only exact words, for search,
  Ask and agents.

Nothing is sent to any model until you set one up, and documents, collaboration and keyword search
work without any of them, so you can skip this step.

Right after you create the first workspace, Stuga shows all three, each with its own **Set up**, and
**Start using Stuga** when you are done. Later, your own agent is in **Settings → Your own AI**, and
the other two are in **Settings → This node → AI providers**, each set up the same way:

1. Choose **Set up**, then a **Service**, and enter its **API key** unless it is a local server. For a
   local Ollama, choose **Ollama (local)**. The address it fills in is the right one for your platform.
2. Choose a **Model**. The list comes from the service, newest first, which also shows that the key
   works. For search by meaning, choose one that returns the node's vector width, 1024 by default.
3. Click **Connect**.

That turns it on; there is no switch to turn on afterwards. Your own agent, such as Claude
Desktop, needs no **Built-in AI**, since it brings the model; **Search by meaning** still helps it
find text. A chat-only service such as
Anthropic leaves search matching words until search by meaning is set up on another service.

Once either is set up, its switch turns it off and keeps it, and **Remove** forgets it. Offer more
of a provider's models from its **Edit**.

**Check:** **Test** in a provider's **Edit** answers `Answered`. Otherwise it says what went wrong.
[Troubleshooting](troubleshooting.md#ai) covers the usual causes.

## 5. Connect an agent

Open **Settings → Your own AI**, or choose **Set up** under **Your own AI** right after you create
the first workspace. It has a tab for each kind of client, with the setup for this node filled in,
and lists the agents you have connected so far. Each member connects their own. [Agents](agents.md) covers each client, and how
one agent works with several nodes.

Most clients sign in through your browser. The node then asks which of your workspaces the app may
use, and whether it may suggest changes or only read ([Apps that sign in](agents.md#apps-that-sign-in)).
One connection reaches every workspace you tick.

What the client stores is simply **Stuga**, whatever the node is called. Name the node under
**Settings → This node → Branding** anyway: that name is how agents are told which node a call lands
on, and how each workspace is labelled when you have more than one node
([One connection](agents.md#one-connection-and-which-node-a-call-lands-on)).

An agent never changes a document silently. Its edits wait for review, you are notified, and
**Review AI edits** in the sidebar lists everything waiting. To let agents change one document or
database at once, open it and choose **Let agents apply changes at once** from the **⋯** menu
beside **Share**. Those changes are still recorded, attributed and revertible.

**Check:** ask the agent to propose an edit, and accept it in the document.

## 6. Invite people

Other devices can reach the node only once it listens on the network and its address is right.
[Network access](network-access.md) covers that, and what plain http on a network exposes.

Then open **Settings → This workspace → Members**. **Add people** adds someone who already has
an account on this node: type part of their username or name and pick them from the list. For
anyone else, **Create link** makes an invite link: it is the only way to get a new account on the
node. Choose the role they join as, how many times the link can be used (once, 5, 10 or 25 times, or
no limit), and whether it expires after 1, 7 or 30 days or never. An admin link can be used once. **Invite links** lists every link that still works, with how often it was used, and
revokes one when it should stop. Invite links carry the node's address, so create them after any
change to it.

If people should sign in with an organization's accounts, add its identity provider in
**Settings → This node → Access** before you invite them. Whoever opens an invite link can then
choose **Continue with** the provider instead of a password
([Identity provider](configuration.md#identity-provider)).

**Check:** someone opens the invite link on their own device, creates an account and sees the
workspace.

## 7. Back up, and restore once

Take a backup, then restore it, while nothing is at stake:

- Docker: `./stuga backup`, then `./stuga restore <backup>`.
- macOS: **Back up now** under **Settings → This node → Backups**, then stop the node and run
  `stuga-node restore <backup>`, as [install/macos.md](install/macos.md#stuga-node-commands) shows.

A restore keeps what it replaced, so the drill loses nothing. [Operations](operations.md) describes
backups and restores in full, including why a backup is secret.

**Check:** the document you created in step 3 is still there.

## Next

- [Configuration](configuration.md): every environment variable, and what Settings holds.
- [Operations](operations.md): backups, restores, upgrades and account recovery.
- [Troubleshooting](troubleshooting.md): starts from what you see.
