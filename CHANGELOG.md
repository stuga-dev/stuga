# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. The release workflow reads this file ([RELEASING.md](RELEASING.md#the-changelog)): an entry
becomes its version's release notes, and its date and whether it has a **Security** section are what
a running node learns about the version.

An entry's **Upgrade notes** section says what someone running a node has to decide or do. Without
one, the release notes say there is nothing to do.

## [Unreleased]

### Changed

- The setup link, invite links and share links stay in the address bar, so they can be copied from
  there. Opened signed out, an invite or share link shows sign-in at its own address instead of
  moving to `/login`.

### Fixed

- A document or folder an agent created stayed private to the person it acted for, whatever the
  workspace's default access, so other members could not see it until that person shared it. It now
  gets the default, like one the person creates. Items made before this release keep their sharing.
- A Markdown body an agent sent with `POST /api/docs` landed at once. It is now proposed and waits
  for review, like the agent's other writes.
- Signing in with a password went to the library instead of the page that sent you to sign in, such
  as an invite link or a document.

## [0.1.1] - 2026-09-24

### Fixed

- The one-step Docker install (`curl … | bash`) stopped after "Stuga is running" without printing
  the link that creates the administrator account. On a node installed with 0.1.0, `./stuga status`
  prints that link.

## [0.1.0] - 2026-09-24

The first release.
