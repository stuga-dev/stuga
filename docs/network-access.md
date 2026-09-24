# Network access

A node answers at one address, its `PUBLIC_ORIGIN`. This page covers what each way of reaching a
node protects, how to let other devices in, how to put HTTPS in front of it, and how people and
agents use several nodes. The variables are listed in [Configuration](configuration.md#network).

A Docker node and Stuga.app on a Mac both start on your local network, unless they are set to serve
their own machine only (`HOST_BIND=127.0.0.1`, `--local-only`). Only whoever has the node's setup
code can claim it ([Claiming the node](#claiming-the-node)). The commands for each platform are in
[install/docker.md](install/docker.md#reaching-the-node-from-other-devices) and
[install/macos.md](install/macos.md#network).

## What each way of reaching a node protects

| How people reach the node | Encrypted | Secure context in the browser |
|---|---|---|
| On the same machine, at `http://localhost` or `http://127.0.0.1` | Never leaves the machine | Yes |
| Plain http on a network address | No | No |
| HTTPS: a reverse proxy, `TLS_CERT_DIR`, or Tailscale | Yes | Yes |

Plain http on a network sends passwords, session tokens and documents in cleartext. Anyone who can
see the traffic can read them, including whoever runs the Wi-Fi or the router. The cookie that
authorizes images is sent without `Secure` over plain http, because a browser does not keep a
`Secure` cookie from an http address.

A browser gives an http network address fewer features than `localhost` or HTTPS: copy buttons do
nothing, because the clipboard API needs a secure context. Select the text instead. Sign-in through
an identity provider works over http, because the node runs it, but some providers accept an http
callback only on `localhost`.

The node trusts no network. A request from loopback needs the same credentials as one from anywhere
else, and the same limits apply.

## Claiming the node

The first account created on a node administers it, and needs no invite link. It needs the node's
setup code instead, so a node that others can reach from its first start is still claimed only by
whoever installed it. While nobody has claimed the node, every start logs a link to the setup page
with the code in it, and the node keeps the code in `DATA_DIR/setup-code`. The code stops working
once the node is claimed.

## PUBLIC_ORIGIN and EXTRA_ORIGINS

`PUBLIC_ORIGIN` is the address people type, such as `http://192.168.1.50:8787` or
`https://stuga.example.com`. The node builds every request URL on it, never on the `Host` header.
Invite links, share links, the agent setup in **Settings → Your own AI**, OAuth for agents and the issuer of every
session token all use it. It is also the origin browsers may call the node from, and its host is what
agents call the node until an administrator [names the node](configuration.md#the-nodes-name-and-id).

`EXTRA_ORIGINS` lists further exact origins that browsers may call from, such as
`http://localhost:8787` on the node's own machine. Links still use `PUBLIC_ORIGIN`. Sign-in through
an identity provider is the exception: the provider sends the browser back to the origin the
sign-in started from, `PUBLIC_ORIGIN` or one of these, so it needs a callback for each
([Identity provider](configuration.md#identity-provider)).

A browser that opens the node at one of its own local addresses works too, without that address in
`EXTRA_ORIGINS`, as long as it uses the same http or https as `PUBLIC_ORIGIN`: an IP address,
`localhost`, or a name that resolves only on the network, such as `<name>.local` or
`<name>.home.arpa`. So a phone that cannot resolve `.local` names opens the node by its IP address.
Links it is sent still carry `PUBLIC_ORIGIN`, and sign-in through the identity provider still needs
an origin it knows. A browser at a public name that is neither `PUBLIC_ORIGIN` nor in
`EXTRA_ORIGINS` loads the page and signs in with a password, but cannot save
([Troubleshooting](troubleshooting.md#the-page-loads-but-nothing-saves)): a public name could be a
stranger's pointed at the node.

Changing `PUBLIC_ORIGIN` has consequences:

- Everyone signs in again, because sessions belong to the old address.
- Links created before the change carry the old address. Create invite links after it.
- Agents set up with the old address need the new one. Download the Claude Desktop extension again
  from **Your own AI**, which replaces the installed one, and add Claude Code's server again in place
  of the old one. API keys keep working.
- Agents and the workspace switcher call a node nobody has named by the new host, and the server
  name in agent setups changes with it ([The node's name](configuration.md#the-nodes-name-and-id)).
- An identity provider needs the new callback URL registered, as listed in
  **Settings → This node → Access**.
- Shortcuts to the node that people keep under **Other nodes** on other nodes still carry the old
  address. Each person removes theirs and adds the new one.

Keep the address stable. A network address from DHCP can change, so reserve it on your router.

## HTTPS

A node on a private network works over plain http. Give it TLS to reach it from the internet, and to
get Claude Code's browser sign-in, which refuses to send a credential to a token endpoint that is
neither https nor loopback ([Claude Code](agents.md#claude-code)).

### A reverse proxy

A reverse proxy such as Caddy or nginx terminates TLS and forwards to the node on loopback. Set
`PUBLIC_ORIGIN` to the https address. With Caddy:

```
stuga.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

The proxy must pass WebSocket upgrades on `/ws/` with their query string, and accept request bodies
a little larger than the upload limit in **Settings → This node → Storage**.

The node limits sign-in attempts by client address. Behind a proxy every connection comes from the
proxy, so set `TRUST_PROXY_HEADERS=true` to take the address from `X-Forwarded-For` or `X-Real-IP`
instead. The node reads the last address in `X-Forwarded-For`, the one the proxy in front of it
adds, so anything a client wrote ahead of it is ignored. Caddy sets the header this way by default.
With nginx, use `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` or `$remote_addr`.
Set it only when the proxy is the only way to reach the node, because a client that reaches the
node directly can write any address into those headers.

The node never sends `Strict-Transport-Security`, because that header applies to every port of a
hostname. Send it from the proxy if you want it.

### The node's own TLS

With `TLS_CERT_DIR` set, the node serves https itself and no plain http. It picks the certificate
by the name the client asks for, from `<TLS_CERT_DIR>/<hostname>/fullchain.pem` and `privkey.pem`,
and uses the certificate for `PUBLIC_ORIGIN`'s host when a client names none. It reads renewed
certificates when the files change. Set `PUBLIC_ORIGIN` to the https address.

### Tailscale

If you already use Tailscale, it can give the node an https address inside your tailnet. Enable
HTTPS certificates for the tailnet, then on the node's machine:

```sh
tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:8787
```

Set `PUBLIC_ORIGIN` to `https://<machine>.<tailnet>.ts.net`: on a Mac, in the node's definition
([install/macos.md](install/macos.md#where-things-live)), or, for a build from a checkout, by
rebuilding with that address as `--origin`. Keep the node's local address in `EXTRA_ORIGINS` so it
still works on the machine itself.

Use `--tls-terminated-tcp`. The HTTPS proxy mode of `tailscale serve` can drop the query string of a
WebSocket upgrade, which carries the ticket every document connection needs. The same applies to
`tailscale funnel`, which makes the node reachable from the whole internet. Check the flags against
`tailscale serve --help` for your version.

Every connection then arrives from the machine itself, so leave `TRUST_PROXY_HEADERS` off. Sign-in
attempts from all devices count against one limit.

## Several nodes

Nodes never talk to each other. Each has its own address, accounts and sign-in, and a session on one
is not a session on another, even for the same person.

Each person keeps shortcuts to other nodes in the workspace switcher. The first is added with
**Add another node…**; from then on the switcher lists them under **Other nodes**, heads this node's
workspaces with its name, and changes them with **Add or remove nodes…**. A shortcut is a label and an address, kept on the node
where it was added, for that person alone: nothing checks that the address is a Stuga node, and the
other node learns nothing. Opening one loads that address in the same tab, and that node asks you to
sign in unless you already have. API keys cannot read or change shortcuts.

An agent that works with several nodes connects to each as its own MCP server
([Agents](agents.md#one-connection-and-which-node-a-call-lands-on)).

## Headers

Every response carries `X-Frame-Options: DENY`, so nothing the node serves can be embedded in
another page, as well as `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
Responses also carry `Content-Security-Policy: frame-ancestors 'none'`, except images, which get
`default-src 'none'; sandbox`.
