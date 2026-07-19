# Publishing TrustVault to the Obsidian community plugins

## 1. Release artifacts

- **CLI binaries** — in the `namelesscorp/tvault-core` repo push a tag `v1.1.0`
  (must equal `cli.json.version`). The `Release CLI binaries` workflow publishes
  `tvault-core-<os>-<arch>[.exe]` + `checksums.txt`.
- **Plugin** — in the plugin repo push a tag `0.1.0` (must equal
  `manifest.json.version`, no leading `v`). The `Release plugin` workflow
  publishes `main.js`, `manifest.json`, `styles.css` (with build provenance
  attestation).

Before tagging the plugin, make sure `cli-checksums.json` was regenerated for the
released CLI version (`npm run build:cli`) and committed, so the checksums baked
into `main.js` match the published binaries.

## 2. community-plugins.json entry

Fork `obsidianmd/obsidian-releases`, append this object to the array in
`community-plugins.json` (keep the file valid JSON — add a comma after the
previous entry), then open a PR:

```json
{
  "id": "tvault",
  "name": "TrustVault",
  "author": "Nameless Corp",
  "description": "Lock your notes into an encrypted container and unlock them again, powered by the tvault-core CLI.",
  "repo": "namelesscorp/tvault-obsidian-plugin"
}
```

`repo` must be the plugin's own GitHub repository (adjust the owner/name to match
what you actually create). `id` must equal `manifest.json.id` (`tvault`).

## 3. Pre-submission checklist

- [ ] Plugin repo has `manifest.json` at its root, matching the release.
- [ ] A GitHub release named exactly `0.1.0` (no `v`) contains `main.js`,
      `manifest.json`, and `styles.css` as individual assets.
- [ ] `manifest.json` `id` is `tvault` (unique, no "obsidian"/"plugin" in it).
- [ ] `manifest.json` `minAppVersion` (`1.7.2`) matches `versions.json`'s value
      for `0.1.0`.
- [ ] `isDesktopOnly` is `true` (the plugin runs a native binary).
- [ ] LICENSE present (MIT).
- [ ] README explains what the plugin does and how the CLI binary is obtained.

## 4. Draft PR

**Title:** `Add plugin: TrustVault`

**Body:**

> ### TrustVault
>
> Turns an Obsidian vault into a lockable encrypted safe. **Lock** compresses and
> encrypts your notes into a `tvault-core` container and removes the plaintext;
> **Unlock** restores them. Supports Shamir shares, a single master token, or a
> passphrase, with optional HMAC token integrity and a draw-to-gather-entropy key.
>
> **Repo:** `namelesscorp/tvault-obsidian-plugin`
> **Desktop only:** yes — the plugin drives the native `tvault-core` CLI.
>
> #### Note on the native binary (for reviewers)
>
> The plugin package contains only `main.js`, `manifest.json`, and `styles.css`.
> On first use it downloads the `tvault-core` binary for the user's platform from
> a pinned GitHub release (`namelesscorp/tvault-core@v1.1.0`) and **verifies it
> against a SHA-256 checksum embedded in `main.js`** before running it; a
> mismatch aborts. The download location and expected checksums are fixed at
> build time (`cli.json` / `cli-checksums.json`), not fetched dynamically. Users
> can also point the plugin at their own `tvault-core` build in settings.
>
> The plugin never persists passphrases or pasted tokens, launches the binary
> directly without a shell, and keeps the encrypted container and key file
> outside the note area.
>
> - [x] I have read and followed the plugin guidelines and developer policies.
> - [x] The release assets and `manifest.json` match this submission.
