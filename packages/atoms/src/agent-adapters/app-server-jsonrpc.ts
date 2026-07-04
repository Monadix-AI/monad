import type { NativeCliAgentView, NativeCliProductIcon, NativeCliProvider } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliManagedRuntime,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliRuntimeHandle
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, NativeCliError, resolveBinary } from '@monad/sdk-atom';

import { compactObject, hasFlag, parseJsonObject, parseStructuredAuthState } from './adapter-shared.ts';
import { parseNativeCliArgumentSupport } from './argument-support.ts';
import {
  jsonRpcErrorResponse,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  jsonRpcResponseId
} from './jsonrpc.ts';
import { resizePty, sendPtyInput, stopPty } from './pty.ts';

// Shared JSON-RPC-over-WebSocket app-server plumbing for coding CLIs whose local gateway speaks a
// thin `initialize` → `session.*` → streaming-notification protocol (OpenClaw's `openclaw gateway`,
// Hermes's `hermes serve`). Each provider supplies its own method vocabulary via AppServerProtocol;
// the ordering (deferred session frame until initialize resolves), by-id response dispatch, and
// auto-decline of unknown server requests are identical and live here once.

export interface AppServerFrame extends Record<string, unknown> {
  method?: string;
  id?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AppServerProtocol {
  provider: string;
  /** JSON-RPC methods the gateway understands for the client→server side. */
  methods: {
    sessionStart: string;
    sessionResume: string;
    /** Deliver a user turn. */
    message: string;
  };
  /** Build the session start/resume params from the initialize context. */
  sessionParams(context: Parameters<NonNullable<NativeCliProviderAdapter['initialize']>>[1]): Record<string, unknown>;
  /** Build the user-turn params for `methods.message`. */
  messageParams(sessionId: string, input: string): Record<string, unknown>;
  /** Server-initiated approval request method (frame.method), if the provider surfaces approvals. */
  approvalRequestMethod?: string;
  /** Server→client notification methods → event translators. */
  notifications: Record<string, (params: Record<string, unknown>, frame: AppServerFrame) => NativeCliOutputEvent[]>;
  /** Message shown when a session start/resume fails (surfaced as connection_required). */
  reconnectReason: string;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** First non-empty string among the common streaming-text field names. */
export function payloadText(params: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'delta', 'token', 'message', 'content', 'reply']) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function idKeyOf(frame: AppServerFrame): string | number | undefined {
  return typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : undefined;
}

export function initializeAppServer(
  protocol: AppServerProtocol,
  handle: Parameters<NonNullable<NativeCliProviderAdapter['initialize']>>[0],
  context: Parameters<NonNullable<NativeCliProviderAdapter['initialize']>>[1]
): void {
  if (handle.launchMode !== 'app-server' || !handle.appServer) return;
  const initializeId = handle.nextRequestId?.() ?? 0;
  const sessionId = handle.nextRequestId?.() ?? 1;
  handle.pendingRequests?.set(initializeId, 'initialize');
  handle.pendingRequests?.set(sessionId, context.providerSessionRef ? 'sessionResume' : 'sessionStart');
  const method = context.providerSessionRef ? protocol.methods.sessionResume : protocol.methods.sessionStart;
  const sessionFrame = jsonRpcRequest(method, sessionId, protocol.sessionParams(context));
  handle.deferredThreadFrame = sessionFrame;
  const handshake = [
    jsonRpcRequest('initialize', initializeId, { clientInfo: { name: 'monad', version: '0.1.0' } }),
    jsonRpcNotification('initialized')
  ];
  const frames = handle.pendingRequests ? handshake : [...handshake, sessionFrame];
  if (!handle.pendingRequests) handle.deferredThreadFrame = undefined;
  for (const frame of frames) handle.appServer.send(frame);
}

export function sendAppServerInput(protocol: AppServerProtocol, handle: NativeCliRuntimeHandle, input: string): void {
  if (!handle.appServer) throw new Error('native CLI session has no app-server input bridge');
  if (!handle.providerSessionRef) throw new Error('native CLI app-server session is not ready');
  const turnId = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(turnId, 'turn');
  handle.appServer.send(
    jsonRpcRequest(protocol.methods.message, turnId, protocol.messageParams(handle.providerSessionRef, input))
  );
}

export function resolveAppServerApproval(
  handle: NativeCliRuntimeHandle,
  resolution: Parameters<NativeCliProviderAdapter['resolveApproval']>[1]
): void {
  if (!handle.appServer) throw new Error('native CLI session has no app-server approval bridge');
  handle.appServer.send(
    jsonRpcResponse(jsonRpcResponseId(resolution.request?.requestId, resolution.requestId), {
      decision: resolution.allow ? 'approve' : 'deny',
      ...(resolution.reason ? { reason: resolution.reason } : {})
    })
  );
}

function responseEvents(
  protocol: AppServerProtocol,
  frame: AppServerFrame,
  handle?: NativeCliRuntimeHandle
): NativeCliOutputEvent[] {
  const idKey = idKeyOf(frame);
  const kind = idKey !== undefined ? handle?.pendingRequests?.get(idKey) : undefined;
  if (idKey !== undefined && kind !== undefined) handle?.pendingRequests?.delete(idKey);

  const error = recordValue(frame.error);
  if (error) {
    if (kind === 'sessionStart' || kind === 'sessionResume') {
      return [
        {
          type: 'connection_required',
          payload: compactObject({
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined,
            reason:
              typeof error.message === 'string' && error.message.length > 0 ? error.message : protocol.reconnectReason
          })
        }
      ];
    }
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          responseId: idKey,
          code: error.code,
          message: typeof error.message === 'string' ? error.message : JSON.stringify(error)
        })
      }
    ];
  }

  if (kind === 'initialize') {
    if (handle?.deferredThreadFrame && handle.appServer) {
      handle.appServer.send(handle.deferredThreadFrame);
      handle.deferredThreadFrame = undefined;
    }
    return [];
  }

  const result = recordValue(frame.result);
  if (kind === 'sessionStart' || kind === 'sessionResume') {
    const sessionId = result?.sessionId ?? result?.session ?? result?.id;
    return typeof sessionId === 'string'
      ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: sessionId, responseId: idKey }) }]
      : [];
  }
  return [];
}

function frameRequestId(frame: AppServerFrame, params: Record<string, unknown>): string | number | undefined {
  const fromFrame = idKeyOf(frame);
  if (fromFrame !== undefined) return fromFrame;
  const fromParams = params.requestId ?? params.id;
  if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams;
  if (typeof fromParams === 'number') return fromParams;
  return undefined;
}

function approvalRequestEvent(frame: AppServerFrame, params: Record<string, unknown>): NativeCliOutputEvent[] {
  // An approval with no routable id can never be answered by resolveApproval, so drop it rather
  // than emit an event that fails schema validation (requestId is required and min(1)).
  const requestId = frameRequestId(frame, params);
  if (requestId === undefined) return [];
  return [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId,
        kind: typeof params.kind === 'string' ? params.kind : 'approval',
        tool: params.tool,
        command: params.command,
        cwd: params.cwd,
        reason: params.reason
      })
    }
  ];
}

export function parseAppServerFrame(
  protocol: AppServerProtocol,
  frame: AppServerFrame,
  handle?: NativeCliRuntimeHandle
): NativeCliOutputEvent[] {
  // A response/error frame (result|error) is resolved by the request-id ledger; it is never also a
  // notification, so return its events (even empty) rather than falling through to method dispatch.
  if ('result' in frame || 'error' in frame) return responseEvents(protocol, frame, handle);
  if (typeof frame.method !== 'string') return [];
  const params = recordValue(frame.params) ?? {};
  if (protocol.approvalRequestMethod && frame.method === protocol.approvalRequestMethod) {
    return approvalRequestEvent(frame, params);
  }
  const isKnownMethod = frame.method in protocol.notifications;
  if (isKnownMethod) return protocol.notifications[frame.method]?.(params, frame) ?? [];
  // Only a genuinely-unknown method gets auto-declined. Keying on "produced no events" would
  // spuriously decline a known notification that legitimately yields nothing but carries an id.
  const requestId = idKeyOf(frame);
  if (requestId !== undefined && handle?.appServer) {
    handle.appServer.send(jsonRpcErrorResponse(requestId, -32601, `Unsupported method: ${frame.method}`));
  }
  return [];
}

export function parseAppServerOutput(
  protocol: AppServerProtocol,
  chunk: string,
  handle?: NativeCliRuntimeHandle
): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    events.push(...parseAppServerFrame(protocol, record as AppServerFrame, handle));
  }
  return events;
}

/** A streaming-text notification → one non-final `agent_message`; nothing when there is no text. */
export function textEvent(params: Record<string, unknown>): NativeCliOutputEvent[] {
  const text = payloadText(params);
  return text ? [{ type: 'agent_message', payload: { text } }] : [];
}

export interface MakeAppServerProtocolOptions {
  provider: string;
  /** JSON-RPC method that delivers a user turn (`agent.message` / `agent.chat`). */
  messageMethod: string;
  /** Params field the user turn text travels in (`text` / `prompt`). */
  messageField: string;
  reconnectReason: string;
  /** Fallback message for `agent.error` frames that carry no message string. */
  errorReason: string;
}

/** The `session.*` / `agent.*` / `approval.*` gateway vocabulary shared by OpenClaw and Hermes.
 *  Providers differ only in the turn method + its text field name, the reconnect/error prose, and the
 *  message method — everything else (frame translation, robustness) lives here once. */
export function makeAppServerProtocol(options: MakeAppServerProtocolOptions): AppServerProtocol {
  return {
    provider: options.provider,
    methods: {
      sessionStart: 'session.start',
      sessionResume: 'session.resume',
      message: options.messageMethod
    },
    sessionParams(context) {
      const modelParam = context.modelId ?? context.modelName;
      return compactObject({
        cwd: context.workingPath,
        sessionId: context.providerSessionRef,
        model: modelParam,
        reasoningEffort: context.reasoningEffort,
        instructions: context.developerInstructions
      });
    },
    messageParams(sessionId, input) {
      return { sessionId, [options.messageField]: input };
    },
    approvalRequestMethod: 'approval.request',
    reconnectReason: options.reconnectReason,
    notifications: {
      'agent.token': (params) => textEvent(params),
      'agent.message': (params) => textEvent(params),
      // `final: true` is the turn terminator and must survive even a text-less frame, so default
      // text to '' rather than dropping the event when the frame carries no text.
      'agent.final': (params) => [
        { type: 'agent_message', payload: compactObject({ text: payloadText(params) ?? '', final: true }) }
      ],
      'agent.error': (params) => [
        {
          type: 'provider_error',
          payload: compactObject({
            code: params.code,
            message:
              typeof params.message === 'string' && params.message.length > 0 ? params.message : options.errorReason
          })
        }
      ],
      // `providerSessionRef` is required min(1); an empty-string sessionId would produce an invalid
      // session_ref, so guard on non-empty and emit nothing otherwise.
      'session.updated': (params) =>
        typeof params.sessionId === 'string' && params.sessionId.length > 0
          ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: params.sessionId }) }]
          : [],
      // requestId is required min(1); fall back to params.id when the approval carries no top-level
      // requestId, and drop the frame rather than emit an unresolvable approval_resolved.
      'approval.resolved': (params) => {
        const raw = params.requestId ?? params.id;
        const requestId = (typeof raw === 'string' && raw.length > 0) || typeof raw === 'number' ? raw : undefined;
        return requestId === undefined ? [] : [{ type: 'approval_resolved', payload: compactObject({ requestId }) }];
      }
    }
  };
}

export interface MakeAppServerCliAdapterOptions {
  provider: NativeCliProvider;
  productIcon: NativeCliProductIcon;
  label: string;
  /** Binary name probed on PATH and used as the default command. */
  bin: string;
  /** Home-dir config folder whose presence also counts as "installed" (e.g. `.openclaw`). */
  homeConfigDir: string;
  /** Subcommand that launches the persistent app-server gateway (`gateway` / `serve`). */
  appServerSubcommand: string;
  /** Fallback model ids advertised for `--model` (no models-list command). */
  models: string[];
  installHint: string;
  installUrl: string;
  /** Args after `auth` for the auth-status probe (e.g. `['status']` vs `['list']`). */
  authStatusArgs: string[];
  /** Managed project-agent runtime behavior; omit for a non-managed adapter. */
  managedRuntime?: NativeCliManagedRuntime;
  /** Opt-in `cli-oneshot` launch mode for a provider with no persistent app-server backend (Hermes):
   *  the daemon spawns a fresh process per turn with `turnArgs(input)` appended to the base argv. */
  oneshot?: {
    turnArgs(input: string, opts: { providerSessionRef?: string | null }): string[];
  };
  protocol: AppServerProtocol;
}

/** Build a full `NativeCliProviderAdapter` for a coding CLI whose local gateway speaks the shared
 *  `initialize` → `session.*` → streaming-notification app-server protocol (OpenClaw, Hermes). */
export function makeAppServerCliAdapter(options: MakeAppServerCliAdapterOptions): NativeCliProviderAdapter {
  const appServerTransports = ['ws'] as const;

  function skipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
    if (!skipProviderApprovals || hasFlag(args, '--yolo') || hasFlag(args, '--auto-approve')) return args;
    return [...args, '--auto-approve'];
  }

  function buildLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
    const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
    let args = [...(agent.args ?? [])];
    if (opts.providerSessionRef && !hasFlag(args, '--session-id')) {
      args.push('--session-id', opts.providerSessionRef);
    }
    const modelId = opts.modelId ?? opts.modelName;
    if (modelId && !hasFlag(args, '--model')) args.push('--model', modelId);
    args = skipApprovalArgs(args, !!opts.skipProviderApprovals);

    if (launchMode === 'app-server') {
      const transport = opts.appServerTransport ?? agent.appServerTransport ?? 'ws';
      if (!(appServerTransports as readonly string[]).includes(transport)) {
        throw new NativeCliError(
          'unsupported_capability',
          `${options.label} app-server transport "${transport}" is not supported; use ${appServerTransports.join(' or ')}`
        );
      }
      return {
        argv: [agent.command, options.appServerSubcommand, ...args],
        cwd: opts.workingPath,
        env: agent.env,
        launchMode,
        appServerTransport: transport,
        provider: options.provider,
        approvalOwnership: 'provider-owned',
        capabilities: ['app-server', 'provider-approval', 'approval-resolution', 'session-resume']
      };
    }

    if (launchMode === 'cli-oneshot') {
      if (!options.oneshot) {
        throw new NativeCliError('unsupported_capability', `${options.label} has no cli-oneshot launch mode`);
      }
      // Base argv only — the per-turn directive is appended by the daemon via `oneshotTurnArgs`. Each
      // turn is a stateless fresh process (no --resume selector), so no `session-resume` capability.
      return {
        argv: [agent.command, ...args],
        cwd: opts.workingPath,
        env: agent.env,
        launchMode,
        provider: options.provider,
        approvalOwnership: 'provider-owned',
        capabilities: ['cli-oneshot']
      };
    }

    return {
      argv: [agent.command, ...args],
      cwd: opts.workingPath,
      env: agent.env,
      launchMode,
      provider: options.provider,
      approvalOwnership: 'provider-owned',
      capabilities: ['pty', 'app-server', 'provider-approval', 'session-resume']
    };
  }

  function buildAuthLaunch(agent: NativeCliAgentView, args: string[]): NativeCliLaunchSpec {
    return {
      argv: [agent.command, ...args],
      cwd: homedir(),
      env: agent.env,
      launchMode: 'pty',
      provider: options.provider,
      approvalOwnership: 'provider-owned',
      capabilities: ['pty', 'provider-approval']
    };
  }

  function parseTerminalOutput(chunk: string): NativeCliOutputEvent[] {
    return chunk.length > 0 ? [{ type: 'agent_message', payload: { text: chunk } }] : [];
  }

  const adapter: NativeCliProviderAdapter = {
    provider: options.provider,
    productIcon: options.productIcon,
    label: options.label,
    ...(options.managedRuntime ? { managedRuntime: options.managedRuntime } : {}),
    ...(options.oneshot ? { oneshotTurnArgs: options.oneshot.turnArgs } : {}),
    detect(probes = defaultBinProbes) {
      const bin = resolveBinary(options.bin, [], probes);
      const installed = bin !== undefined || probes.exists(join(homedir(), options.homeConfigDir));
      return {
        id: options.provider,
        label: options.label,
        provider: options.provider,
        productIcon: options.productIcon,
        command: options.bin,
        args: [],
        modelOptions: adapter.listSupportedModels(),
        defaultLaunchMode: 'pty',
        supportedLaunchModes: options.oneshot ? ['pty', 'app-server', 'cli-oneshot'] : ['pty', 'app-server'],
        supportedAppServerTransports: [...appServerTransports],
        installHint: options.installHint,
        installUrl: options.installUrl,
        installed,
        resolvedBinPath: bin,
        capabilities: {
          auth: 'pty',
          history: 'none',
          resume: 'pty',
          approval: 'provider-owned'
        }
      };
    },
    resolveCommand(command, probes = defaultBinProbes) {
      return resolveBinary(command, [], probes);
    },
    listSupportedModels(agent) {
      return agent?.modelOptions?.length ? agent.modelOptions : options.models;
    },
    buildLaunch,
    buildAuthLaunch(agent) {
      return buildAuthLaunch(agent, ['auth']);
    },
    buildAuthStatusLaunch(agent) {
      return buildAuthLaunch(agent, ['auth', ...options.authStatusArgs]);
    },
    authStatus(agent) {
      return {
        launch: buildAuthLaunch(agent, ['auth', ...options.authStatusArgs, '--json']),
        parse: (output, exitCode) => adapter.parseAuthStatus(output, exitCode)
      };
    },
    argumentSupport(agent) {
      return {
        launch: buildAuthLaunch(agent, ['--help']),
        parse: (output) => parseNativeCliArgumentSupport(output)
      };
    },
    parseAuthStatus(output, exitCode) {
      const structured = parseStructuredAuthState(output);
      if (structured) return structured;
      if (exitCode === 0) return 'authenticated';
      if (exitCode !== null) return 'unauthenticated';
      return 'unknown';
    },
    initialize(handle, context) {
      initializeAppServer(options.protocol, handle, context);
    },
    parseOutput(chunk, handle) {
      return handle?.launchMode === 'app-server'
        ? parseAppServerOutput(options.protocol, chunk, handle)
        : parseTerminalOutput(chunk);
    },
    sendInput(handle, input) {
      if (handle.launchMode === 'app-server') {
        sendAppServerInput(options.protocol, handle, input);
        return;
      }
      sendPtyInput(handle, input);
    },
    resolveApproval(handle, resolution) {
      if (handle.launchMode !== 'app-server') {
        throw new Error(`${options.label} native CLI approval resolution is provider-owned in pty mode`);
      }
      resolveAppServerApproval(handle, resolution);
    },
    resize(handle, cols, rows) {
      if (handle.launchMode === 'app-server') return;
      resizePty(handle, cols, rows);
    },
    stop(handle) {
      if (handle.launchMode === 'app-server') {
        handle.appServer?.close();
        handle.kill('SIGTERM');
        return;
      }
      stopPty(handle);
    }
  };
  return adapter;
}
