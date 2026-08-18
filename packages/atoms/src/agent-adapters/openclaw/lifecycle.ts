import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

interface OpenClawLifecycleProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

type OpenClawLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'pipe';
    stderr: 'pipe';
  }
) => OpenClawLifecycleProcess;

export interface OpenClawLifecycleOptions {
  env?: Record<string, string | undefined>;
  port?: number;
  spawn?: OpenClawLifecycleSpawn;
  startupTimeoutMs?: number;
  token?: string;
}

type OpenClawLifecycleAction = 'archive' | 'unarchive' | 'delete';

function availableLoopbackPort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('openclaw lifecycle could not obtain a loopback port');
  return port;
}

async function waitForOpenClawGateway(proc: OpenClawLifecycleProcess, timeoutMs: number): Promise<void> {
  let output = '';
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const consume = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output = `${output}${decoder.decode(chunk.value, { stream: true })}`.slice(-16_384);
      if (settled || !/\[gateway\]\s+ready\b/.test(output)) continue;
      settled = true;
      resolveReady();
    }
  };
  void Promise.all([consume(proc.stdout), consume(proc.stderr)]).catch((error) => {
    if (settled) return;
    settled = true;
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  });
  void proc.exited.then((exitCode) => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`openclaw gateway exited with code ${exitCode}: ${output.trim()}`));
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`openclaw gateway did not become ready within ${timeoutMs}ms: ${output.trim()}`));
  }, timeoutMs);
  try {
    await ready;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopOpenClawGateway(proc: OpenClawLifecycleProcess): Promise<void> {
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5000);
    })
  ]);
  if (timeout) clearTimeout(timeout);
  if (!exited) proc.kill('SIGKILL');
}

async function callOpenClawGateway(
  context: MeshAgentProviderSessionLifecycleContext,
  method: 'sessions.patch' | 'sessions.delete',
  params: Record<string, unknown>,
  runtime: { env: Record<string, string | undefined>; port: number; spawn: OpenClawLifecycleSpawn; token: string }
): Promise<void> {
  const proc = runtime.spawn(
    [
      context.agent.command,
      ...(context.agent.args ?? []),
      'gateway',
      'call',
      '--json',
      '--url',
      `ws://127.0.0.1:${runtime.port}`,
      '--token',
      runtime.token,
      '--params',
      JSON.stringify(params),
      method
    ],
    {
      cwd: context.workingPath,
      env: runtime.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  if (exitCode !== 0) {
    const diagnostic = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`openclaw gateway call ${method} failed: ${diagnostic}`);
  }
}

async function runOpenClawLifecycle(
  context: MeshAgentProviderSessionLifecycleContext,
  action: OpenClawLifecycleAction,
  options: OpenClawLifecycleOptions
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const port = options.port ?? availableLoopbackPort();
  const token = options.token ?? crypto.randomUUID().replaceAll('-', '');
  const env = {
    ...process.env,
    ...(context.agent.env ?? {}),
    ...(options.env ?? {}),
    OPENCLAW_GATEWAY_TOKEN: token
  };
  const gateway = spawn(
    [
      context.agent.command,
      ...(context.agent.args ?? []),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--auth',
      'token',
      '--port',
      String(port),
      '--ws-log',
      'compact'
    ],
    { cwd: context.workingPath, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  try {
    await waitForOpenClawGateway(gateway, options.startupTimeoutMs ?? 20_000);
    const runtime = { env, port, spawn, token };
    if (action === 'delete') {
      await callOpenClawGateway(
        context,
        'sessions.patch',
        { key: context.providerSessionRef, archived: true },
        runtime
      );
      await callOpenClawGateway(
        context,
        'sessions.delete',
        { key: context.providerSessionRef, archivedOnly: true, deleteTranscript: true },
        runtime
      );
      return;
    }
    await callOpenClawGateway(
      context,
      'sessions.patch',
      { key: context.providerSessionRef, archived: action === 'archive' },
      runtime
    );
  } finally {
    await stopOpenClawGateway(gateway);
  }
}

export function archiveOpenClawSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: OpenClawLifecycleOptions = {}
): Promise<void> {
  return runOpenClawLifecycle(context, 'archive', options);
}

export function unarchiveOpenClawSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: OpenClawLifecycleOptions = {}
): Promise<void> {
  return runOpenClawLifecycle(context, 'unarchive', options);
}

export function deleteOpenClawSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: OpenClawLifecycleOptions = {}
): Promise<void> {
  return runOpenClawLifecycle(context, 'delete', options);
}
