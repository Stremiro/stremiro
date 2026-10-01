# Stremiro

A lightweight, addon-driven streaming app for Windows — in the spirit of
Hayase and Nuvio, built entirely on Stremio plugins. Every catalog, metadata
lookup, subtitle, and stream comes from the Stremio addons you install; the
app bundles no content sources of its own.

- **Tauri 2 (Rust)** — addon transport, stream resolution/ranking,
  persistence, and playback coordination
- **React 19 + TypeScript** — the interface
- **libmpv** — playback
- **SQLite + JSON stores** — local state (library, watch progress,
  preferences, lists)

Streams resolve only from addon-supplied direct http(s) sources.

## Development

Requires [Bun](https://bun.sh) and the pinned Rust toolchain
(`rust-toolchain.toml`).

```sh
bun install
bun run tauri dev      # run the app
bun run check          # format + lint + typecheck + clippy
bun run test:rust      # Rust test suite
```

## Building

The app embeds a verified libmpv pair that is not committed to the repo —
place `libmpv-2.dll` and `libmpv-wrapper.dll` in `src-tauri/lib/` (see
`src-tauri/lib/PROVENANCE.txt` for versions and hashes) before packaging.

```powershell
bun run tauri:build            # signed NSIS installer + updater artifacts
bun run tauri:build:unsigned   # unsigned installer (no updater artifacts)
```

Signed builds need the updater private key: `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PATH`, or the default
`%LOCALAPPDATA%\Stremiro\signing\tauri-updater.key` (password via the
matching `TAURI_SIGNING_PRIVATE_KEY_PASSWORD*` env vars or files next to
the key). Releases must always sign with the same key — the updater verifies
signatures against the public key baked into `src-tauri/tauri.conf.json`.

## Releases

```powershell
bun run release:version:set -- 0.5.0   # bump all four version sources
bun run tauri:build                    # build + sign
bun run release:publish                # gh release create + latest.json
```

`release:publish` uploads the installer and updater bundle and generates the
`latest.json` the in-app updater polls at
`github.com/Stremiro/stremiro/releases/latest`. Keep the release a normal
(non-prerelease) latest release or the updater endpoint will not see it.
