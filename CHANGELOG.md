# Changelog

All notable changes to the TVault Obsidian plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-19

Compliance release: addresses the Obsidian community-plugin review. No
user-facing feature changes since 0.1.0.

### Changed

- Read the config folder from `Vault#configDir` instead of assuming
  `.obsidian`, so a renamed config folder is respected everywhere.
- The release now ships a build-provenance attestation for `main.js`,
  `manifest.json`, and `styles.css`.

### Fixed

- `onunload` no longer detaches the panel leaf, so the panel keeps the
  position the user gave it across plugin reloads.
- Settings no longer render a heading that repeats the plugin name.
- Use Obsidian's `createEl` helpers and `window.setTimeout` /
  `window.clearTimeout` for pop-out-window compatibility.
- Command IDs and names no longer repeat the plugin id / name.
- Dropped the `builtin-modules` dev dependency in favour of Node's
  `module.builtinModules`.

## [0.1.0] — 2026-07-19

First release. TVault turns an Obsidian vault into a lockable encrypted safe:
**Lock** compresses and encrypts your notes into a `tvault-core` container and
removes the plaintext; **Unlock** restores them. The `.obsidian` config (and this
plugin) is always preserved.

### Added

- **Lock / unlock from a side panel.** A shield-icon panel — and command-palette
  commands — show the current state and one primary action: lock when unlocked,
  unlock when locked, plus a lock-and-close command.
- **Three ways to protect a vault.** Shamir shares (N-of-M), a single master
  token, or a passphrase, chosen when the container is first created.
- **Optional HMAC token integrity.** Protect the tokens with an integrity
  passphrase that is required to unlock.
- **Draw-to-gather-entropy key.** For share/master vaults the container key is
  generated from 256-bit system entropy, optionally mixed with randomness you
  draw in.
- **Token handling.** Save generated tokens to a file, copy each Shamir share
  individually (or all at once), and enter shares one field per share — pasting a
  whole `{"token_list": […]}` blob auto-splits it across the fields. A native
  picker points at an existing token file.
- **Hold keys for the session.** After you unlock or lock, the tokens and
  integrity passphrase are kept in memory — never on disk, cleared when Obsidian
  closes — so re-locking or unlocking again doesn't re-prompt. Toggle in
  settings; "forget keys" in the panel.
- **Container details.** A collapsible panel showing what the container reports:
  created / last re-lock, file count, encrypted vs. original size, security
  score, token type, shares/threshold, comment, tags and format version.
- **Interrupted-lock recovery.** If a lock is interrupted, notes staged for
  packing are detected and restored on next load — plaintext is never lost.

### Security

- Passphrases and pasted tokens are never written to disk.
- The `tvault-core` binary is launched directly, without a shell.
- The encrypted container and key file are kept outside the note area.
- On first use the plugin downloads the pinned `tvault-core` binary
  (`namelesscorp/tvault-core@v1.1.0`) for your platform and **verifies it against
  a SHA-256 checksum embedded in `main.js`** before running it; a mismatch aborts.
  You can also point the plugin at your own build in settings.

### Requirements

- Desktop only — the plugin runs a native binary.
- Obsidian 1.7.2 or newer.

[0.2.0]: https://github.com/namelesscorp/tvault-obsidian-plugin/releases/tag/0.2.0
[0.1.0]: https://github.com/namelesscorp/tvault-obsidian-plugin/releases/tag/0.1.0
