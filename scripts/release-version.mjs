import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');
const cargoVersionPattern = /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(".*)$/m;
const cargoLockVersionPattern =
  /^(\[\[package\]\]\r?\nname = "stremiro"\r?\nversion = ")([^"]+)(")/m;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextVersion(filePath, pattern) {
  const match = fs.readFileSync(filePath, 'utf8').match(pattern);
  if (!match) fail(`Unable to locate the package version in ${path.relative(rootDir, filePath)}.`);
  return match[2];
}

function readVersions() {
  const packageJson = readJson(packageJsonPath);
  const tauriConfig = readJson(tauriConfigPath);

  return {
    cargo: readTextVersion(cargoTomlPath, cargoVersionPattern),
    cargoLock: readTextVersion(cargoLockPath, cargoLockVersionPattern),
    packageJson: packageJson.version,
    tauriConfig: tauriConfig.version,
  };
}

function validateVersion(nextVersion) {
  const match = nextVersion.match(versionPattern);
  if (!match || match[1]?.split('.').some((part) => /^0\d+$/.test(part))) {
    fail(
      `Invalid version "${nextVersion}". Use semantic versions like 0.4.0, 0.4.0-beta.1, or 1.0.0-rc.1.`,
    );
  }
}

function checkVersions(tagName) {
  const versions = readVersions();
  const uniqueVersions = [...new Set(Object.values(versions))];

  if (uniqueVersions.length !== 1) {
    fail(
      `Version mismatch detected. package.json=${versions.packageJson}, Cargo.toml=${versions.cargo}, Cargo.lock=${versions.cargoLock}, tauri.conf.json=${versions.tauriConfig}`,
    );
  }

  const version = uniqueVersions[0];
  validateVersion(version);

  if (tagName) {
    const normalizedTagName = tagName.startsWith('refs/tags/')
      ? tagName.slice('refs/tags/'.length)
      : tagName;

    if (normalizedTagName !== `v${version}`) {
      fail(`Tag ${normalizedTagName} does not match version v${version}.`);
    }
  }

  console.log(`Release version verified: ${version}`);
}

function setVersion(nextVersion) {
  validateVersion(nextVersion);

  // Read and validate every source before writing: a missing Cargo version
  // must not leave the JSON manifests bumped on their own.
  readVersions();
  const packageJson = readJson(packageJsonPath);
  packageJson.version = nextVersion;
  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = nextVersion;

  const writes = [
    [packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`],
    [tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`],
    ...[
      [cargoTomlPath, cargoVersionPattern],
      [cargoLockPath, cargoLockVersionPattern],
    ].map(([filePath, pattern]) => [
      filePath,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(pattern, (_match, before, _version, after) => `${before}${nextVersion}${after}`),
    ]),
  ];
  for (const [filePath, content] of writes) fs.writeFileSync(filePath, content);

  console.log(`Release version set to ${nextVersion}`);
}

const [mode, value] = process.argv.slice(2);

if (mode === 'check') {
  checkVersions(value);
} else if (mode === 'set') {
  if (!value) {
    fail('Provide a version to set, for example: bun run release:version:set -- 0.4.0-beta.1');
  }

  setVersion(value);
} else {
  fail('Usage: bun ./scripts/release-version.mjs <check|set> [value]');
}
