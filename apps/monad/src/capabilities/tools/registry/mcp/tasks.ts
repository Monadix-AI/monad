import type { CallToolResult, Client, RequestOptions } from '@modelcontextprotocol/client';
import type { ToolContext } from '../../types.ts';
import type { McpTaskJournal, PersistedMcpTask } from './task-journal.ts';

import { createLogger } from '@monad/logger';

import { type ElicitationOptions, fulfillElicitationRequests } from './elicitation.ts';
import {
  callToolResultSchema,
  completeResultSchema,
  type McpTask,
  RELATED_TASK_META_KEY,
  TASK_RESULT_BRIDGE_META_KEY,
  taskSchema,
  toolExchangeSchema
} from './task-contract.ts';
import { acquireTaskSlot, recordTaskOutcome } from './task-runtime.ts';
import { McpTaskRpcError, type TaskCapableTransport } from './task-transport.ts';

const log = createLogger('mcp-tasks');
const TASK_SUBSCRIPTION_REFRESH_MS = 60_000;

export type { TaskCapableTransport } from './task-transport.ts';

export {
  MCP_INVOCATION_ID_META_KEY,
  MCP_TASKS_EXTENSION,
  serverSupportsTasks,
  tasksClientCapabilities
} from './task-contract.ts';
export { withTaskResultBridge, withTaskRoutingHeaders } from './task-transport.ts';

export async function callToolWithTasks(options: {
  client: Client;
  name: string;
  args: unknown;
  ctx?: ToolContext;
  meta: Record<string, unknown>;
  requestOptions: RequestOptions;
  serverName: string;
  taskTransport: TaskCapableTransport;
  taskJournal?: McpTaskJournal;
  registerUrlCompletion?: ElicitationOptions['registerUrlCompletion'];
  withRequestContext?<T>(run: () => Promise<T>): Promise<T>;
}): Promise<CallToolResult> {
  const params: Record<string, unknown> = {
    name: options.name,
    arguments: (options.args ?? {}) as Record<string, unknown>,
    _meta: options.meta
  };
  let rounds = 0;
  while (true) {
    rounds += 1;
    if (rounds > 12) throw new Error(`MCP tool "${options.name}" exceeded 12 input-required rounds`);
    const request = () =>
      options.client.request({ method: 'tools/call', params }, toolExchangeSchema, {
        ...options.requestOptions,
        allowInputRequired: true
      });
    const result = await (options.withRequestContext ? options.withRequestContext(request) : request());
    const resultMeta = (result as { _meta?: Record<string, unknown> })._meta;
    const bridgedTask = taskSchema.safeParse(resultMeta?.[TASK_RESULT_BRIDGE_META_KEY]);
    if (bridgedTask.success) {
      return driveTask(
        options.taskTransport,
        bridgedTask.data,
        options.ctx,
        options.meta,
        options.requestOptions,
        options.serverName,
        options.name,
        options.taskJournal,
        options.registerUrlCompletion
      );
    }
    if (result.resultType === 'task') {
      return driveTask(
        options.taskTransport,
        result,
        options.ctx,
        options.meta,
        options.requestOptions,
        options.serverName,
        options.name,
        options.taskJournal,
        options.registerUrlCompletion
      );
    }
    if (result.resultType !== 'input_required') return result as CallToolResult;
    const inputResponses = await fulfillElicitationRequests(result.inputRequests, options.ctx?.ask, {
      serverName: options.serverName,
      resolveClarification: options.ctx?.resolveClarification,
      registerUrlCompletion: options.registerUrlCompletion
    });
    Object.assign(params, {
      ...(inputResponses ? { inputResponses } : {}),
      ...(result.requestState !== undefined ? { requestState: result.requestState } : {})
    });
  }
}

async function driveTask(
  transport: TaskCapableTransport,
  initial: McpTask,
  ctx: ToolContext | undefined,
  meta: Record<string, unknown>,
  requestOptions: RequestOptions,
  serverName: string,
  toolName: string,
  journal: McpTaskJournal | undefined,
  registerUrlCompletion: ElicitationOptions['registerUrlCompletion']
): Promise<CallToolResult> {
  const release = await acquireTaskSlot(serverName, requestOptions.signal);
  const startedAt = Date.now();
  let task = initial;
  const fulfilled = new Set<string>();
  let lastSubscriptionAt = 0;
  let outcome: 'cancelled' | 'completed' | 'failed' = 'failed';
  const deadline =
    typeof requestOptions.maxTotalTimeout === 'number' ? Date.now() + requestOptions.maxTotalTimeout : undefined;
  try {
    while (true) {
      if (Date.now() - lastSubscriptionAt >= TASK_SUBSCRIPTION_REFRESH_MS) {
        await transport.listenForTask(task.taskId, meta, requestOptions.signal).catch(() => {});
        lastSubscriptionAt = Date.now();
      }
      await persistTask(journal, serverName, toolName, task, ctx);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`MCP task ${task.taskId} exceeded its total timeout`);
      }
      if (task.ttlMs !== null && Date.now() >= Date.parse(task.createdAt) + task.ttlMs) {
        throw new Error(`MCP task ${task.taskId} exceeded its server TTL`);
      }
      ctx?.reportProgress?.(
        JSON.stringify({
          type: 'mcp_task',
          server: serverName,
          tool: toolName,
          taskId: task.taskId,
          status: task.status,
          statusMessage: task.statusMessage,
          createdAt: task.createdAt,
          lastUpdatedAt: task.lastUpdatedAt,
          pollIntervalMs: task.pollIntervalMs
        })
      );
      if (task.status === 'completed') {
        const result = callToolResultSchema.parse(task.result);
        outcome = 'completed';
        return {
          ...(result as CallToolResult),
          _meta: {
            ...(result._meta ?? {}),
            [RELATED_TASK_META_KEY]: { taskId: task.taskId }
          }
        };
      }
      if (task.status === 'failed') {
        const message = typeof task.error?.message === 'string' ? task.error.message : task.statusMessage;
        throw new Error(message ?? `MCP task ${task.taskId} failed`);
      }
      if (task.status === 'cancelled') {
        outcome = 'cancelled';
        throw new Error(`MCP task ${task.taskId} was cancelled`);
      }
      if (task.status === 'input_required' && task.inputRequests) {
        const pending = Object.fromEntries(Object.entries(task.inputRequests).filter(([key]) => !fulfilled.has(key)));
        if (Object.keys(pending).length) {
          const inputResponses = await fulfillElicitationRequests(pending, ctx?.ask, {
            serverName,
            resolveClarification: ctx?.resolveClarification,
            registerUrlCompletion
          });
          if (inputResponses) {
            await transport.requestTask('tasks/update', { taskId: task.taskId, inputResponses }, completeResultSchema, {
              meta,
              signal: requestOptions.signal,
              timeout: requestOptions.timeout
            });
            for (const key of Object.keys(inputResponses)) fulfilled.add(key);
          }
        }
      }
      const waitMs = Math.min(Math.max(task.pollIntervalMs ?? 1_000, 250), 30_000);
      const pushed = await transport.waitForTaskUpdate(task.taskId, waitMs, requestOptions.signal);
      task = pushed ?? (await getTaskWithRetry(transport, task.taskId, meta, requestOptions, ctx, serverName));
    }
  } catch (error) {
    if (requestOptions.signal?.aborted) {
      outcome = 'cancelled';
      await journal?.markCancelRequested(task.taskId);
      await transport
        .requestTask('tasks/cancel', { taskId: task.taskId }, completeResultSchema, { meta, timeout: 5_000 })
        .catch(() => {});
    }
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    recordTaskOutcome(serverName, outcome, durationMs);
    log.info({ durationMs, outcome, server: serverName, taskId: task.taskId, tool: toolName }, 'mcp task settled');
    release();
  }
}

export async function resumeTaskJournal(
  transport: TaskCapableTransport,
  journal: McpTaskJournal,
  serverName: string,
  signal: AbortSignal
): Promise<void> {
  const tasks = await journal.list();
  const active = tasks.filter(
    (task) => task.server === serverName && (task.status === 'working' || task.status === 'input_required')
  );
  await Promise.allSettled(
    active.map(async (persisted) => {
      if (persisted.expiresAt && Date.parse(persisted.expiresAt) <= Date.now()) {
        await journal.upsert({
          ...persisted,
          status: 'failed',
          statusMessage: 'The remote MCP Task expired before recovery',
          lastUpdatedAt: new Date().toISOString(),
          observedAt: new Date().toISOString()
        });
        return;
      }
      if (persisted.cancelRequestedAt) {
        await transport.requestTask('tasks/cancel', { taskId: persisted.taskId }, completeResultSchema, {
          signal,
          timeout: 30_000
        });
        await journal.upsert({
          ...persisted,
          status: 'cancelled',
          statusMessage: persisted.statusMessage ?? 'Cancellation acknowledged',
          lastUpdatedAt: new Date().toISOString(),
          observedAt: new Date().toISOString()
        });
        return;
      }
      await transport.listenForTask(persisted.taskId, {}, signal).catch(() => {});
      let task = await getTaskWithRetry(
        transport,
        persisted.taskId,
        {},
        { signal, timeout: 30_000 },
        undefined,
        serverName
      );
      while (!signal.aborted) {
        await persistTask(journal, persisted.server, persisted.toolName, task, {
          sessionId: persisted.sessionId ?? '',
          toolCallId: persisted.toolCallId
        });
        if (task.status !== 'working') {
          const recoveredAt = new Date().toISOString();
          const current = (await journal.list()).find((entry) => entry.taskId === task.taskId);
          if (current && !current.deliveryPending) {
            await journal.upsert({ ...current, recoveredAt, deliveryPending: true });
            recordTaskOutcome(serverName, 'recovered');
          }
          log.info(
            { server: serverName, status: task.status, taskId: task.taskId, tool: persisted.toolName },
            'mcp task recovery observed'
          );
          return;
        }
        await abortableDelay(Math.min(Math.max(task.pollIntervalMs ?? 1_000, 250), 5_000), signal);
        task = await getTaskWithRetry(transport, task.taskId, {}, { signal, timeout: 30_000 }, undefined, serverName);
      }
    })
  );
}

export async function observeJournalTask(options: {
  transport: TaskCapableTransport;
  journal: McpTaskJournal;
  serverName: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<PersistedMcpTask> {
  const persisted = (await options.journal.list()).find(
    (task) => task.server === options.serverName && task.taskId === options.taskId
  );
  if (!persisted) throw new Error(`MCP task ${options.taskId} was not found for ${options.serverName}`);
  const task = await options.transport.requestTask('tasks/get', { taskId: options.taskId }, taskSchema, {
    signal: options.signal,
    timeout: 30_000
  });
  await persistTask(options.journal, persisted.server, persisted.toolName, task, {
    sessionId: persisted.sessionId ?? '',
    toolCallId: persisted.toolCallId
  });
  const current = (await options.journal.list()).find((entry) => entry.taskId === options.taskId);
  if (!current) throw new Error(`MCP task ${options.taskId} disappeared from its journal`);
  return current;
}

export async function cancelJournalTask(options: {
  transport: TaskCapableTransport;
  journal: McpTaskJournal;
  serverName: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<PersistedMcpTask> {
  const persisted = (await options.journal.list()).find(
    (task) => task.server === options.serverName && task.taskId === options.taskId
  );
  if (!persisted) throw new Error(`MCP task ${options.taskId} was not found for ${options.serverName}`);
  await options.journal.markCancelRequested(options.taskId);
  await options.transport.requestTask('tasks/cancel', { taskId: options.taskId }, completeResultSchema, {
    signal: options.signal,
    timeout: 30_000
  });
  return observeJournalTask(options);
}

async function persistTask(
  journal: McpTaskJournal | undefined,
  server: string,
  toolName: string,
  task: McpTask,
  ctx: Pick<ToolContext, 'sessionId' | 'toolCallId'> | undefined
): Promise<void> {
  if (!journal) return;
  const entry: PersistedMcpTask = {
    server,
    taskId: task.taskId,
    toolName,
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    observedAt: new Date().toISOString(),
    ttlMs: task.ttlMs,
    ...(task.ttlMs === null ? {} : { expiresAt: new Date(Date.parse(task.createdAt) + task.ttlMs).toISOString() }),
    ...(task.inputRequests ? { inputRequests: task.inputRequests } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {})
  };
  await journal.upsert(entry);
}

async function getTaskWithRetry(
  transport: TaskCapableTransport,
  taskId: string,
  meta: Record<string, unknown>,
  requestOptions: RequestOptions,
  ctx: ToolContext | undefined,
  serverName: string
): Promise<McpTask> {
  let delay = 250;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transport.requestTask('tasks/get', { taskId }, taskSchema, {
        meta,
        signal: requestOptions.signal,
        timeout: requestOptions.timeout
      });
    } catch (error) {
      if (!isRetriableTaskError(error) || attempt >= 6) throw error;
      recordTaskOutcome(serverName, 'retry');
      ctx?.reportProgress?.(`MCP task ${taskId}: reconnecting after a transient error`);
      await abortableDelay(delay / 2 + Math.random() * (delay / 2), requestOptions.signal);
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

function isRetriableTaskError(error: unknown): boolean {
  if (error instanceof McpTaskRpcError) return error.code === -32603 || error.code === -32000;
  return !(error instanceof DOMException && error.name === 'AbortError');
}

function _abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('MCP task cancelled', 'AbortError');
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
