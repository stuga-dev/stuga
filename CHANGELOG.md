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
- An edit made within five minutes of the last version, with no edit after it, never became a
  version. It now becomes one once the five minutes pass, or when someone leaves the document.
- An edit that only changed formatting, such as making text bold, never became a version.
- A version named only the people who edited in its last half minute. It now names everyone who
  edited since the version before it.
- Restoring a version lost the edits made since the last version, including ones not yet saved. The
  document as it was before the restore is now kept as a version, so a restore can be undone.
- The Versions panel called the newest version **Current** even when the document had changed since,
  and did not show new versions until it was reopened.
- A version's added and removed character counts included lines that had not changed.
- Restore and Delete showed for people who cannot use them, and the error named only the owner.
- Clicking at the end of a line where a collaborator's cursor sat put your cursor at the start of the
  line, so what you typed landed before their text. Double-clicking a word their cursor sat in could
  select only part of it, and clicking their cursor's flag did nothing; it now puts your cursor there.
- A backup that paused a document while someone had unsaved edits logged errors, could list a version
  the document did not keep, and lost the last edits of someone who closed the document meanwhile.

## [0.1.1] - 2026-09-24

### Fixed

- The one-step Docker install (`curl … | bash`) stopped after "Stuga is running" without printing
  the link that creates the administrator account. On a node installed with 0.1.0, `./stuga status`
  prints that link.

## [0.1.0] - 2026-09-24

The first release.
