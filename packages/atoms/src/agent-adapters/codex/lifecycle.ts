import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { jsonRpcRequest } from '../jsonrpc.ts';
import { recordValue } from './app-server/events.ts';

type CodexLifecycleEnvironment = Record<string, string | undefined>;

interface CodexLifecycleProcess {
  stdin: { write(chunk: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

type CodexLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'ignore';
  }
) => CodexLifecycleProcess;

export interface CodexLifecycleOptions {
  command?: string;
  commandArgs?: string[];
  env?: CodexLifecycleEnvironment;
  timeoutMs?: number;
  spawn?: CodexLifecycleSpawn;
}

function targetResponseStart(input: string, id: number): number {
  const numeric = input.indexOf(`{"id":${id}`);
  const string = input.indexOf(`{"id":"${id}"`);
  if (numeric < 0) return string;
  if (string < 0) return numeric;
  return Math.min(numeric, string);
}

function extractJsonRpcResponse(input: string, id: number): Record<string, unknown> | null | undefined {
  const start = targetResponseStart(input, id);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth !== 0) continue;
    try {
      return recordValue(JSON.parse(input.slice(start, index + 1))) ?? null;
    } catch {
      return null;
    }
  }
  return undefined;
}

async function runCodexThreadLifecycle(
  context: MeshAgentProviderSessionLifecycleContext,
  method: 'thread/archive' | 'thread/delete',
  options: CodexLifecycleOptions = {}
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn([options.command ?? 'codex', ...(options.commandArgs ?? []), 'app-server', '--stdio'], {
    cwd: context.workingPath,
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const requestId = 2;
  let output = '';
  const timeoutAt = Date.now() + (options.timeoutMs ?? 5000);
  const consumeBufferedRecords = (): boolean | undefined => {
    const record = extractJsonRpcResponse(output, requestId);
    if (record === undefined) return undefined;
    if (record === null) throw new Error(`codex ${method} returned malformed JSON-RPC`);
    const error = recordValue(record.error);
    if (error) throw new Error(`codex ${method} failed: ${String(error.message ?? 'unknown error')}`);
    return true;
  };

  try {
    proc.stdin.write(
      jsonRpcRequest('initialize', 1, {
        clientInfo: { name: 'monad', version: '0' },
        capabilities: null
      })
    );
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    proc.stdin.write(jsonRpcRequest(method, requestId, { threadId: context.providerSessionRef }));

    let pendingRead = reader.read();
    while (Date.now() < timeoutAt) {
      const chunk = await Promise.race([
        pendingRead,
        new Promise<{ done: false; value?: undefined; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ done: false, timedOut: true }), 50)
        )
      ]);
      if ('timedOut' in chunk) {
        if (consumeBufferedRecords()) return;
        continue;
      }
      if (chunk.done) {
        if (consumeBufferedRecords()) return;
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
      pendingRead = reader.read();
    }
  } finally {
    proc.kill();
  }
  throw new Error(`codex ${method} timed out`);
}

export function archiveCodexSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options?: CodexLifecycleOptions
): Promise<void> {
  return runCodexThreadLifecycle(context, 'thread/archive', options);
}

export function deleteCodexSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options?: CodexLifecycleOptions
): Promise<void> {
  return runCodexThreadLifecycle(context, 'thread/delete', options);
}
