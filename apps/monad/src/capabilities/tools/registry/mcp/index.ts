import type {
  AuthProvider,
  CallToolResult,
  ElicitRequest,
  Tool as McpToolDefinition
} from '@modelcontextprotocol/client';
import type { Tool, ToolContext, ToolDisplayContent, ToolInputSchema } from '../../types.ts';
import type { McpTaskJournal, PersistedMcpTask } from './task-journal.ts';

import {
  BAGGAGE_META_KEY,
  Client,
  StreamableHTTPClientTransport,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY
} from '@modelcontextprotocol/client';
import { createLogger } from '@monad/logger';
import { context, propagation } from '@opentelemetry/api';
import { z } from 'zod';

import { toolResult } from '../../types.ts';
import {
  McpAppBridgeError,
  mcpAppBridgeMetrics,
  registerMcpAppBridge,
  revokeMcpAppBridgesForServer
} from './app-bridge.ts';
import { McpAppResourceCache, mcpAppResourceUri } from './app-resource-cache.ts';
import { watchMcpTransport } from './connection-watch.ts';
import { fulfillElicitation } from './elicitation.ts';
import { mcpToModelOutput, normalizeMcpResult } from './result.ts';
import { mcpRuntimeTelemetrySnapshot } from './runtime-telemetry.ts';

export { normalizeMcpResult } from './result.ts';

export function getMcpRuntimeMetrics() {
  return { ...mcpAppBridgeMetrics(), ...mcpRuntimeTelemetrySnapshot() };
}

import { compileMcpInputSchema } from './schema-validator.ts';
import { SupervisedStdioTransport } from './supervised-stdio-transport.ts';
import { recordTaskDeliveryAcknowledged, setPendingTaskDeliveries } from './task-runtime.ts';
import {
  callToolWithTasks,
  cancelJournalTask,
  MCP_INVOCATION_ID_META_KEY,
  MCP_TASKS_EXTENSION,
  observeJournalTask,
  resumeTaskJournal,
  serverSupportsTasks,
  type TaskCapableTransport,
  tasksClientCapabilities,
  withTaskResultBridge,
  withTaskRoutingHeaders
} from './tasks.ts';

const log = createLogger('mcp');
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function mcpToolName(server: string, tool: string): string {
  return sanitizeToolName(`${server}__${tool}`);
}

interface McpStdioSpec {
  name: string;
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
  taskJournal?: McpTaskJournal;
}

export interface McpHttpAuth {
  getHeader(): Promise<string | undefined>;
  onUnauthorized?(): Promise<boolean>;
}

interface McpHttpSpec {
  name: string;
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: McpHttpAuth;
  requestTimeoutMs?: number;
  taskJournal?: McpTaskJournal;
}

export type McpServerSpec = McpStdioSpec | McpHttpSpec;

export interface McpConnection {
  failure?: string;
  name: string;
  protocolEra?: string;
  protocolVersion?: string;
  tools: Tool[];
  callTool(name: string, args: unknown): Promise<unknown>;
  onDisconnect?(listener: (reason: string) => void): () => void;
  onToolsChanged?(listener: (tools: Tool[]) => void): () => void;
  tasks?: {
    list(): Promise<PersistedMcpTask[]>;
    pendingDeliveries(): Promise<PersistedMcpTask[]>;
    observe(taskId: string, signal?: AbortSignal): Promise<PersistedMcpTask>;
    cancel(taskId: string, signal?: AbortSignal): Promise<PersistedMcpTask>;
    acknowledgeDelivery(taskId: string, recoveredAt: string): Promise<boolean>;
  };
  close(): Promise<void>;
}

class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

const passthroughSchema: ToolInputSchema<Record<string, unknown>> = {
  safeParse: (input) =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? { success: true, data: input as Record<string, unknown> }
      : { success: false, error: new McpError('tool input must be an object') }
};

function clientFor(
  spec: McpServerSpec,
  onToolsChanged: (tools: McpToolDefinition[]) => void,
  onResourcesChanged: () => void
): Client {
  return new Client(
    { name: 'monad', version: '0.0.0' },
    {
      capabilities: {
        elicitation: { form: {}, url: {} },
        extensions: {
          ...tasksClientCapabilities(),
          [MCP_UI_EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] }
        }
      },
      inputRequired: { autoFulfill: true, maxRounds: 12 },
      defaultCacheTtlMs: 30_000,
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) log.warn({ err: error, server: spec.name }, 'mcp tool list refresh failed');
            else {
              log.debug({ server: spec.name, tools: tools?.length ?? 0 }, 'mcp tool list refreshed');
              onToolsChanged(tools ?? []);
            }
          }
        },
        resources: {
          onChanged: (error, resources) => {
            if (error) log.warn({ err: error, server: spec.name }, 'mcp resource list refresh failed');
            else {
              log.debug({ resources: resources?.length ?? 0, server: spec.name }, 'mcp resource list refreshed');
              onResourcesChanged();
            }
          }
        }
      },
      versionNegotiation: {
        mode: 'auto',
        probe: { timeoutMs: spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
      }
    }
  );
}

function schemaFor(remote: McpToolDefinition): ToolInputSchema<Record<string, unknown>> {
  const json = remote.inputSchema as Record<string, unknown> | undefined;
  const compiled = json ? compileMcpInputSchema(json) : undefined;
  return {
    safeParse: (input) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { success: false, error: new McpError('tool input must be an object') };
      }
      if (compiled?.error) {
        return { success: false, error: new McpError(`invalid MCP tool input schema: ${compiled.error}`) };
      }
      const result = compiled?.validate?.(input);
      return result && !result.valid
        ? { success: false, error: new McpError(`invalid MCP tool input: ${result.errorMessage}`) }
        : { success: true, data: input as Record<string, unknown> };
    },
    ...(json ? { toJsonSchema: () => json } : {})
  };
}

function traceMeta(ctx?: ToolContext): Record<string, unknown> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(ctx?.toolCallId ? { [MCP_INVOCATION_ID_META_KEY]: ctx.toolCallId } : {}),
    ...(carrier.traceparent ? { [TRACEPARENT_META_KEY]: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { [TRACESTATE_META_KEY]: carrier.tracestate } : {}),
    ...(carrier.baggage ? { [BAGGAGE_META_KEY]: carrier.baggage } : {})
  };
}

export { mcpAppResourceUri } from './app-resource-cache.ts';

export function mcpToolVisibleToModel(remote: McpToolDefinition): boolean {
  const ui = remote._meta?.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return true;
  const visibility = (ui as Record<string, unknown>).visibility;
  return !Array.isArray(visibility) || visibility.includes('model');
}

export function mcpToolVisibleToApp(remote: McpToolDefinition): boolean {
  const ui = remote._meta?.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return true;
  const visibility = (ui as Record<string, unknown>).visibility;
  return !Array.isArray(visibility) || visibility.includes('app');
}

export function assertMcpToolVisibleToApp(remote: McpToolDefinition): void {
  if (!mcpToolVisibleToApp(remote)) {
    throw new McpAppBridgeError(`MCP App tool is not visible to apps: ${remote.name}`, 403);
  }
}

export class McpUrlCompletionRegistry {
  readonly #pending = new Map<string, () => Promise<void>>();

  register(elicitationId: string, complete: () => Promise<void>): () => void {
    this.#pending.set(elicitationId, complete);
    return () => this.#pending.delete(elicitationId);
  }

  async complete(elicitationId: string): Promise<void> {
    const pending = this.#pending.get(elicitationId);
    if (pending) {
      this.#pending.delete(elicitationId);
      await pending();
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7) : header;
}

function httpAuth(spec: McpHttpSpec): AuthProvider | undefined {
  if (!spec.auth) return undefined;
  return {
    token: async () => bearerToken(await spec.auth?.getHeader()),
    async onUnauthorized() {
      if (!(await spec.auth?.onUnauthorized?.())) {
        throw new McpError(`MCP HTTP server returned 401 Unauthorized — check auth for ${spec.url}`);
      }
    }
  };
}

function transportFor(spec: McpServerSpec): TaskCapableTransport {
  if (spec.transport === 'http') {
    return withTaskResultBridge(
      new StreamableHTTPClientTransport(new URL(spec.url), {
        authProvider: httpAuth(spec),
        requestInit: { headers: spec.headers },
        fetch: withTaskRoutingHeaders()
      }),
      { taskSubscriptions: true }
    );
  }
  return withTaskResultBridge(
    new SupervisedStdioTransport({
      name: spec.name,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd
    }),
    { taskSubscriptions: true }
  );
}

export async function connectMcpServer(spec: McpServerSpec): Promise<McpConnection> {
  const timeout = spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let applyToolList = async (_tools: McpToolDefinition[]): Promise<void> => {};
  let refreshAppResources = async (_uri?: string): Promise<void> => {};
  const client = clientFor(
    spec,
    (tools) => {
      void applyToolList(tools).catch((error) => {
        log.warn({ err: error, server: spec.name }, 'mcp dynamic tool refresh failed');
      });
    },
    () => {
      void refreshAppResources().catch((error) => {
        log.warn({ err: error, server: spec.name }, 'mcp app resource refresh failed');
      });
    }
  );
  const transport = transportFor(spec);
  const connectionAbort = new AbortController();
  const urlCompletions = new McpUrlCompletionRegistry();
  let activeContext: ToolContext | undefined;
  let activeProgress: ((progress: { message?: string; progress: number; total?: number }) => void) | undefined;
  let callQueue = Promise.resolve();
  const withCallContext = async <T>(
    ctx: ToolContext | undefined,
    run: () => Promise<T>,
    onProgress?: (progress: { message?: string; progress: number; total?: number }) => void
  ): Promise<T> => {
    let release: () => void = () => {};
    const previous = callQueue;
    callQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    activeContext = ctx;
    activeProgress = onProgress;
    try {
      return await run();
    } finally {
      activeContext = undefined;
      activeProgress = undefined;
      release();
    }
  };
  client.setRequestHandler('elicitation/create', async (request: ElicitRequest) => {
    const active = activeContext;
    const params = request.params;
    return fulfillElicitation(params as unknown as Record<string, unknown>, active?.ask, {
      serverName: spec.name,
      resolveClarification: active?.resolveClarification,
      registerUrlCompletion: (elicitationId, complete) => urlCompletions.register(elicitationId, complete)
    });
  });
  client.setNotificationHandler(
    'notifications/elicitation/complete',
    { params: z.object({ elicitationId: z.string().min(1) }) },
    async ({ elicitationId }) => urlCompletions.complete(elicitationId)
  );

  try {
    await client.connect(transport, { timeout });
    const listed = await client.listTools(undefined, { timeout });
    const remoteTools = listed.tools;
    const remoteDefinitions = new Map<string, McpToolDefinition>();
    const remoteInputSchemas = new Map<string, ToolInputSchema<Record<string, unknown>>>();
    const appResources = new McpAppResourceCache(client, spec.name, timeout, connectionAbort.signal, () =>
      remoteDefinitions.values()
    );
    if (spec.taskJournal) {
      setPendingTaskDeliveries(spec.name, (await spec.taskJournal.pendingDeliveries()).length);
    }

    log.debug(
      {
        era: client.getProtocolEra(),
        protocolVersion: client.getNegotiatedProtocolVersion(),
        server: spec.name,
        tools: remoteTools.length,
        transport: spec.transport ?? 'stdio'
      },
      'mcp connected'
    );

    const callRemoteTool = async (
      name: string,
      args: unknown,
      ctx?: ToolContext,
      definition?: McpToolDefinition
    ): Promise<CallToolResult> => {
      const t0 = Date.now();
      log.debug({ server: spec.name, tool: name }, `→ ${spec.name}/${name}`);
      let result: CallToolResult;
      try {
        let progressText = '';
        const reportProgress = (progress: { message?: string; progress: number; total?: number }) => {
          const message = typeof progress.message === 'string' ? progress.message : undefined;
          const next =
            message ?? `${name}: ${progress.progress}${progress.total !== undefined ? `/${progress.total}` : ''}`;
          if (next === progressText) return;
          progressText = next;
          ctx?.reportProgress?.(next);
        };
        const requestOptions = {
          timeout,
          maxTotalTimeout: Math.max(timeout, 15 * 60_000),
          resetTimeoutOnProgress: true,
          signal: ctx?.signal,
          toolDefinition: definition,
          onprogress: reportProgress
        };
        const pendingResult = serverSupportsTasks(client)
          ? await callToolWithTasks({
              client,
              taskTransport: transport,
              name,
              args,
              ctx,
              meta: traceMeta(ctx),
              requestOptions,
              serverName: spec.name,
              taskJournal: spec.taskJournal,
              registerUrlCompletion: (elicitationId, complete) => urlCompletions.register(elicitationId, complete),
              withRequestContext: (run) => withCallContext(ctx, run, reportProgress)
            })
          : await withCallContext(
              ctx,
              () =>
                client.callTool(
                  {
                    name,
                    arguments: (args ?? {}) as Record<string, unknown>,
                    _meta: traceMeta(ctx)
                  },
                  requestOptions
                ),
              reportProgress
            );
        result = pendingResult;
      } catch (error) {
        log.warn(
          {
            durationMs: Date.now() - t0,
            err: error instanceof Error ? error.message : String(error),
            server: spec.name,
            tool: name
          },
          `← ${spec.name}/${name} error`
        );
        throw error;
      }
      if (result.isError) {
        log.warn({ durationMs: Date.now() - t0, server: spec.name, tool: name }, `← ${spec.name}/${name} tool error`);
        throw new McpError(`MCP tool "${name}" reported an error: ${JSON.stringify(result.content)}`);
      }
      log.debug({ durationMs: Date.now() - t0, server: spec.name, tool: name }, `← ${spec.name}/${name}`);
      return result;
    };

    const disconnectListeners = new Set<(reason: string) => void>();
    const toolListeners = new Set<(tools: Tool[]) => void>();
    let closing = false;
    const conn: McpConnection = {
      name: spec.name,
      protocolEra: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      tools: [],
      callTool: async (name, args) => (await callRemoteTool(name, args)).content,
      onDisconnect(listener) {
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
      onToolsChanged(listener) {
        toolListeners.add(listener);
        return () => toolListeners.delete(listener);
      },
      ...(serverSupportsTasks(client) && spec.taskJournal
        ? {
            tasks: {
              list: async () => (await spec.taskJournal?.list())?.filter((task) => task.server === spec.name) ?? [],
              pendingDeliveries: async () =>
                (await spec.taskJournal?.pendingDeliveries())?.filter((task) => task.server === spec.name) ?? [],
              observe: (taskId, signal) =>
                observeJournalTask({
                  transport,
                  journal: spec.taskJournal as McpTaskJournal,
                  serverName: spec.name,
                  taskId,
                  signal
                }),
              cancel: (taskId, signal) =>
                cancelJournalTask({
                  transport,
                  journal: spec.taskJournal as McpTaskJournal,
                  serverName: spec.name,
                  taskId,
                  signal
                }),
              acknowledgeDelivery: async (taskId, recoveredAt) => {
                const acknowledged = await (spec.taskJournal as McpTaskJournal).acknowledgeDelivery(
                  taskId,
                  recoveredAt
                );
                if (acknowledged) recordTaskDeliveryAcknowledged(spec.name);
                return acknowledged;
              }
            }
          }
        : {}),
      close: async () => {
        closing = true;
        connectionAbort.abort();
        disconnectListeners.clear();
        toolListeners.clear();
        revokeMcpAppBridgesForServer(spec.name);
        await client.close();
      }
    };

    const notifyDisconnect = (reason: string) => {
      if (closing || conn.failure) return;
      conn.failure = reason;
      connectionAbort.abort(reason);
      revokeMcpAppBridgesForServer(spec.name);
      for (const listener of disconnectListeners) listener(reason);
    };
    const protocolOnMessage = transport.onmessage;
    watchMcpTransport(transport, notifyDisconnect);
    transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'notifications/progress') {
        const params = message.params;
        if (params && typeof params === 'object' && typeof params.progress === 'number') {
          activeProgress?.({
            progress: params.progress,
            ...(typeof params.total === 'number' ? { total: params.total } : {}),
            ...(typeof params.message === 'string' ? { message: params.message } : {})
          });
        }
      }
      protocolOnMessage?.(message, extra);
      if ('method' in message && message.method === 'notifications/resources/updated') {
        const uri =
          message.params &&
          typeof message.params === 'object' &&
          'uri' in message.params &&
          typeof message.params.uri === 'string'
            ? message.params.uri
            : undefined;
        if (uri) {
          void refreshAppResources(uri).catch((error) => {
            log.warn({ err: error, resourceUri: uri, server: spec.name }, 'mcp app resource refresh failed');
          });
        }
      }
    };

    const readResource = (uri: string, signal?: AbortSignal) => appResources.readResource(uri, signal);
    refreshAppResources = (uri) => appResources.refresh(uri);

    applyToolList = async (tools) => {
      const definitions = new Map(tools.map((tool) => [tool.name, tool]));
      remoteDefinitions.clear();
      remoteInputSchemas.clear();
      for (const [name, tool] of definitions) remoteDefinitions.set(name, tool);
      for (const [name, tool] of definitions) {
        remoteInputSchemas.set(name, tool.inputSchema ? schemaFor(tool) : passthroughSchema);
      }
      await appResources.syncSubscriptions(definitions.values());
      await refreshAppResources();
      conn.tools = tools.filter(mcpToolVisibleToModel).map<Tool>((remote: McpToolDefinition) => ({
        name: mcpToolName(spec.name, remote.name),
        description: remote.description ?? `MCP tool ${remote.name} from ${spec.name}`,
        scopes: [{ resource: `mcp:${spec.name}` }],
        highRisk: true,
        inputSchema: remoteInputSchemas.get(remote.name) ?? passthroughSchema,
        run: async (input, ctx) => {
          const raw = await callRemoteTool(remote.name, input, ctx, remote);
          const result = normalizeMcpResult(raw);
          const resourceUri = mcpAppResourceUri(remote);
          let displayContent: ToolDisplayContent | undefined;
          if (resourceUri) {
            const appResource = appResources.get(resourceUri);
            if (appResource) {
              const bridgeId = registerMcpAppBridge({
                server: spec.name,
                sessionId: ctx.sessionId,
                resourceUri,
                callTool: async (name, args, signal) => {
                  const definition = remoteDefinitions.get(name);
                  if (!definition) throw new McpAppBridgeError(`MCP App tool not found: ${name}`, 404);
                  assertMcpToolVisibleToApp(definition);
                  const parsed = remoteInputSchemas.get(name)?.safeParse(args);
                  if (parsed && !parsed.success) {
                    throw new McpAppBridgeError(
                      parsed.error instanceof Error ? parsed.error.message : String(parsed.error),
                      400
                    );
                  }
                  const input = parsed?.success ? parsed.data : args;
                  if (!ctx.gate) throw new McpAppBridgeError('MCP App approval gate is unavailable', 403);
                  const approval = await ctx.gate({
                    tool: mcpToolName(spec.name, name),
                    key: name,
                    sessionId: ctx.sessionId,
                    highRisk: true,
                    input
                  });
                  if (!approval.allow) throw new McpAppBridgeError(approval.reason, 403);
                  return callRemoteTool(
                    name,
                    input,
                    {
                      ...ctx,
                      signal: signal ? AbortSignal.any([connectionAbort.signal, signal]) : connectionAbort.signal
                    },
                    definition
                  );
                },
                readResource,
                readView: () => {
                  return appResources.view(resourceUri);
                }
              });
              displayContent = {
                type: 'mcp_app',
                resourceUri,
                html: appResource.html,
                data: result.structuredContent,
                bridgeId,
                ...(appResource.csp ? { csp: appResource.csp } : {}),
                ...(appResource.permissions ? { permissions: appResource.permissions } : {})
              };
            }
          }
          return toolResult(
            {
              protocolVersion: client.getNegotiatedProtocolVersion(),
              protocolEra: client.getProtocolEra(),
              text: result.text,
              ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
              ...(result.taskId ? { taskId: result.taskId, taskExtension: MCP_TASKS_EXTENSION } : {}),
              imageCount: result.imageCount,
              ...(result.truncated ? { truncated: true } : {})
            },
            {
              modelContent: mcpToModelOutput(result),
              ...(displayContent ? { displayContent } : {})
            }
          );
        }
      }));
      for (const listener of toolListeners) listener(conn.tools);
    };
    await applyToolList(remoteTools);

    if (serverSupportsTasks(client) && spec.taskJournal) {
      void resumeTaskJournal(transport, spec.taskJournal, spec.name, connectionAbort.signal).catch((error) => {
        if (!connectionAbort.signal.aborted) {
          log.warn({ err: error, server: spec.name }, 'mcp task recovery failed');
        }
      });
    }

    return conn;
  } catch (error) {
    connectionAbort.abort();
    await client.close().catch(() => {});
    throw error;
  }
}
