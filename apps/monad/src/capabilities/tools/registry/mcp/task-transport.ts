import type { FetchLike, JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/client';

import { z } from 'zod';

import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_PROTOCOL_VERSION_META_KEY,
  type McpTask,
  TASK_RESULT_BRIDGE_META_KEY,
  taskSchema,
  tasksClientCapabilities
} from './task-contract.ts';

export interface TaskCapableTransport extends Transport {
  requestTask<T>(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: { meta?: Record<string, unknown>; signal?: AbortSignal; timeout?: number }
  ): Promise<T>;
  listenForTask(taskId: string, meta: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  waitForTaskUpdate(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<McpTask | undefined>;
}

export class McpTaskRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'McpTaskRpcError';
  }
}

export function withTaskRoutingHeaders(fetcher: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    const request = new Request(input.toString(), init);
    if (request.method !== 'POST') return fetcher(input, init);
    try {
      const body = (await request.clone().json()) as {
        method?: unknown;
        params?: { taskId?: unknown };
      };
      if (
        typeof body.method === 'string' &&
        body.method.startsWith('tasks/') &&
        typeof body.params?.taskId === 'string'
      ) {
        const headers = new Headers(request.headers);
        headers.set('mcp-name', body.params.taskId);
        return fetcher(input, { ...init, headers });
      }
    } catch {}
    return fetcher(input, init);
  };
}

export function withTaskResultBridge(
  transport: Transport,
  options: { taskSubscriptions?: boolean } = {}
): TaskCapableTransport {
  return new TaskResultBridge(transport, options.taskSubscriptions ?? false);
}

class TaskResultBridge implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private requestId = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }
  >();
  private readonly taskUpdates = new Map<string, McpTask>();
  private readonly taskWaiters = new Map<string, Set<(task: McpTask) => void>>();
  private readonly subscriptionIds = new Set<string>();

  constructor(
    private readonly transport: Transport,
    private readonly taskSubscriptions: boolean
  ) {}

  get hasPerRequestStream(): boolean | undefined {
    return this.transport.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async start(): Promise<void> {
    this.transport.onclose = () => {
      this.rejectPending(new Error('MCP transport closed'));
      this.onclose?.();
    };
    this.transport.onerror = (error) => {
      this.rejectPending(error);
      this.onerror?.(error);
    };
    this.transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'notifications/tasks') {
        const update = taskSchema.safeParse({ ...message.params, resultType: 'complete' });
        if (update.success) this.publishTaskUpdate(update.data);
        return;
      }
      if ('id' in message && typeof message.id === 'string') {
        if (this.subscriptionIds.delete(message.id)) return;
        const pending = this.pending.get(message.id);
        if (pending && ('result' in message || 'error' in message)) {
          this.pending.delete(message.id);
          if ('error' in message) {
            pending.reject(new McpTaskRpcError(message.error.message, message.error.code, message.error.data));
          } else pending.resolve(message.result);
          return;
        }
      }
      this.onmessage?.(bridgeTaskResult(message), extra);
    };
    await this.transport.start();
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void> {
    return this.transport.send(message, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  async requestTask<T>(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: { meta?: Record<string, unknown>; signal?: AbortSignal; timeout?: number }
  ): Promise<T> {
    if (options.signal?.aborted) throw taskAbortError(options.signal);
    const id = `monad-task-${++this.requestId}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const timeout = setTimeout(() => {
      this.pending.get(id)?.reject(new Error(`${method} timed out`));
      this.pending.delete(id);
    }, options.timeout ?? 30_000);
    const onAbort = () => {
      this.pending.get(id)?.reject(taskAbortError(options.signal));
      this.pending.delete(id);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.transport.send(
        {
          jsonrpc: '2.0',
          id,
          method,
          params: {
            ...params,
            _meta: {
              ...(options.meta ?? {}),
              [MCP_PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [MCP_CLIENT_CAPABILITIES_META_KEY]: {
                extensions: tasksClientCapabilities()
              }
            }
          }
        },
        { requestSignal: options.signal }
      );
      return schema.parse(await response);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      this.pending.delete(id);
    }
  }

  async listenForTask(taskId: string, meta: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    if (!this.taskSubscriptions) return;
    if (signal?.aborted) throw taskAbortError(signal);
    const id = `monad-task-listen-${++this.requestId}`;
    this.subscriptionIds.add(id);
    const cleanup = setTimeout(() => this.subscriptionIds.delete(id), 120_000);
    cleanup.unref();
    try {
      await this.transport.send(
        {
          jsonrpc: '2.0',
          id,
          method: 'subscriptions/listen',
          params: {
            notifications: { taskIds: [taskId] },
            _meta: {
              ...meta,
              [MCP_PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [MCP_CLIENT_CAPABILITIES_META_KEY]: {
                extensions: tasksClientCapabilities()
              }
            }
          }
        },
        { requestSignal: signal }
      );
    } catch (error) {
      this.subscriptionIds.delete(id);
      throw error;
    }
  }

  async waitForTaskUpdate(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<McpTask | undefined> {
    const queued = this.taskUpdates.get(taskId);
    if (queued) {
      this.taskUpdates.delete(taskId);
      return queued;
    }
    if (signal?.aborted) throw taskAbortError(signal);
    return new Promise<McpTask | undefined>((resolve, reject) => {
      const waiters = this.taskWaiters.get(taskId) ?? new Set();
      const finish = (task: McpTask | undefined) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(onTask);
        if (!waiters.size) this.taskWaiters.delete(taskId);
        resolve(task);
      };
      const onTask = (task: McpTask) => finish(task);
      const onAbort = () => {
        clearTimeout(timer);
        waiters.delete(onTask);
        if (!waiters.size) this.taskWaiters.delete(taskId);
        reject(taskAbortError(signal));
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      waiters.add(onTask);
      this.taskWaiters.set(taskId, waiters);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private publishTaskUpdate(task: McpTask): void {
    const waiters = this.taskWaiters.get(task.taskId);
    if (!waiters?.size) {
      this.taskUpdates.set(task.taskId, task);
      return;
    }
    for (const waiter of [...waiters]) waiter(task);
  }
}

function bridgeTaskResult<T extends JSONRPCMessage>(message: T): T {
  if (!('result' in message) || !message.result || typeof message.result !== 'object') return message;
  const result = message.result as Record<string, unknown>;
  if (result.resultType !== 'task') return message;
  return {
    ...message,
    result: {
      resultType: 'complete',
      content: [],
      _meta: { [TASK_RESULT_BRIDGE_META_KEY]: result }
    }
  } as T;
}

function taskAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('MCP task cancelled', 'AbortError');
}
