import type { NativeCliOutputEvent } from '@/services/native-cli/types.ts';

import { describe, expect, test } from 'bun:test';

import { claudeCodeNativeCliAdapter } from '@/services/native-cli/claude-code.ts';
import { codexNativeCliAdapter } from '@/services/native-cli/codex.ts';
import { nativeCliOutputEventSchema } from '@/services/native-cli/types.ts';

const CODEX_SESSION = process.env.MONAD_NATIVE_CLI_REAL_CODEX_SESSION;
const CODEX_CWD = process.env.MONAD_NATIVE_CLI_REAL_CODEX_CWD ?? process.cwd();
const CLAUDE_SESSION = process.env.MONAD_NATIVE_CLI_REAL_CLAUDE_SESSION;
const CLAUDE_CWD = process.env.MONAD_NATIVE_CLI_REAL_CLAUDE_CWD ?? process.cwd();
const AUTH_STATUS_SMOKE = process.env.MONAD_NATIVE_CLI_REAL_AUTH_STATUS === '1';

function validEvents(events: NativeCliOutputEvent[]): NativeCliOutputEvent[] {
  return events.filter((event) => nativeCliOutputEventSchema.safeParse(event).success);
}

interface PipeStdin {
  write(input: string): unknown;
  flush(): unknown;
  end(): unknown;
}

function requirePipeStdin(stdin: ReturnType<typeof Bun.spawn>['stdin']): PipeStdin {
  if (!stdin || typeof stdin === 'number') throw new Error('native CLI test process has no pipe stdin');
  return stdin;
}

function stdinBridge(stdin: PipeStdin) {
  return {
    write(input: string): void {
      stdin.write(input);
    },
    flush(): void {
      void stdin.flush();
    },
    end(): void {
      void stdin.end();
    }
  };
}

async function settle(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([proc.exited, Bun.sleep(1_000)]);
}

async function collectProcessOutput(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number
): Promise<{
  output: string;
  exitCode: number | null;
}> {
  const decoder = new TextDecoder();
  async function collect(stream: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
    if (!stream || typeof stream === 'number') return '';
    let output = '';
    for await (const chunk of stream) output += decoder.decode(chunk);
    return output;
  }
  const output = Promise.all([collect(proc.stdout), collect(proc.stderr)]).then(
    ([stdout, stderr]) => `${stdout}${stderr}`
  );
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => {
      proc.kill('SIGTERM');
      return null;
    })
  ]);
  return { output: await output.catch(() => ''), exitCode };
}

async function readUntil(
  stream: ReadableStream<Uint8Array> | undefined,
  parse: (stdout: string) => NativeCliOutputEvent | undefined,
  timeoutMs: number
): Promise<NativeCliOutputEvent | undefined> {
  if (!stream) return undefined;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => undefined)]);
    if (!result) return undefined;
    if (result.done) return parse(stdout);
    stdout += decoder.decode(result.value);
    const event = parse(stdout);
    if (event) return event;
  }
  return undefined;
}

describe.skipIf(!CODEX_SESSION)('native CLI real Codex resume contract', () => {
  test('resumes a local Codex app-server session through the adapter', async () => {
    const session = CODEX_SESSION;
    if (!session) throw new Error('MONAD_NATIVE_CLI_REAL_CODEX_SESSION is required');
    const proc = Bun.spawn(['codex', 'app-server', '--stdio'], {
      cwd: CODEX_CWD,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    let requestSeq = 0;
    codexNativeCliAdapter.initialize?.(
      {
        launchMode: 'app-server',
        stdin: stdinBridge(requirePipeStdin(proc.stdin)),
        nextRequestId: () => requestSeq++,
        kill: (signal) => proc.kill(signal)
      },
      { workingPath: CODEX_CWD, providerSessionRef: session }
    );

    try {
      const sessionRef = await readUntil(
        proc.stdout,
        (stdout) =>
          validEvents(codexNativeCliAdapter.parseOutput(stdout)).find((event) => event.type === 'session_ref'),
        60_000
      );
      expect(sessionRef?.payload.providerSessionRef).toBe(session);
    } finally {
      await settle(proc);
    }
  }, 75_000);
});

describe.skipIf(!CLAUDE_SESSION)('native CLI real Claude Code resume contract', () => {
  test('resumes a local Claude Code stream-json session through the adapter', async () => {
    const session = CLAUDE_SESSION;
    if (!session) throw new Error('MONAD_NATIVE_CLI_REAL_CLAUDE_SESSION is required');
    const proc = Bun.spawn(
      [
        'claude',
        '-p',
        '--resume',
        session,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'dontAsk'
      ],
      {
        cwd: CLAUDE_CWD,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
      }
    );
    claudeCodeNativeCliAdapter.sendInput(
      {
        launchMode: 'json-stream',
        stdin: stdinBridge(requirePipeStdin(proc.stdin)),
        kill: (signal) => proc.kill(signal)
      },
      'Reply exactly OK and do not use tools.'
    );

    try {
      const sessionRef = await readUntil(
        proc.stdout,
        (stdout) =>
          validEvents(claudeCodeNativeCliAdapter.parseOutput(stdout)).find((event) => event.type === 'session_ref'),
        45_000
      );
      expect(sessionRef?.payload.providerSessionRef).toBe(session);
    } finally {
      await settle(proc);
    }
  }, 60_000);
});

describe.skipIf(!AUTH_STATUS_SMOKE)('native CLI real provider auth status smoke', () => {
  test('checks Codex auth status through the adapter status probe', async () => {
    const launch = codexNativeCliAdapter.buildAuthStatusLaunch({
      name: 'codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      defaultLaunchMode: 'pty',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    });
    const proc = Bun.spawn(launch.argv, { cwd: launch.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const result = await collectProcessOutput(proc, 10_000);
    expect(['authenticated', 'unauthenticated', 'unknown']).toContain(
      codexNativeCliAdapter.parseAuthStatus(result.output, result.exitCode)
    );
  }, 15_000);

  test('checks Claude Code auth status through the adapter status probe', async () => {
    const launch = claudeCodeNativeCliAdapter.buildAuthStatusLaunch({
      name: 'claude-code',
      provider: 'claude-code',
      command: 'claude',
      enabled: true,
      defaultLaunchMode: 'pty',
      allowDangerousMode: false,
      approvalOwnership: 'provider-owned'
    });
    const proc = Bun.spawn(launch.argv, { cwd: launch.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const result = await collectProcessOutput(proc, 10_000);
    expect(['authenticated', 'unauthenticated', 'unknown']).toContain(
      claudeCodeNativeCliAdapter.parseAuthStatus(result.output, result.exitCode)
    );
  }, 15_000);
});
