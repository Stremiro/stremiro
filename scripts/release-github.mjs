// Generates the `latest.json` updater manifest from the built NSIS bundle
// and publishes it to GitHub Releases. The updater endpoint in
// tauri.conf.json polls `<repo>/releases/latest/download/latest.json`, so a
// release is only visible to clients while it is the repo's latest
// *non-prerelease, non-draft* release — never pass --prerelease to gh.
//
//   bun ./scripts/release-github.mjs manifest [--notes <file>]
//   bun ./scripts/release-github.mjs publish  [--notes <file>] [--draft]
//
// `manifest` writes latest.json next to the installer in
// src-tauri/target/release/bundle/nsis. `publish` additionally creates (or
// updates) the GitHub release via the `gh` CLI and uploads the installer,
// its .sig, and latest.json.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const bundleDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const version = tauriConfig.version;
const tag = `v${version}`;

// Owner/repo follows the updater endpoint so a fork or rename needs no
// script change.
const endpoint = tauriConfig.plugins?.updater?.endpoints?.[0] ?? '';
const repoMatch = endpoint.match(
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/,
);
if (!repoMatch) {
  fail(`Cannot derive the releases repo from updater endpoint: ${endpoint}`);
}
const repo = repoMatch[1];

const args = process.argv.slice(2);
const mode = args[0];
const notesFlag = args.indexOf('--notes');
const notesPath = notesFlag >= 0 ? args[notesFlag + 1] : null;
const draft = args.includes('--draft');

if (!['manifest', 'publish'].includes(mode)) {
  fail('Usage: bun ./scripts/release-github.mjs <manifest|publish> [--notes <file>] [--draft]');
}

// The updater downloads the `.nsis.zip` bundle, not the raw installer —
// the .exe ships on the release for manual installs only.
function findInstallerAssets() {
  if (!fs.existsSync(bundleDir)) {
    fail(`No NSIS bundle directory at ${bundleDir} — run bun run tauri:build first.`);
  }
  const entries = fs.readdirSync(bundleDir);
  const updaterBundle = entries.find((name) => /-(?:x64|arm64)-setup\.nsis\.zip$/.test(name));
  if (!updaterBundle) {
    fail(
      `No *-setup.nsis.zip updater bundle in ${bundleDir}. Updater artifacts require a signed build (bun run tauri:build, not :unsigned).`,
    );
  }
  const updaterSignature = `${updaterBundle}.sig`;
  if (!entries.includes(updaterSignature)) {
    fail(`Missing updater signature ${updaterSignature}.`);
  }
  const installer = updaterBundle.replace(/\.nsis\.zip$/, '.exe');
  const platform = updaterBundle.includes('-x64-setup.nsis.zip')
    ? 'windows-x86_64'
    : 'windows-aarch64';
  return { updaterBundle, updaterSignature, installer, platform, entries };
}

function writeManifest() {
  const { updaterBundle, updaterSignature, platform } = findInstallerAssets();
  const signatureText = fs.readFileSync(path.join(bundleDir, updaterSignature), 'utf8').trim();
  if (!signatureText) {
    fail(`Signature file is empty: ${updaterSignature}`);
  }

  const notes =
    notesPath && fs.existsSync(notesPath)
      ? fs.readFileSync(notesPath, 'utf8').trim()
      : `Stremiro ${tag}`;

  const manifest = {
    version: tag,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      [platform]: {
        signature: signatureText,
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(updaterBundle)}`,
      },
    },
  };

  const manifestPath = path.join(bundleDir, 'latest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.relative(rootDir, manifestPath)} for ${tag} (${platform})`);
  return manifestPath;
}

function publishRelease() {
  execFileSync('gh', ['--version'], { stdio: 'ignore' });
  execFileSync('bun', [path.join(rootDir, 'scripts', 'release-version.mjs'), 'check', tag], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  writeManifest();
  const { updaterBundle, updaterSignature, installer, entries } = findInstallerAssets();
  // Upload every bundle artifact: the updater consumes the nsis.zip pair,
  // the raw installer (+ its sig) serves manual installs.
  const assets = [updaterBundle, updaterSignature, installer, `${installer}.sig`, 'latest.json']
    .filter((name) => entries.includes(name) || name === 'latest.json')
    .map((name) => path.join(bundleDir, name));
  const notesArgs = notesPath ? ['--notes-file', notesPath] : ['--notes', `Stremiro ${tag}`];

  let exists = false;
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' });
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    execFileSync('gh', ['release', 'upload', tag, ...assets, '--clobber', '--repo', repo], {
      stdio: 'inherit',
    });
    execFileSync('gh', ['release', 'edit', tag, '--latest', '--repo', repo], {
      stdio: 'inherit',
    });
    console.log(`Updated existing release ${tag}.`);
  } else {
    execFileSync(
      'gh',
      [
        'release',
        'create',
        tag,
        ...assets,
        '--repo',
        repo,
        '--title',
        `Stremiro ${tag}`,
        ...notesArgs,
        ...(draft ? ['--draft'] : []),
      ],
      { stdio: 'inherit' },
    );
    console.log(`Created release ${tag}.`);
  }

  console.log(
    `Release must stay non-prerelease and latest for the updater endpoint: https://github.com/${repo}/releases/latest/download/latest.json`,
  );
}

if (mode === 'manifest') {
  writeManifest();
} else {
  publishRelease();
}
