import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

interface QwenLifecycleProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

type QwenLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'pipe';
    stderr: 'pipe';
  }
) => QwenLifecycleProcess;

type QwenLifecycleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface QwenLifecycleOptions {
  env?: Record<string, string | undefined>;
  fetch?: QwenLifecycleFetch;
  spawn?: QwenLifecycleSpawn;
  startupTimeoutMs?: number;
}

type QwenLifecycleAction = 'archive' | 'unarchive' | 'delete';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function qwenServeUrl(proc: QwenLifecycleProcess, timeoutMs: number): Promise<{ url: string; output: string }> {
  let output = '';
  let settled = false;
  let resolveReady: (value: { url: string; output: string }) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<{ url: string; output: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const consume = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      const match = /qwen serve listening on (http:\/\/[^\s]+)/.exec(output);
      if (!match || settled) continue;
      settled = true;
      resolveReady({ url: match[1]?.replace(/\/$/, '') ?? '', output });
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
    rejectReady(new Error(`qwen serve exited with code ${exitCode}: ${output.trim()}`));
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`qwen serve did not become ready within ${timeoutMs}ms: ${output.trim()}`));
  }, timeoutMs);
  try {
    return await ready;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopQwenServe(proc: QwenLifecycleProcess): Promise<void> {
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

function assertQwenLifecycleResult(action: QwenLifecycleAction, sessionId: string, value: unknown): void {
  const result = record(value);
  if (!result) throw new Error(`qwen sessions ${action} returned an invalid response`);
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length > 0) throw new Error(`qwen sessions ${action} failed: ${JSON.stringify(errors)}`);
  const successful =
    action === 'delete'
      ? [...stringArray(result.removed), ...stringArray(result.notFound)]
      : action === 'archive'
        ? [...stringArray(result.archived), ...stringArray(result.alreadyArchived)]
        : [...stringArray(result.unarchived), ...stringArray(result.alreadyActive)];
  if (!successful.includes(sessionId)) {
    const notFound = stringArray(result.notFound).includes(sessionId);
    throw new Error(notFound ? `qwen session not found: ${sessionId}` : `qwen sessions ${action} omitted ${sessionId}`);
  }
}

async function assertQwenArchiveCapability(request: QwenLifecycleFetch, url: string): Promise<void> {
  const response = await request(`${url}/capabilities`);
  const body = await response.text();
  if (!response.ok) throw new Error(`qwen capabilities failed with HTTP ${response.status}: ${body}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('qwen capabilities returned malformed JSON');
  }
  const features = record(parsed)?.features;
  const supported =
    (Array.isArray(features) && features.includes('session_archive')) || record(features)?.session_archive === true;
  if (!supported) throw new Error('qwen serve does not advertise the session_archive capability');
}

async function runQwenLifecycle(
  context: MeshAgentProviderSessionLifecycleContext,
  action: QwenLifecycleAction,
  options: QwenLifecycleOptions
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const request = options.fetch ?? fetch;
  const proc = spawn(
    [
      context.agent.command,
      ...(context.agent.args ?? []),
      'serve',
      '--workspace',
      context.workingPath,
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
      '--no-web'
    ],
    {
      cwd: context.workingPath,
      env: { ...process.env, ...(context.agent.env ?? {}), ...(options.env ?? {}) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );
  try {
    const { url } = await qwenServeUrl(proc, options.startupTimeoutMs ?? 20_000);
    if (action !== 'delete') await assertQwenArchiveCapability(request, url);
    const response = await request(`${url}/sessions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Qwen-Client-Id': 'monad-provider-lifecycle' },
      body: JSON.stringify({ sessionIds: [context.providerSessionRef] })
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`qwen sessions ${action} failed with HTTP ${response.status}: ${body}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`qwen sessions ${action} returned malformed JSON`);
    }
    assertQwenLifecycleResult(action, context.providerSessionRef, parsed);
  } finally {
    await stopQwenServe(proc);
  }
}

export function archiveQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  return runQwenLifecycle(context, 'archive', options);
}

export function unarchiveQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  return runQwenLifecycle(context, 'unarchive', options);
}

export function deleteQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  return runQwenLifecycle(context, 'delete', options);
}
