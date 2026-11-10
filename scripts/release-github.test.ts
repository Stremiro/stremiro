import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

function runRelease(args: string[], draft = false) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'stremiro-release-test-'));
  try {
    const scripts = path.join(root, 'scripts');
    const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src-tauri', 'tauri.conf.json'),
      JSON.stringify({
        productName: 'Stremiro',
        version: '1.2.3',
        plugins: {
          updater: {
            endpoints: ['https://github.com/example/app/releases/latest/download/latest.json'],
          },
        },
      }),
    );
    const installer = 'Stremiro_1.2.3_x64-setup.exe';
    fs.writeFileSync(path.join(bundle, installer), 'fixture');
    fs.writeFileSync(
      path.join(bundle, `${installer}.sig`),
      Buffer.from('trusted comment: fixture\tversion:1.2.3\n').toString('base64'),
    );
    const notesPath = path.join(root, 'notes.md');
    fs.writeFileSync(notesPath, 'Updated release notes\n');
    const calls: string[][] = [];
    let exitCode = 0;
    let error = '';
    const exit = new Error('release exited');
    const source = fs
      .readFileSync(path.join(import.meta.dirname, 'release-github.mjs'), 'utf8')
      .replace(/^import .*;\r?\n/gm, '')
      .replace('import.meta.dirname', JSON.stringify(scripts));
    try {
      runInNewContext(source, {
        fs,
        path,
        Buffer,
        execFileSync: (command: string, commandArgs: string[]) => {
          calls.push([command, ...commandArgs]);
          return commandArgs[0] === 'release' && commandArgs[1] === 'view' ? String(draft) : '';
        },
        process: {
          argv: [
            'bun',
            'release-github.mjs',
            ...args.map((arg) => (arg === 'notes.md' ? notesPath : arg)),
          ],
          exit: (code: number) => {
            exitCode = code;
            throw exit;
          },
        },
        console: {
          log: () => {},
          error: (message: string) => {
            error = message;
          },
        },
      });
    } catch (caught) {
      if (caught !== exit) throw caught;
    }
    const manifestPath = path.join(bundle, 'latest.json');
    return {
      exitCode,
      error,
      calls,
      manifest: fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : null,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test.each([false, true])(
  'release notes update an existing release while preserving draft=%s',
  (draft) => {
    const result = runRelease(
      ['publish', '--notes', 'notes.md', ...(draft ? ['--draft'] : [])],
      draft,
    );
    expect(result.exitCode, result.error).toBe(0);
    expect(result.manifest.notes).toBe('Updated release notes');
    const edit = result.calls.find((call) => call[1] === 'release' && call[2] === 'edit');
    expect(edit).toContain('--notes-file');
    expect(edit?.some((arg) => arg.endsWith('notes.md'))).toBe(true);
    expect(edit?.includes('--draft=false')).toBe(!draft);
    expect(edit?.includes('--latest')).toBe(!draft);
  },
);

test('republishing without supplied notes preserves the existing release body', () => {
  const result = runRelease(['publish']);
  expect(result.exitCode, result.error).toBe(0);
  const edit = result.calls.find((call) => call[1] === 'release' && call[2] === 'edit');
  expect(edit).toContain('--draft=false');
  expect(edit).not.toContain('--notes');
  expect(edit).not.toContain('--notes-file');
});

test.each([['--notes'], ['--notes', '--draft'], ['--notes', 'missing.md']])(
  'invalid release notes %j fail before any command or manifest write',
  (...args) => {
    const result = runRelease(['publish', ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Provide an existing notes file');
    expect(result.calls).toEqual([]);
    expect(result.manifest).toBeNull();
  },
);
