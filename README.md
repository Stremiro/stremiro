
<p align="center">
  <img
    src="https://github.com/user-attachments/assets/5de94e39-880b-430a-afaf-e6eb3b506fcd"
    width="800"
    alt="Stremiro banner"
  />
</p>


<h1 align="center">⛩️ Iroh / Stremiro</h1>

<p align="center">
  <strong>Your addons. Your library. Your way.</strong><br />
  A streaming client for Windows with a lean Rust core and a custom mpv player.
</p>

<p align="center">
  <a href="https://github.com/Stremiro/stremiro/releases/latest"><strong>Download for Windows</strong></a>
</p>

## 🌿 Features

- 🧩 **Addon extensibility** · Bring your Stremio-compatible catalog, metadata, stream
  and subtitle addons. Requests follow each addon's manifest.
- 📗 **Library & lists** · Create lists, manage watch statuses and track hours watched.
  Resume where you left off with saved playback progress.
- 📺 **mpv player** · Custom controls, a mini player, in-player episode navigation,
  audio and subtitle selection, and SkipDB skip markers where available.
- 🔎 **Browse & search** · Discover titles with Stremio's Cinemeta by default,
  genre filters and catalogs from your addons.
- 🗓️ **Release calendar** · Keep up with new episodes and movie release dates
  for titles in your library.
- 🎨 **Make it yours** · Customize accent colors, library layouts, subtitle styling
  and playback preferences.

## 🛑 Disclaimer

> Iroh / Stremiro does not host media or bundle unofficial content sources.
> Third-party addons are independently maintained and are not endorsed by this project.
> You are responsible for the addons you install, the sources you access and compliance
> with applicable laws.

## ⚙️ Project notes

**Built with** · Rust · Tauri 2 · React 19 · TypeScript · Tailwind CSS 4 · libmpv · SQLite.
Library data, watch progress and preferences are stored locally.

**No torrenting, by design.** Playback uses addon-provided HTTP(S) streams.
Torrenting and peer-to-peer playback are not supported or planned, keeping the app
and player lean while reducing misuse and networking complexity.

## 🛠️ Development

<details>
<summary>Setup, builds & releases</summary>

Requires Windows, [Bun](https://bun.sh) (version in `.bun-version`) and the pinned
Rust toolchain (`rust-toolchain.toml`).

Place `libmpv-2.dll` and `libmpv-wrapper.dll` in `src-tauri/lib/`; these binaries
are not committed. See [`PROVENANCE.txt`](src-tauri/lib/PROVENANCE.txt) for versions
and hashes. Packaging checks that staged and development copies match, but upstream
provenance has not been independently verified.

```powershell
bun install
bun run tauri dev             # run the app
bun run check                 # formatting, lint, types, UI tests, version checks & Clippy
bun run test:rust             # Rust tests
bun run build                 # frontend production build
bun run tauri:build           # signed NSIS installer + updater artifacts
bun run tauri:build:unsigned  # unsigned installer, no updater artifacts
```

The Rust libmpv plugin includes a local 0.3.2 safety patch; see its
[`PATCHES.md`](src-tauri/vendor/tauri-plugin-libmpv/PATCHES.md).
The JavaScript package and native DLL ABI remain 0.3.2.

**Signing.** Set `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`,
or use `%LOCALAPPDATA%\Stremiro\signing\tauri-updater.key`. Passwords use the matching
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD*` variables or files next to the key.
Always sign releases with the same key: the updater checks the public key in
`src-tauri/tauri.conf.json`.

**Releasing.** Run `bun run release:version:set -- <version>` to update all four
version sources, then `bun run tauri:build` and `bun run release:publish`.
Publishing uploads the installer, updater bundle and generated `latest.json`.
The in-app updater uses `github.com/Stremiro/stremiro/releases/latest`, so releases
must be marked latest and must not be prereleases.

</details>
