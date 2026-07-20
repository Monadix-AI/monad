import type { MeshAgentProviderEventContext, MeshAgentProviderEventPageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readProviderEventFile } from '../event-files.ts';
import { jsonRpcRequest } from '../jsonrpc.ts';
import { recordValue } from './app-server/events.ts';

type CodexHistoryEnvironment = Record<string, string | undefined>;
type CodexThreadRead = (
  context: MeshAgentProviderEventContext
) => CodexThreadReadResponseLike | null | Promise<CodexThreadReadResponseLike | null>;

type CodexThreadReadResponseLike = {
  thread?: {
    turns?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

interface CodexHistoryReadOptions {
  env?: CodexHistoryEnvironment;
  command?: string;
  timeoutMs?: number;
  threadRead?: CodexThreadRead;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function codexHistoryRoots(env: CodexHistoryEnvironment): string[] {
  const configuredHome = env.CODEX_HOME?.trim();
  const defaultHome = join(homedir(), '.codex');
  if (configuredHome) {
    return uniquePaths([configuredHome, join(configuredHome, 'sessions'), join(configuredHome, 'archived_sessions')]);
  }
  return [join(defaultHome, 'sessions'), join(defaultHome, 'archived_sessions')];
}

function parseCodexReadOptions(
  options: CodexHistoryEnvironment | CodexHistoryReadOptions = {}
): CodexHistoryReadOptions {
  if ('env' in options || 'threadRead' in options || 'command' in options || 'timeoutMs' in options) {
    return options as CodexHistoryReadOptions;
  }
  return { env: options as CodexHistoryEnvironment };
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

export function readCodexEventFileOutput(
  context: MeshAgentProviderEventContext,
  env: CodexHistoryEnvironment = process.env
): string | null {
  return readProviderEventFile({
    roots: codexHistoryRoots(env),
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl']
  });
}

export function codexThreadReadOutput(response: CodexThreadReadResponseLike | null): string | null {
  const turns = response?.thread?.turns;
  if (!Array.isArray(turns)) return null;
  return JSON.stringify({
    result: {
      data: turns,
      nextCursor: null,
      backwardsCursor: null
    }
  });
}

async function readCodexAppServerThread(
  context: MeshAgentProviderEventContext,
  options: CodexHistoryReadOptions
): Promise<CodexThreadReadResponseLike | null> {
  if (options.threadRead) return options.threadRead(context);
  const proc = Bun.spawn([options.command ?? 'codex', 'app-server', '--stdio'], {
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
  const consumeBufferedRecords = () => {
    const record = extractJsonRpcResponse(output, requestId);
    if (record === undefined) return undefined;
    if (record === null) return null;
    if (recordValue(record.error)) return null;
    return recordValue(record.result) as CodexThreadReadResponseLike | null;
  };

  try {
    proc.stdin.write(
      jsonRpcRequest('initialize', 1, {
        clientInfo: { name: 'monad', version: '0' },
        capabilities: null
      })
    );
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    proc.stdin.write(
      jsonRpcRequest('thread/read', requestId, { threadId: context.providerSessionRef, includeTurns: true })
    );

    let pendingRead = reader.read();
    while (Date.now() < timeoutAt) {
      const chunk = await Promise.race([
        pendingRead,
        new Promise<{ done: false; value?: undefined; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ done: false, timedOut: true }), 50)
        )
      ]);
      if ('timedOut' in chunk) {
        const result = consumeBufferedRecords();
        if (result !== undefined) return result;
        continue;
      }
      if (chunk.done) {
        const result = consumeBufferedRecords();
        if (result !== undefined) return result;
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
      pendingRead = reader.read();
    }
    const result = consumeBufferedRecords();
    if (result !== undefined) return result;
  } catch {
    return null;
  } finally {
    proc.kill();
  }
  return null;
}

export async function readCodexEventOutput(
  context: MeshAgentProviderEventContext,
  options: CodexHistoryEnvironment | CodexHistoryReadOptions = {}
): Promise<string | null> {
  const resolved = parseCodexReadOptions(options);
  const appServerOutput = codexThreadReadOutput(await readCodexAppServerThread(context, resolved));
  if (appServerOutput) return appServerOutput;
  return readCodexEventFileOutput(context, resolved.env ?? process.env);
}

export function codexEventPageOutput(context: MeshAgentProviderEventPageContext): string | null {
  const records = context.page.items.filter((item) => recordValue(item));
  if (records.length === 0) return null;
  return records.map((record) => JSON.stringify(record)).join('\n');
}

export function buildCodexInitialTurnsPage(): Record<string, unknown> {
  return {
    limit: 20,
    sortDirection: 'desc',
    itemsView: 'summary'
  };
}
