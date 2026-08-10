import type { MeshAgentSessionUsage } from '@monad/protocol';
import type { MeshAgentProviderSessionUsageContext } from '@monad/sdk-atom';

import { meshAgentSessionUsageSchema } from '@monad/protocol';

import { jsonRpcRequest } from '../jsonrpc.ts';
import { codexProviderSessionUnavailable } from './provider-session-error.ts';

interface CodexUsageProcess {
  stdin: { write(chunk: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

interface CodexSessionUsageOptions {
  spawn?: (
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdin: 'pipe';
      stdout: 'pipe';
      stderr: 'ignore';
    }
  ) => CodexUsageProcess;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonnegativeNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function codexSessionUsageFromNotification(value: unknown): MeshAgentSessionUsage | undefined {
  const message = object(value);
  if (message?.method !== 'thread/tokenUsage/updated') return undefined;
  const tokenUsage = object(object(message.params)?.tokenUsage);
  const total = object(tokenUsage?.total);
  const last = object(tokenUsage?.last);
  if (!tokenUsage || !total || !last) return undefined;
  const totalTokens = nonnegativeNumber(total, 'totalTokens');
  const inputTokens = nonnegativeNumber(total, 'inputTokens');
  const outputTokens = nonnegativeNumber(total, 'outputTokens');
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;

  const cachedInput = nonnegativeNumber(total, 'cachedInputTokens');
  const reasoningOutput = nonnegativeNumber(total, 'reasoningOutputTokens');
  const contextUsed = nonnegativeNumber(last, 'totalTokens');
  const contextWindow = nonnegativeNumber(tokenUsage, 'modelContextWindow');
  return meshAgentSessionUsageSchema.parse({
    total: totalTokens,
    input: inputTokens,
    output: outputTokens,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(reasoningOutput === undefined ? {} : { reasoningOutput }),
    ...(contextUsed === undefined || contextWindow === undefined
      ? {}
      : { context: { used: contextUsed, window: contextWindow } })
  });
}

export async function readCodexSessionUsage(
  context: MeshAgentProviderSessionUsageContext,
  options: CodexSessionUsageOptions = {}
): Promise<MeshAgentSessionUsage | null> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn([context.executable, 'app-server', '--stdio'], {
    cwd: context.workingPath,
    env: { ...process.env, ...(context.env ?? {}) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  let pending = '';

  proc.stdin.write(
    jsonRpcRequest('initialize', 1, {
      clientInfo: { name: 'monad', version: '0' },
      capabilities: null
    })
  );
  proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  proc.stdin.write(
    jsonRpcRequest('thread/resume', 2, {
      threadId: context.providerSessionRef,
      includeTurns: true
    })
  );

  try {
    while (Date.now() < timeoutAt) {
      const remaining = Math.max(1, timeoutAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), remaining);
        })
      ]).finally(() => clearTimeout(timer));
      if ('timedOut' in chunk) break;
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = codexSessionUsageFromNotification(message);
        if (usage) return usage;
        const response = object(message);
        if (response?.id === 2 && object(response.error)) {
          const error = object(response.error);
          const errorMessage = typeof error?.message === 'string' ? error.message : 'unknown error';
          if (codexProviderSessionUnavailable(errorMessage)) return null;
          throw new Error(`Codex thread/resume failed: ${errorMessage}`);
        }
      }
    }
    throw new Error('Codex thread usage is unavailable');
  } finally {
    proc.kill();
  }
}
