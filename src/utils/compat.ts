import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface CrossSpawnResult {
  proc: ChildProcess;
  /** Collects all stdout into a string */
  stdout: () => Promise<string>;
  /** Collects all stderr into a string */
  stderr: () => Promise<string>;
  /** Resolves when process exits with exit code */
  exited: Promise<number>;
  /** Kill the process */
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Current exit code or null if running */
  get exitCode(): number | null;
}

function collectStream(
  stream: NodeJS.ReadableStream | null,
): () => Promise<string> {
  if (!stream) return () => Promise.resolve('');
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return () =>
    new Promise<string>((resolve, reject) => {
      if (!stream.readable) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
        return;
      }
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
}

const WINDOWS_PATH_EXT_DEFAULT = '.COM;.EXE;.BAT;.CMD';
const DIRECT_EXECUTION_EXTENSIONS = new Set(['.exe', '.com']);

export interface ResolvedWindowsCommand {
  /** Absolute path of the executable (or shim) that was found. */
  file: string;
  /**
   * True when `file` is a `.cmd`/`.bat` shim that only cmd.exe can
   * interpret; the caller must spawn it through cmd.exe with a quoted
   * command line instead of passing it to spawn() directly.
   */
  viaCmdShell: boolean;
}

function isRegularFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function splitList(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve a bare command name against PATH and PATHEXT the way cmd.exe
 * does, so spawn() can launch it on Windows.
 *
 * child_process.spawn only starts real executables; it cannot run the
 * extensionless sh and `.cmd` shims that npm-style installs leave on PATH
 * (for example `bun` installed via `npm install -g bun` exposes only
 * `bun.cmd` next to the real `bun.exe` buried in node_modules). A raw
 * spawn('bun') then fails with ENOENT even though bun runs fine in a
 * shell, which silently breaks bun-based flows such as the auto-updater.
 *
 * Walks PATH entries in order; within each entry, tries PATHEXT
 * extensions in declared order. The first directory containing any match
 * wins, and the matched extension decides whether the file is directly
 * spawnable (`.exe`/`.com`) or must run through cmd.exe (`.cmd`/`.bat`).
 */
export function resolveWindowsCommand(
  command: string,
  pathEnv: string = process.env.PATH ?? '',
  pathExtEnv: string = process.env.PATHEXT ?? WINDOWS_PATH_EXT_DEFAULT,
): ResolvedWindowsCommand | undefined {
  const extensions = splitList(pathExtEnv, ';').map((ext) =>
    ext.startsWith('.') ? ext : `.${ext}`,
  );
  const extensionsLower = new Set(extensions.map((ext) => ext.toLowerCase()));
  const commandExt = path.extname(command);
  const candidates =
    commandExt && extensionsLower.has(commandExt.toLowerCase())
      ? [command]
      : extensions.map((ext) => `${command}${ext}`);
  const candidatesLower = candidates.map((candidate) =>
    candidate.toLowerCase(),
  );

  for (const dir of splitList(pathEnv, path.delimiter)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    // Directory listing gives us the on-disk casing, so matching stays
    // case-insensitive even on case-sensitive filesystems.
    const byLowerName = new Map(
      entries.map((entry) => [entry.toLowerCase(), entry]),
    );
    for (const candidateLower of candidatesLower) {
      const actualName = byLowerName.get(candidateLower);
      if (actualName === undefined) continue;
      const candidatePath = path.join(dir, actualName);
      if (!isRegularFile(candidatePath)) continue;
      const resolvedExt = path.extname(actualName).toLowerCase();
      return {
        file: candidatePath,
        viaCmdShell: !DIRECT_EXECUTION_EXTENSIONS.has(resolvedExt),
      };
    }
  }
  return undefined;
}

/**
 * Quotes one argument for a `cmd.exe /c` command line. Arguments that
 * contain no spaces or quotes are passed through untouched — cmd's /s
 * stripping mangles gratuitously quoted tokens. Callers must not pass
 * untrusted input — cmd.exe expands `%VAR%` even inside quotes.
 */
function escapeWindowsArgument(arg: string): string {
  if (!/[\s"]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

function buildWindowsCommandLine(file: string, args: string[]): string {
  return [file, ...args].map(escapeWindowsArgument).join(' ');
}

/**
 * Cross-runtime spawn that works in both Bun and Node.js.
 * API mimics Bun.spawn but uses node:child_process internally.
 *
 * On Windows, bare command names are resolved against PATH/PATHEXT first
 * (see resolveWindowsCommand) so npm-installed CLIs that only expose
 * `.cmd` shims still run. Non-Windows platforms and explicit paths are
 * passed through unchanged.
 */
export function crossSpawn(
  command: string[],
  options?: {
    stdout?: 'pipe' | 'inherit' | 'ignore';
    stderr?: 'pipe' | 'inherit' | 'ignore';
    stdin?: 'pipe' | 'inherit' | 'ignore';
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): CrossSpawnResult {
  const [cmd, ...args] = command;
  let file = cmd;
  const fileArgs = args;
  let viaCmdShell = false;

  if (
    process.platform === 'win32' &&
    !cmd.includes('/') &&
    !cmd.includes('\\')
  ) {
    const resolved = resolveWindowsCommand(cmd);
    if (resolved) {
      file = resolved.file;
      viaCmdShell = resolved.viaCmdShell;
    }
  }

  const spawnOptions: SpawnOptions = {
    stdio: [
      options?.stdin ?? 'ignore',
      options?.stdout ?? 'pipe',
      options?.stderr ?? 'pipe',
    ],
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv,
  };

  const proc: ChildProcess = viaCmdShell
    ? nodeSpawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', buildWindowsCommandLine(file, fileArgs)],
        // The command line is pre-quoted by buildWindowsCommandLine, so
        // it must reach cmd.exe verbatim — without this flag Node/Bun
        // re-escape the quotes and cmd strips the backslashes.
        { ...spawnOptions, windowsVerbatimArguments: true },
      )
    : nodeSpawn(file, fileArgs, spawnOptions);

  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);

  const exited = new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });

  return {
    proc,
    stdout: stdoutCollector,
    stderr: stderrCollector,
    exited,
    kill: (signal) => proc.kill(signal as NodeJS.Signals),
    get exitCode() {
      return proc.exitCode;
    },
  };
}

/**
 * Cross-runtime file write that works in both Bun and Node.js.
 *
 * Order matters: Buffer is checked before treating the remainder as
 * ArrayBuffer so Buffer slices are written as-is (no parent-buffer copy).
 * Remaining union member is treated as ArrayBuffer without `instanceof`,
 * which fails for cross-realm ArrayBuffers.
 */
export async function crossWrite(
  path: string,
  data: ArrayBuffer | Buffer | string,
): Promise<void> {
  if (typeof data === 'string') {
    await fsWriteFile(path, Buffer.from(data));
    return;
  }
  if (Buffer.isBuffer(data)) {
    await fsWriteFile(path, data);
    return;
  }
  await fsWriteFile(path, Buffer.from(data));
}
