// Execution backends for fs/shell tools. The sandbox backend (default) reads/writes the
// daemon's own disk behind the path guards and spawns commands on the host. An alternate
// backend (e.g. ACP, in apps/monad) can satisfy the same ToolBackends interface to delegate
// these operations to a connected editor. Keeping the primitives here lets fs.ts/shell.ts stay
// thin Tool wrappers and avoids a tools→agent-core dependency cycle.

import type { TerminalExecResult, ToolBackends } from './types.ts';

import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { buildSandboxPolicy, sandboxedSpawn } from './sandbox/spawn.ts';
import { assertPathWithinRoots, ToolSecurityError } from './security.ts';

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MiB per file
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const DEFAULT_TIMEOUT_MS = 60_000;
const COLOR_ENV = {
  CLICOLOR: '1',
  CLICOLOR_FORCE: '1',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '1',
  TERM: 'xterm-256color'
} as const;

/**
 * Lexical sandbox check then realpath re-assert — a symlink inside the sandbox can point
 * out of it, which a lexical check can't see. `mustExist:false` realpaths the parent dir
 * instead (the file may not exist yet).
 *
 * Roots are realpath'd too: a sandbox root under a symlinked prefix (macOS /var →
 * /private/var, /tmp → /private/tmp) would otherwise canonicalize to a path that no longer
 * starts with the literal root, falsely rejecting legitimate in-sandbox files.
 */
export async function resolveReal(path: string, roots: string[] | undefined, mustExist = true): Promise<string> {
  const resolved = assertPathWithinRoots(path, roots);
  const realRoots = roots ? await Promise.all(roots.map((r) => realpath(r).catch(() => r))) : undefined;
  if (mustExist) {
    const real = await realpath(resolved);
    return assertPathWithinRoots(real, realRoots);
  }
  const realDir = await realpath(dirname(resolved));
  return assertPathWithinRoots(join(realDir, basename(resolved)), realRoots);
}

// Shell resolution (cross-platform).
// POSIX: `sh -c <cmd>`. Windows: Git Bash (MSYS2 coreutils) bundled with the installer.
// cmd.exe and PowerShell are not supported — the Windows installer ships Git Bash.

/**
 * Single source of truth for Git Bash detection — apps/cli calls this too so the preflight
 * check and what the shell backend actually runs can't drift. Returns null on non-Windows.
 * Priority: explicit config path → bundled (shipped in the monad installer) → system Git.
 */
export function findGitBash(explicitPath?: string): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    explicitPath,
    Bun.env.CLAUDE_CODE_GIT_BASH_PATH,
    // Git Bash downloaded at install time: <install>\bin\monad.exe → <install>\git\bin\bash.exe.
    // Anchor on process.execPath (the real on-disk binary), NOT import.meta.dir — in a compiled
    // Bun binary the latter is the virtual /$bunfs path and can't locate sibling files.
    join(dirname(process.execPath), '..', 'git', 'bin', 'bash.exe'),
    Bun.env.ProgramFiles && `${Bun.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    Bun.env['ProgramFiles(x86)'] && `${Bun.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    Bun.env.LOCALAPPDATA && `${Bun.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function resolveShell(opts?: { shellPath?: string; gitBashPath?: string }): { bin: string; flag: string } {
  if (opts?.shellPath) return { bin: opts.shellPath, flag: '-c' };

  if (process.platform !== 'win32') return { bin: '/bin/sh', flag: '-c' };

  const bash = findGitBash(opts?.gitBashPath);
  if (bash) return { bin: bash, flag: '-c' };
  throw new Error('Git Bash not found on Windows. Reinstall monad — the installer bundles Git Bash automatically.');
}

// Lazy — populated by configureShell() once the daemon config is loaded. Falls back to
// auto-detection on first use so process.ts (which calls shellArgv without config context)
// always gets a valid shell even if configureShell is never called (tests, CLI tools).
let _shell: { bin: string; flag: string } | null = null;

/** Call once after config load to wire up shell overrides from config.agent.tools. */
export function configureShell(opts: { shellPath?: string; gitBashPath?: string }): void {
  _shell = resolveShell(opts);
}

/** Argv to run `command` through the resolved shell. Shared with process.ts. */
export function shellArgv(command: string): string[] {
  _shell ??= resolveShell();
  const { bin, flag } = _shell;
  return [bin, flag, command];
}

// Process-group signalling (cross-platform glue). process_start spawns detached so the child leads
// its own group; signalling the whole group reaps shells and grandchildren (e.g. dev-server workers).
//   POSIX  — a negative pid targets the process group.
//   Windows — has no POSIX groups: `taskkill /T` walks the child tree for a forced terminate;
//             other signals fall back to a direct kill (Bun maps SIGINT/SIGHUP to a plain terminate
//             on Windows anyway, so process-group semantics can't be matched there).
// Kept here next to resolveShell/findGitBash so feature code (process-runtime) carries no
// process.platform branch.
export type ProcessGroupSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGKILL';
export interface SignalableProcess {
  readonly pid: number;
  kill(signal: ProcessGroupSignal): void;
}
export function signalProcessTree(proc: SignalableProcess, signal: ProcessGroupSignal): void {
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], { stderr: 'ignore', stdout: 'ignore' });
      } else {
        proc.kill(signal);
      }
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function clip(buf: Uint8Array): string {
  const text = new TextDecoder().decode(buf);
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]` : text;
}

function terminalColorEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const rawGitConfigCount = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10);
  const gitConfigCount = Number.isFinite(rawGitConfigCount) && rawGitConfigCount >= 0 ? rawGitConfigCount : 0;
  return {
    ...base,
    ...COLOR_ENV,
    GIT_CONFIG_COUNT: String(gitConfigCount + 1),
    [`GIT_CONFIG_KEY_${gitConfigCount}`]: 'color.ui',
    [`GIT_CONFIG_VALUE_${gitConfigCount}`]: 'always'
  };
}

async function sandboxExec(
  opts: {
    command: string | string[];
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    onChunk?: (output: string) => void;
  },
  sandboxRoots: string[] | undefined,
  defaultCwd?: string,
  sessionId?: string
): Promise<TerminalExecResult> {
  const dir = assertPathWithinRoots(opts.cwd ?? defaultCwd ?? sandboxRoots?.[0] ?? process.cwd(), sandboxRoots);
  const limit = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Per-call env is layered ON TOP of the inherited environment (additive — the caller sends only
  // the vars it wants to add); sandboxedSpawn's proxy/HOME overlay still wins over both.
  const spawnEnv = terminalColorEnv({ ...Bun.env, ...(opts.env ?? {}) });
  // Array argv → exec directly (no shell parse, no quoting issues); string → wrap in the platform shell.
  const argv = Array.isArray(opts.command) ? opts.command : shellArgv(opts.command);
  const proc = sandboxedSpawn(
    argv,
    { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: spawnEnv },
    buildSandboxPolicy(sandboxRoots, [], sessionId),
    { sessionId }
  );

  // Enforce the timeout by racing a prompt rejection (mirrors the abort path below). Killing the
  // shell can leave a grandchild (e.g. `sleep`) holding the stdout pipe open, so awaiting the
  // stream drain after the kill would hang until that child exits — on Linux that made a timeout
  // take as long as the command itself instead of `limit`. Reject the moment the timer fires.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new ToolSecurityError(`command timed out after ${limit}ms`));
    }, limit);
  });
  // Race completion against the timeout (and session abort). A killed shell can leave a grandchild
  // holding the stdout pipe open, so we must not block on the stream read after either fires.
  // stdout is drained incrementally so onChunk can stream the live (cumulative) output.
  const drainStdout = (async (): Promise<Uint8Array> => {
    const dec = new TextDecoder();
    const parts: Uint8Array[] = [];
    let total = 0;
    let acc = '';
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      parts.push(chunk);
      total += chunk.length;
      if (opts.onChunk) {
        acc += dec.decode(chunk, { stream: true });
        opts.onChunk(acc);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  })();
  const completion = (async () => {
    const [stdout, stderr] = await Promise.all([drainStdout, new Response(proc.stderr).bytes()]);
    return { stdout, stderr, exitCode: await proc.exited };
  })();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => {
      proc.kill('SIGKILL');
      reject(new ToolSecurityError('command aborted'));
    };
    if (opts.signal?.aborted) fail();
    else opts.signal?.addEventListener('abort', fail, { once: true });
  });

  try {
    const { stdout, stderr, exitCode } = await Promise.race(
      opts.signal ? [completion, timedOutP, aborted] : [completion, timedOutP]
    );
    if (timedOut) throw new ToolSecurityError(`command timed out after ${limit}ms`);
    return { stdout: clip(stdout), stderr: clip(stderr), exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** The default fs/terminal backend: operates on the daemon host behind the sandbox guards. */
export function createSandboxBackends(
  sandboxRoots?: string[],
  opts?: { defaultCwd?: string; sessionId?: string }
): ToolBackends {
  const { defaultCwd, sessionId } = opts ?? {};
  return {
    fs: {
      delegated: false,
      async readTextFile(path, opts) {
        const real = await resolveReal(path, sandboxRoots);
        const file = Bun.file(real);
        if (file.size > MAX_READ_BYTES) {
          throw new ToolSecurityError(`file too large to read (${file.size} bytes > ${MAX_READ_BYTES})`);
        }
        const text = await file.text();
        if (opts?.offset === undefined && opts?.limit === undefined) return text;
        const lines = text.split('\n');
        const start = (opts.offset ?? 1) - 1;
        const end = opts.limit === undefined ? lines.length : start + opts.limit;
        return lines.slice(start, end).join('\n');
      },
      async writeTextFile(path, content) {
        // Create the parent within the sandbox first, then realpath + re-check before writing
        // so a symlinked ancestor can't redirect us out of the sandbox.
        const lexical = assertPathWithinRoots(path, sandboxRoots);
        await mkdir(dirname(lexical), { recursive: true });
        // The leaf matters too: parent-only realpath (mustExist:false) leaves an existing symlink
        // leaf unresolved, and Bun.write follows it — a symlink inside the sandbox pointing out
        // would escape. lstat (no-follow) detects the link; then realpath the full path and
        // re-assert within roots (mirrors readTextFile). A dangling symlink fails realpath → reject.
        let leafIsSymlink = false;
        try {
          leafIsSymlink = (await lstat(lexical)).isSymbolicLink();
        } catch {
          /* leaf doesn't exist yet — a new file; the parent realpath is sufficient */
        }
        const real = await resolveReal(path, sandboxRoots, leafIsSymlink);
        await Bun.write(real, content);
        return { path: real, bytesWritten: Buffer.byteLength(content, 'utf8') };
      },
      async deleteFile(path) {
        const real = await resolveReal(path, sandboxRoots);
        await unlink(real);
        return { path: real };
      },
      async moveFile(path, newPath) {
        const real = await resolveReal(path, sandboxRoots);
        const lexicalNew = assertPathWithinRoots(newPath, sandboxRoots);
        await mkdir(dirname(lexicalNew), { recursive: true });
        const realNew = await resolveReal(newPath, sandboxRoots, false);
        await rename(real, realNew);
        return { path: real, newPath: realNew };
      }
    },
    terminal: {
      delegated: false,
      exec: (opts) => sandboxExec(opts, sandboxRoots, defaultCwd, sessionId)
    }
  };
}

// Tools that must NOT run in a delegated (ACP) session: they would execute on the daemon host
// (process_*, code_execute) or read the daemon's disk (file_glob/file_grep) rather than the editor's,
// bypassing delegation. Used as a per-session toolFilter when fs/terminal delegation is active.
export function isDelegableTool(toolName: string): boolean {
  return !(
    toolName.startsWith('process_') ||
    toolName === 'code_execute' ||
    toolName === 'file_glob' ||
    toolName === 'file_grep'
  );
}
