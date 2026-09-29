# Remote access

Remote access gives a node its own public https address, `https://<id>.<zone>`, so people and hosted
agents reach it from anywhere without a VPN or an open port. It is optional and off by default. It
appears only where the packaging names a remote access service and a directory the node shares with
its connector ([Configuration](#configuration)); without both, the node has no second listener and
connects to nothing new.

TLS ends on the node. The node generates the certificate's private key, gets the certificate itself
and keeps both. A relay in between forwards each connection by the name it asks for (SNI) and passes
the encrypted bytes along without reading them. The relay sees each visitor's IP address, the address
they opened, and when and how much passed, never what they read or write.

This page lists everything the node sends and receives, the files it keeps, and how the remote
address behaves.

## Turning it on

In **Settings → This node → Remote access**, a node administrator enters the one-time code the
remote access service gave them, accepts the Let's Encrypt Subscriber Agreement, and chooses
**Turn on**. The node then:

1. makes its binding key, an Ed25519 key pair, writes it to disk, and sends the public key with the
   code to the service, which answers with the node's address;
2. checks in and gets the list of relays and the certificate authority to use;
3. gets a certificate for its address from Let's Encrypt ([Certificates](#certificates));
4. gets a short-lived relay credential, and writes the connector's files;
5. listens for the relay on a unix socket, and checks that its address reaches it.

The page says what it is waiting on until the address works. The Mac package downloads and starts
the connector by itself ([The connector](#the-connector)); elsewhere the page shows the command that
starts it ([Running the connector yourself](#running-the-connector-yourself)).

**Turn off** closes the remote listener at once, deletes the connector's credential, settings and
relay certificate, asks the packaging to stop the connector where it runs it, and stops calling the
service. The node keeps its address, its keys and its
certificate, so turning it on again needs no code. The service is not told; the relay drops the
connector within a few minutes, once it stops presenting a credential.

## What the node sends to the service

Every request is a `POST` of a compact JWS (`content-type: application/jose`) signed with the
binding key. Its protected header is `{"alg":"EdDSA","typ":"stuga-node+jwt"}` plus `kid`, the key's
RFC 7638 thumbprint, or, on the first two endpoints, `jwk`, the public key itself. Every payload
carries:

| Field | |
|---|---|
| `pv` | The protocol version, `1`. Not Stuga's version. |
| `aud` | The endpoint's full URL. |
| `iat`, `exp` | The node's clock, and 60 seconds later. |
| `iss` | The node's `<id>`, on every endpoint but the first two. |

Beyond those, each endpoint takes only this:

| Endpoint | When | What it adds |
|---|---|---|
| `/v1/enroll` | Turning on with a code, first time | The public key (in the header) and the one-time code. |
| `/v1/rebind` | Turning on with a restore code | A new public key (in the header) and the one-time code. |
| `/v1/checkin` | At start, when turned on, before each new credential, and when the service asks | Nothing: identity and time only. The service sees the IP address it comes from. |
| `/v1/acme/txt` | During each certificate order | The DNS-01 challenge value, 43 characters. The service publishes it as a temporary TXT record at `_acme-challenge.<id>.<zone>`; the node cannot name any other record. |
| `/v1/acme/txt/cleanup` | At the end of each order, whatever its outcome | Nothing. The service deletes that record. |
| `/v1/relay-credential` | When the credential is a quarter through its life, or must be replaced sooner | The certificate the node serves, which is public anyway, and its private key's signature over a one-time nonce from the last check-in, proving the node holds it. |

The node never sends the service its private keys, documents or any other data, accounts, settings,
its computer's name, or Stuga's version. The HTTP headers are Node.js's defaults, with no version in
them. The node's first request goes to `STUGA_REMOTE_SERVICE`; every later one goes to the address
the service's last answer named.

## What the node receives

- **Its address:** the `<id>`, the hostname `<id>.<zone>` and the zone.
- **Where to call next:** the service's address, and when to check in again (between 5 minutes and
  a day away).
- **Relays:** for each, a name, its address and port, the name on its certificate, and its
  self-signed certificate, which the connector pins.
- **The certificate authority:** its ACME directory, and a date before which a certificate must be
  replaced (unset unless the operator needs every certificate reissued).
- **A relay credential:** an EdDSA-signed JWT with the claims `iss`, `sub` (the `<id>`), `aud`
  (`relay`), `iat` and `exp`, and when to renew it. The node writes it for the connector, which
  presents it to the relay when it connects and at every heartbeat.

A refusal is `{"error": "<code>", "message": "…", "server_time": <unix seconds>}`, with `retry_after`
on a `429` or `503`. The node never deletes its binding key because of a refusal: a key the service
stops accepting is retried for a day before the Settings page asks for a restore code, and a denied
address checks in hourly and comes back by itself once the service lifts the denial.

## Files

Under `DATA_DIR`, readable by the node alone, and in its [backups](operations.md#backups):

| Path | What | Mode |
|---|---|---|
| `secrets/remote-binding.jwk` | The binding key, Ed25519. | `0600` |
| `secrets/remote-binding.pending.jwk` | A binding key being enrolled; it replaces the one above once the service accepts it. | `0600` |
| `secrets/remote-binding.retired-<unix>.jwk` | A binding key that was replaced. The node never deletes one. | `0600` |
| `secrets/remote-acme-<hash>.jwk` | The ACME account key for one certificate authority directory, P-256. | `0600` |
| `remote/certificate.pem` | The certificate's private key, followed by its chain, in one file so both change together. | `0600`, in a `0700` directory |

Under `STUGA_REMOTE_DIR`, written by the node and read by the connector:

| Path | What | Mode |
|---|---|---|
| the directory | Created by the node if missing. It must belong to the node's user, and neither its group nor anyone else may write to it. | `0750` |
| `<relay>.toml` | The connector's settings for that relay. | `0640` |
| `<relay>.jwt` | The relay credential, one line, replaced whole. | `0640` |
| `<relay>.ca.pem` | The relay's certificate. | `0640` |
| `https.sock` | The remote listener's socket. Its path must be at most 103 bytes. | `0660` |

The directory's group can read the relay credential and connect to the socket, which takes the
visitor address each connection names. Give the directory a group that only the node's and the
connector's users are in: on macOS a user's default group, `staff`, holds every local user. On
Linux, also set the directory's setgid bit (`chmod g+s`) so the files in it take that group.

The Mac package creates it as `/Library/Application Support/Stuga/remote`, owned by `_stuga`, the
node's account, with the group `_stugaremote`, `0750`. `_stugaremote` is the connector's own account
and the only member of its group: it reads the connector's files and reaches the socket, and nothing
of the node's data. New files in the directory take its group.

## The connector

The connector is the upstream frp client, `frpc`, unchanged. The node writes its settings; the
connector keeps a connection open to the relay and hands each visitor's connection to the node's
socket, still encrypted. It never holds the node's private keys and cannot read what it passes on:
all it has is the short-lived relay credential.

Where the packaging runs the connector, the node never starts it. It writes what it wants to
`STUGA_CONNECTOR_REQUEST`, one line, `on <sha-256 of the connector's settings>` or `off`, and reads
what the packaging did from `STUGA_CONNECTOR_STATUS`. It asks for `on` once it has a certificate that
serves its address and a credential in the connector's files, and for `off` when turned off or when
the certificate stops serving the address. It asks again at every start, and after 1, 5, 15 and
then every 60 minutes while the packaging reports something else. A connector the packaging refused
waits for an administrator to choose **Retry** in Settings, and one this installation doesn't include
is not asked for again until the node restarts.

The packaging writes a fresh status, with `at`, after every pass over the request, even one that
changes nothing: the node takes a status stamped before it last changed the line, to the second, as
no answer yet. An `installing` status not refreshed within 15 minutes counts as abandoned, and the
node asks again.

On a Mac:

- The connector is built from frp's source at a fixed commit, signed and notarized as
  `dev.stuga.remote`, and published with each Stuga release. The package does not carry it: its
  helper downloads it when an administrator first turns remote access on, and again after each Stuga
  update, and installs it only when its sha-256 matches the one the package carries and its
  signature is Stuga's.
- It runs as its own account, `_stugaremote`, under the LaunchDaemon `dev.stuga.remote`, and no other
  account but root can run it. Before starting it, the job copies each settings file and refuses to
  start on anything but the lines the node writes.
- It restarts only when its settings or the connector itself change. A new credential does not
  restart it, so remote connections stay open.
- It logs warnings only.

Its settings name one https proxy for the node's own hostname onto the socket, and nothing else: no
`exec` source, no included files, no admin interface, no `user` or metadata. The node rewrites them
when the relays change, and removes the files of a relay that is no longer listed.

At every login the connector sends the relay its computer's name, operating system, processor type
and its own version. That is frp's behaviour and cannot be turned off. The relay erases the first
three as they arrive and records only the version.

## The remote address

The node serves its remote address on a second listener, a unix socket in `STUGA_REMOTE_DIR`, apart
from the one on `BIND` and `PORT`. The relay reaches it through the connector.

- **Its own origin.** Every request there is served on the remote address. Browsers may call it only
  from pages at that address, and pages at `PUBLIC_ORIGIN` or `EXTRA_ORIGINS` never can.
- **Visitors' addresses** come from the PROXY protocol header the relay adds, never from
  `X-Forwarded-For` or `X-Real-IP`. Sign-in limits count remote visitors apart from the network's,
  and an IPv6 visitor by its `/64`. Each source may hold 32 connections at once, and must send its
  request headers within 10 seconds.
- **A sign-in of its own.** Browsers keep sessions per origin, so people sign in once at the remote
  address. Sessions on the network are unaffected, and turning remote access on or off signs nobody
  out.
- **No setup.** The node cannot be claimed there: its setup code works only on the network. Invite
  links work.
- **HSTS.** Every answer carries `Strict-Transport-Security: max-age=31536000`, without
  `includeSubDomains`. The network address never sends it.
- **Links follow the address.** Links the node hands back, such as invite, share and reset links and
  agents' endpoints, carry the remote address when asked there. Links it sends by itself, in
  notifications for example, carry `PUBLIC_ORIGIN`.
- **Agents** that connect there sign in there, and the resource they name is `<remote address>/mcp`.
  **Your AI agents** gives hosted clients, such as Claude on the web, the remote address while it is on
  ([Agents](agents.md#claude-on-the-web)).

`PUBLIC_ORIGIN` cannot be the remote address. The identity provider needs the remote address's
callback registered too; **Settings → This node → Access** lists it
([Identity provider](configuration.md#identity-provider)).

Every 10 minutes, and soon after its first credential and each new certificate, the node opens its
own address through the relay and compares the certificate it gets with its own. It sends no request over that
connection. A different certificate is shown as a problem in Settings. Where the packaging runs the
connector, the first check waits until the packaging reports it running the current settings, and
follows within seconds.

## Certificates

The certificate comes from Let's Encrypt over ACME, with the DNS-01 challenge: the node asks the
service to publish the challenge's TXT record, checks the zone's authoritative name servers until
all of them show it, and deletes it when the order ends. Where the network blocks DNS queries to
those servers, or answers them itself as some routers do, the node waits 20 seconds instead. The
node makes a new P-256 key for each certificate and never sends a private key anywhere; its ACME
account carries no email address.

Turning remote access on accepts the Let's Encrypt Subscriber Agreement, and the node records who
accepted it and when. Every certificate is published in the public Certificate
Transparency logs, so the address becomes public as soon as the first one is issued.

The node renews a certificate when the CA suggests, through its renewal information
([RFC 9773](https://www.rfc-editor.org/rfc/rfc9773)): at a time drawn from the CA's window, asked
again as often as the CA says (between an hour and a day), and at once when the window has passed,
as after a revocation. The order names the certificate it replaces; a CA that refuses that gets the
order again without it. Where the CA gives no window, or one that runs past the certificate's expiry,
the node renews at about two thirds of the lifetime. It reissues a certificate only on its own evidence: the file is missing or unreadable, the
key does not match, the certificate names another address, renewal is due, or the service asks every
certificate issued before a date to be replaced. The service refusing a certificate is not such
evidence.

Every node administrator is notified, in the app and through the
[notification sink](configuration.md#settings-in-the-app) when one is set: when renewing fails three
times in a row or waits for someone; when less than a tenth of the certificate's life is left, or it
has expired, and renewing it has failed or can't be tried (a node back from a long sleep renews
first); and when a new one is in use after any of these; also when the service has refused
the node's key for a day, or the key is missing or can't be read. Each is sent once, and only while
remote access is on.

A certificate that has expired, or no longer names the address, takes the tunnel down: the node
closes the remote listener, asks for the connector `off` and deletes the relay credential. Once a new
certificate is in place it gets a new credential, and only then asks for the connector again.

## Turning off, restoring and backups

- **Turning off** keeps the address ([above](#turning-it-on)).
- **A new machine, or a lost data directory:** ask the service's operator for a restore code, and
  enter it in **Settings → This node → Remote access**. The node enrolls a new key for the same
  address, and the old key stops working. A bound node also takes a code under
  **Use a different code**.
- **Backups** include the binding key, so a restored node keeps its address. A backup restored on a
  second machine while the first still runs gives both the same address; whichever connects to the
  relay first gets the traffic.

## Configuration

The packaging sets both, or neither ([packaging/contract.md](../packaging/contract.md#packaging-hints)).
With only one set, the node logs a warning and offers no remote access. The connector's pair, too,
is both or neither, and counts only beside the first two; with one of them, the node logs a warning
and takes it that nobody but the administrator runs the connector.

| Variable | Default | |
|---|---|---|
| `STUGA_REMOTE_SERVICE` | unset: no remote access | The remote access service, an https origin (http only on loopback, for tests), used for the first enrollment only. Afterwards the node calls the address the service names. |
| `STUGA_REMOTE_DIR` | unset: no remote access | The directory the node shares with the connector, as an absolute path. |
| `STUGA_CONNECTOR_REQUEST` | unset: the administrator runs the connector | The file the node writes `on <sha-256>` or `off` to, as an absolute path, replaced whole. |
| `STUGA_CONNECTOR_STATUS` | unset: the administrator runs the connector | The JSON file the packaging reports in, as an absolute path: `state` (`installing`, `running`, `stopped`, `refused`, `failed` or `unavailable`), `message`, `at` (ISO 8601, written afresh after every pass over the request), and `connector_sha` and `config_sha`, the sha-256 of the connector and of the settings it runs. A status stamped before the node last changed its request is no answer to it; `installing` not refreshed within 15 minutes is abandoned. |

## Running the connector yourself

For now only the Mac package offers remote access. For development, and in the Mac's local trial
([Build from a checkout](install/macos.md#build-from-a-checkout)), run the connector as the node's
user, with frp 0.71.0:

```sh
frpc -c <STUGA_REMOTE_DIR>/<relay>.toml
```

**Settings → This node → Remote access** shows the exact command. The connector reads its
credential again at every heartbeat, so a new one needs no restart; changed settings do, and the
page says when they changed.

## Admin API

For node administrators; agents are refused. Times are ISO 8601.

| Route | |
|---|---|
| `GET /api/node/remote-access` | `{ "available": false }` where the packaging offers none. Otherwise `available`, `enabled`, `state` (`off`, `starting`, `on`, `degraded`, `denied` or `error`), `address`, `certificate` (`expires_at`, `renew_at`), `credential` (`expires_at`), `connector` (`managed`, `status`, `config_path`, `config_changed_at`, `reachable`, `checked_at`), `ca_terms` (`accepted_by`, `accepted_at`, `url`) and `last_error` (`code`, `message`, `at`, and `retry_at`, `service_code` and `reason` when they apply). Where the packaging runs the connector, `managed` is true, `status` is what it last reported, and `config_path` is null. |
| `POST /api/node/remote-access/enable` | `{ "code"?, "accept_ca_terms": true }`. A node with no address needs a code; with one, a code restores or replaces it. Waits up to 25 seconds for the service, then answers like the `GET`, usually `starting`. A refusal is `{ "error", "code" }`. |
| `POST /api/node/remote-access/disable` | Turns it off and answers like the `GET`. |
| `POST /api/node/remote-access/connector/retry` | Where the packaging runs the connector, asks for it again after a refusal, and answers like the `GET`. Refused with `409` elsewhere. |

Four errors are worked out from the state rather than kept, so they go when their cause does:
`connector_refused` (an error, with the packaging's reason, until **Retry**), `connector_unavailable`
(an error: this installation has no connector), `certificate_expired` (degraded) and
`connector_failed` (degraded, with the packaging's reason, or because the connector still isn't
running what the node asked for after it asked again, and `retry_at`, when the node asks again). An
error that needs an administrator comes first, then these in that order, then the one kept; while
the certificate is expired, a kept certificate error says why renewal is stuck and comes before
`certificate_expired`.

Each of these actions is in the node's audit log, without the code.
