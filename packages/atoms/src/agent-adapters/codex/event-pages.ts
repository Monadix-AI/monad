import type {
  MeshAgentEventSource,
  MeshAgentProviderEventPageContext,
  MeshAgentProviderEventPageRequestContext
} from '@monad/sdk-atom';

import { resolveBinary } from '@monad/sdk-atom';

import { createProjectedEventSource } from '../shared/events/event-source.ts';
import { jsonRpcRequest } from '../shared/transports/jsonrpc.ts';
import { recordValue } from './app-server/events.ts';
import { CODEX_APP_BIN } from './launch.ts';
import { codexObservationProjection } from './observation/index.ts';
import { codexProviderSessionUnavailable } from './provider-session-error.ts';

type CodexHistoryEnvironment = Record<string, string | undefined>;

interface CodexHistoryProcess {
  stdin: { write(chunk: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

type CodexHistorySpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'ignore';
  }
) => CodexHistoryProcess;

interface CodexTurnsPageResponseLike {
  data?: unknown;
  nextCursor?: unknown;
  [key: string]: unknown;
}

type CodexTurnsPageRead = (
  context: MeshAgentProviderEventPageRequestContext
) => CodexTurnsPageResponseLike | Promise<CodexTurnsPageResponseLike>;

interface CodexEventPageOptions {
  command?: string;
  env?: CodexHistoryEnvironment;
  pageRead?: CodexTurnsPageRead;
  spawn?: CodexHistorySpawn;
  timeoutMs?: number;
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

function normalizeTurnsPage(response: CodexTurnsPageResponseLike): MeshAgentProviderEventPageContext['page'] {
  if (!Array.isArray(response.data) || response.data.some((turn) => !recordValue(turn))) {
    throw new Error('Codex thread/turns/list returned malformed turn data');
  }
  const nextCursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined;
  return {
    items: [...response.data].reverse(),
    ...(nextCursor ? { nextCursor } : {})
  };
}

function jsonRpcErrorMessage(error: Record<string, unknown>): string {
  const message = typeof error.message === 'string' ? error.message : 'unknown error';
  const code = typeof error.code === 'string' || typeof error.code === 'number' ? ` (${error.code})` : '';
  return `${message}${code}`;
}

function codexEventPageUnavailableReason(error: unknown): 'not-found' | 'temporary' {
  return codexProviderSessionUnavailable(error) ? 'not-found' : 'temporary';
}

async function requestCodexTurnsPage(
  context: MeshAgentProviderEventPageRequestContext,
  options: CodexEventPageOptions
): Promise<CodexTurnsPageResponseLike> {
  if (options.pageRead) return options.pageRead(context);
  const command = options.command ?? resolveBinary('codex', [CODEX_APP_BIN]);
  if (!command) throw new Error('Codex CLI is unavailable');
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn([command, 'app-server', '--stdio'], {
    cwd: context.workingPath,
    env: { ...process.env, ...(options.env ?? {}), ...(context.env ?? {}) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const requestId = 2;
  let output = '';
  const timeoutAt = Date.now() + (options.timeoutMs ?? 5000);
  const consumeBufferedRecords = (): CodexTurnsPageResponseLike | undefined => {
    const record = extractJsonRpcResponse(output, requestId);
    if (record === undefined) return undefined;
    if (record === null) throw new Error('Codex thread/turns/list returned malformed JSON-RPC');
    const error = recordValue(record.error);
    if (error) throw new Error(`Codex thread/turns/list failed: ${jsonRpcErrorMessage(error)}`);
    const result = recordValue(record.result);
    if (!result) throw new Error('Codex thread/turns/list returned no result');
    return result;
  };

  try {
    proc.stdin.write(
      jsonRpcRequest('initialize', 1, {
        clientInfo: { name: 'monad', version: '0' },
        capabilities: { experimentalApi: true }
      })
    );
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    proc.stdin.write(
      jsonRpcRequest('thread/turns/list', requestId, {
        threadId: context.providerSessionRef,
        ...(context.request.before ? { cursor: context.request.before } : {}),
        limit: context.request.limit,
        sortDirection: context.request.sortDirection,
        itemsView: context.request.itemsView
      })
    );

    let pendingRead = reader.read();
    while (Date.now() < timeoutAt) {
      const chunk = await Promise.race([
        pendingRead,
        new Promise<{ done: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ done: false, timedOut: true }), 50)
        )
      ]);
      if ('timedOut' in chunk) {
        const result = consumeBufferedRecords();
        if (result) return result;
        continue;
      }
      if (chunk.done) {
        const result = consumeBufferedRecords();
        if (result) return result;
        throw new Error('Codex app-server exited before thread/turns/list responded');
      }
      output += decoder.decode(chunk.value, { stream: true });
      pendingRead = reader.read();
    }
    const result = consumeBufferedRecords();
    if (result) return result;
    throw new Error('Codex thread/turns/list timed out');
  } finally {
    proc.kill();
  }
}

export async function readCodexEventPage(
  context: MeshAgentProviderEventPageRequestContext,
  options: CodexEventPageOptions = {}
): Promise<MeshAgentProviderEventPageContext['page']> {
  return normalizeTurnsPage(await requestCodexTurnsPage(context, options));
}

export function codexEventPageOutput(context: MeshAgentProviderEventPageContext): string | null {
  const records = context.page.items.filter((item) => recordValue(item));
  if (records.length === 0) return null;
  return records.map((record) => JSON.stringify(record)).join('\n');
}

export function createCodexEventSource(options: CodexEventPageOptions = {}): MeshAgentEventSource {
  const source = createProjectedEventSource({
    provider: 'codex',
    projection: codexObservationProjection
  });
  return {
    ...source,
    readPage: async (context, request) => {
      let page: MeshAgentProviderEventPageContext['page'];
      try {
        page = await readCodexEventPage(
          {
            ...context,
            request: {
              ...(request.before ? { before: request.before } : {}),
              limit: request.limit,
              sortDirection: 'desc',
              itemsView: 'full'
            }
          },
          options
        );
      } catch (error) {
        return { state: 'unavailable', reason: codexEventPageUnavailableReason(error) };
      }
      if (request.view === 'raw') {
        return {
          state: 'available',
          view: 'raw',
          records: page.items.map((data, index) => {
            const providerIdentity = String(recordValue(data)?.id ?? `${request.before ?? 'latest'}:${index}`);
            return { data, cursor: providerIdentity, providerIdentity };
          }),
          coverage: 'settled',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      }
      const output = codexEventPageOutput({ ...context, page });
      return {
        state: 'available',
        view: 'convenience',
        events: output ? source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events : [],
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  };
}
