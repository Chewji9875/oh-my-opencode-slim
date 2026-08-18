import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { crossWrite, resolveWindowsCommand } from './compat';

const TEST_DIR = path.join(os.tmpdir(), `compat-test-${process.pid}`);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function testFile(name: string): string {
  const dir = path.join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'out.bin');
}

describe('crossWrite', () => {
  it('writes string data as utf-8 bytes', async () => {
    const filePath = testFile('string');
    await crossWrite(filePath, 'hello');
    expect(readFileSync(filePath)).toEqual(Buffer.from('hello'));
  });

  it('writes Buffer slices without parent-buffer bytes', async () => {
    const filePath = testFile('buffer-slice');
    const parent = Buffer.from([0xaa, 0x01, 0x02, 0x03, 0xbb]);
    const slice = parent.subarray(1, 4);
    expect(Buffer.isBuffer(slice)).toBe(true);
    await crossWrite(filePath, slice);
    expect(readFileSync(filePath)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it('writes same-realm ArrayBuffer contents', async () => {
    const filePath = testFile('arraybuffer');
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([0x10, 0x20, 0x30]);
    await crossWrite(filePath, ab);
    expect(readFileSync(filePath)).toEqual(Buffer.from([0x10, 0x20, 0x30]));
  });

  it('writes cross-realm ArrayBuffer that fails instanceof ArrayBuffer', async () => {
    const filePath = testFile('cross-realm-ab');

    const crossRealm = runInNewContext(
      'const b = new ArrayBuffer(2); new Uint8Array(b).set([0x7e, 0x7f]); b',
    ) as ArrayBuffer;

    // Prerequisite: node:vm must yield a true cross-realm buffer.
    expect(crossRealm instanceof ArrayBuffer).toBe(false);

    await crossWrite(filePath, crossRealm);
    expect(readFileSync(filePath)).toEqual(Buffer.from([0x7e, 0x7f]));
  });
});

describe('resolveWindowsCommand', () => {
  const RESOLVE_DIR = path.join(TEST_DIR, 'resolve');

  function fixtureDir(name: string, files: string[]): string {
    const dir = path.join(RESOLVE_DIR, name);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(path.join(dir, file), '');
    }
    return dir;
  }

  function joinPathEnv(dirs: string[]): string {
    return dirs.join(path.delimiter);
  }

  it('prefers .exe over .cmd within the same PATH entry', () => {
    const dir = fixtureDir('mixed', ['bun.cmd', 'bun.exe']);
    const resolved = resolveWindowsCommand(
      'bun',
      joinPathEnv([dir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved?.file).toBe(path.join(dir, 'bun.exe'));
    expect(resolved?.viaCmdShell).toBe(false);
  });

  it('honours PATH order: an earlier .cmd beats a later .exe', () => {
    // Matches cmd.exe semantics — the first directory containing any
    // match wins, so PATH order trumps extension priority across dirs.
    const cmdDir = fixtureDir('shim-only', ['bun.cmd']);
    const exeDir = fixtureDir('real-only', ['bun.exe']);
    const resolved = resolveWindowsCommand(
      'bun',
      joinPathEnv([cmdDir, exeDir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved?.file).toBe(path.join(cmdDir, 'bun.cmd'));
    expect(resolved?.viaCmdShell).toBe(true);
  });

  it('falls back to a .cmd shim when no real executable exists', () => {
    const dir = fixtureDir('npm-shims', ['bun', 'bun.cmd', 'bun.ps1']);
    const resolved = resolveWindowsCommand(
      'bun',
      joinPathEnv([dir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved?.file).toBe(path.join(dir, 'bun.cmd'));
    expect(resolved?.viaCmdShell).toBe(true);
  });

  it('respects a custom PATHEXT order', () => {
    const dir = fixtureDir('custom-ext', ['bun.exe', 'bun.cmd']);
    const resolved = resolveWindowsCommand(
      'bun',
      joinPathEnv([dir]),
      '.CMD;.EXE',
    );
    expect(resolved?.file).toBe(path.join(dir, 'bun.cmd'));
    expect(resolved?.viaCmdShell).toBe(true);
  });

  it('keeps the extension of a command that already carries one', () => {
    const dir = fixtureDir('explicit-ext', ['bun.exe', 'bun.cmd']);
    const resolved = resolveWindowsCommand(
      'bun.exe',
      joinPathEnv([dir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved?.file).toBe(path.join(dir, 'bun.exe'));
    expect(resolved?.viaCmdShell).toBe(false);
  });

  it('matches extensionless commands case-insensitively', () => {
    const dir = fixtureDir('case-insensitive', ['BUN.EXE']);
    const resolved = resolveWindowsCommand(
      'bun',
      joinPathEnv([dir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved?.file).toBe(path.join(dir, 'BUN.EXE'));
  });

  it('returns undefined when nothing on PATH matches', () => {
    const dir = fixtureDir('empty', []);
    const resolved = resolveWindowsCommand(
      'definitely-missing-omos-cmd',
      joinPathEnv([dir]),
      '.COM;.EXE;.BAT;.CMD',
    );
    expect(resolved).toBeUndefined();
  });
});
