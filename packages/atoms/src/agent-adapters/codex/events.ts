import type { NativeCliOutputEvent, NativeCliRuntimeHandle } from '@monad/sdk-atom';
import type {
  CodexAppServerNotification,
  CodexAppServerResponseItem,
  CodexAppServerServerRequest,
  CodexAppServerThreadReadResponse,
  CodexAppServerTurnsPage
} from './app-server.ts';

import { compactObject, parseJsonObject } from '../adapter-shared.ts';
import { jsonRpcErrorResponse, jsonRpcRequest } from '../jsonrpc.ts';

export type CodexJsonRpcResponse = {
  id?: unknown;
  error?: Record<string, unknown>;
  result?: CodexAppServerThreadReadResponse | CodexAppServerTurnsPage | Record<string, unknown>;
} & Record<string, unknown>;
export type CodexJsonRpcNotification = Partial<CodexAppServerNotification | CodexAppServerServerRequest> &
  Record<string, unknown> & { method: string };
type CodexResponseItemJson = Partial<CodexAppServerResponseItem> & Record<string, unknown> & { type: string };

function isCodexJsonRpcNotification(record: Record<string, unknown>): record is CodexJsonRpcNotification {
  return typeof record.method === 'string';
}

function isCodexJsonRpcResponse(record: Record<string, unknown>): record is CodexJsonRpcResponse {
  return 'result' in record || 'error' in record;
}

function isCodexResponseItem(item: unknown): item is CodexResponseItemJson {
  return (
    !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { type?: unknown }).type === 'string'
  );
}

export function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textFromCodexContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .join('');
  return text || undefined;
}

function parseCodexResponseItem(item: CodexResponseItemJson): NativeCliOutputEvent[] {
  if (item.type === 'message' && item.role === 'assistant') {
    const text = textFromCodexContent(item.content);
    return text ? [{ type: 'agent_message', payload: { text } }] : [];
  }

  if (item.type === 'function_call') {
    const args = typeof item.arguments === 'string' ? parseJsonObject(item.arguments) : undefined;
    return [
      {
        type: 'tool_call',
        payload: compactObject({
          callId: item.call_id,
          tool: item.name,
          input: args
        })
      }
    ];
  }

  if (item.type === 'function_call_output') {
    return [
      {
        type: 'tool_result',
        payload: compactObject({
          callId: item.call_id,
          output: item.output
        })
      }
    ];
  }

  if (item.type === 'web_search_call' && item.status === 'completed') {
    return [{ type: 'web_search_result', payload: compactObject({ callId: item.id, status: item.status }) }];
  }

  return [];
}

// Method-keyed dispatch tables. Adding a new app-server event (e.g. an `item/*` streaming delta) is
// a single table entry rather than another branch grafted onto an if-chain.
type CodexNotificationHandler = (
  record: CodexJsonRpcNotification,
  params: Record<string, unknown>
) => NativeCliOutputEvent[];

const CODEX_APPROVAL_REQUEST_HANDLERS: Record<string, CodexNotificationHandler> = {
  'item/commandExecution/requestApproval': (record, p) => [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId: record.id,
        kind: 'commandExecution',
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        approvalId: p.approvalId,
        startedAtMs: p.startedAtMs,
        reason: p.reason,
        command: p.command,
        cwd: p.cwd,
        environmentId: p.environmentId,
        networkApprovalContext: p.networkApprovalContext
      })
    }
  ],
  'item/fileChange/requestApproval': (record, p) => [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId: record.id,
        kind: 'fileChange',
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        startedAtMs: p.startedAtMs,
        reason: p.reason,
        grantRoot: p.grantRoot
      })
    }
  ],
  'item/permissions/requestApproval': (record, p) => [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId: record.id,
        kind: 'permissions',
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        startedAtMs: p.startedAtMs,
        reason: p.reason,
        cwd: p.cwd,
        environmentId: p.environmentId,
        permissions: p.permissions
      })
    }
  ],
  execCommandApproval: (record, p) => [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId: record.id,
        kind: 'execCommand',
        threadId: p.conversationId,
        callId: p.callId,
        approvalId: p.approvalId,
        reason: p.reason,
        command: Array.isArray(p.command) ? p.command.join(' ') : p.command,
        cwd: p.cwd
      })
    }
  ],
  applyPatchApproval: (record, p) => [
    {
      type: 'approval_requested',
      payload: compactObject({
        requestId: record.id,
        kind: 'applyPatch',
        threadId: p.conversationId,
        callId: p.callId,
        reason: p.reason,
        grantRoot: p.grantRoot,
        fileChanges: p.fileChanges
      })
    }
  ]
};

// TurnCompletedNotification params are `{ threadId, turn }`, where the model's reply is the last
// `agentMessage` item inside `turn.items` — there is no top-level text field. Extract it so the
// turn-boundary event (which retires the managed inbox turn) also carries the real final text.
function codexTurnFinalText(turn: unknown): string {
  const items = recordValue(turn)?.items;
  if (!Array.isArray(items)) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const item = recordValue(items[i]);
    if (item?.type === 'agentMessage' && typeof item.text === 'string') return item.text;
  }
  return '';
}

const CODEX_SERVER_NOTIFICATION_HANDLERS: Record<string, CodexNotificationHandler> = {
  'rawResponseItem/completed': (_record, p) => (isCodexResponseItem(p.item) ? parseCodexResponseItem(p.item) : []),
  'turn/completed': (_record, p) => [
    {
      type: 'agent_message',
      payload: compactObject({
        text: codexTurnFinalText(p.turn) || stringValue(p.text, p.result, p.outputText) || undefined,
        final: true
      })
    }
  ],
  'thread/status/changed': (_record, p) =>
    typeof p.threadId === 'string'
      ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: p.threadId, status: p.status }) }]
      : [],
  'serverRequest/resolved': (_record, p) => [
    { type: 'approval_resolved', payload: compactObject({ requestId: p.requestId, threadId: p.threadId }) }
  ]
};

function dispatchCodexNotification(
  handlers: Record<string, CodexNotificationHandler>,
  record: CodexJsonRpcNotification
): NativeCliOutputEvent[] {
  const params = recordValue(record.params);
  if (!params) return [];
  return handlers[record.method]?.(record, params) ?? [];
}

function parseCodexApprovalRequest(record: CodexJsonRpcNotification): NativeCliOutputEvent[] {
  return dispatchCodexNotification(CODEX_APPROVAL_REQUEST_HANDLERS, record);
}

function parseCodexServerNotification(record: CodexJsonRpcNotification): NativeCliOutputEvent[] {
  return dispatchCodexNotification(CODEX_SERVER_NOTIFICATION_HANDLERS, record);
}

// Codex reports an expired/absent login as a JSON-RPC error (code `Unauthorized`, or an auth phrase
// in the message / structured `codexErrorInfo`). Surface those as `connection_required` so the host
// tears the session down and points the user at Studio to reconnect, rather than as an opaque
// provider error that leaves a dead app-server session running.
function codexAuthErrorText(error: Record<string, unknown>): string {
  const info = error.codexErrorInfo;
  const infoText =
    typeof info === 'string'
      ? info
      : info && typeof info === 'object' && typeof (info as { type?: unknown }).type === 'string'
        ? (info as { type: string }).type
        : '';
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return `${infoText} ${code} ${message}`;
}

function isCodexAuthError(error: Record<string, unknown>): boolean {
  return /\bunauthorized\b|not[\s_-]?logged[\s_-]?in|login[\s_-]?required|authentication[\s_-]?required|token[\s_-]?expired/i.test(
    codexAuthErrorText(error)
  );
}

// `CodexErrorInfo` is either a bare camelCase tag ("contextWindowExceeded") or a single-key object
// ({ httpConnectionFailed: { httpStatusCode } }). Reduce both to the tag so we can triage by code.
function codexErrorInfoKind(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object' && !Array.isArray(info)) return Object.keys(info)[0];
  return undefined;
}

// Turn-level errors arrive as an `error` notification carrying a `TurnError`. Triage the codex error
// code: unauthorized → reconnect; everything else → a provider_error tagged with the code so the UI
// can distinguish context-overflow / usage-limit / transient stream failures from a generic error.
function codexTurnErrorEvents(turnError: Record<string, unknown>): NativeCliOutputEvent[] {
  const kind = codexErrorInfoKind(turnError.codexErrorInfo);
  const message =
    typeof turnError.message === 'string' && turnError.message.length > 0
      ? turnError.message
      : (kind ?? 'codex provider error');
  if (kind === 'unauthorized') {
    return [{ type: 'connection_required', payload: compactObject({ code: 'unauthorized', reason: message }) }];
  }
  return [{ type: 'provider_error', payload: compactObject({ code: kind, message }) }];
}

// Bound how many times one turn may be auto-recovered (compacted + re-run) before we surface the error.
const CODEX_MAX_TURN_RECOVERIES = 1;

// Handle an `error` turn notification. Returns the events to emit, or `undefined` if the payload isn't
// a turn error (fall through). A context-overflow error won't fix itself, so — once, with the last
// turn text still known — compact the thread and re-run the turn silently instead of surfacing it.
// codex retries transient failures itself (`willRetry`), so those are suppressed rather than shown.
function handleCodexTurnError(
  record: CodexJsonRpcNotification,
  handle?: NativeCliRuntimeHandle
): NativeCliOutputEvent[] | undefined {
  const params = recordValue(record.params);
  const turnError = recordValue(params?.error);
  if (!turnError) return undefined;
  const kind = codexErrorInfoKind(turnError.codexErrorInfo);
  const willRetry = params?.willRetry === true;

  if (
    kind === 'contextWindowExceeded' &&
    !willRetry &&
    handle?.appServer &&
    handle.providerSessionRef &&
    handle.lastTurnInput &&
    (handle.turnRecoveries ?? 0) < CODEX_MAX_TURN_RECOVERIES
  ) {
    handle.turnRecoveries = (handle.turnRecoveries ?? 0) + 1;
    handle.appServer.send(
      jsonRpcRequest('thread/compact/start', handle.nextRequestId?.() ?? Date.now(), {
        threadId: handle.providerSessionRef
      })
    );
    const turnId = handle.nextRequestId?.() ?? Date.now();
    handle.pendingRequests?.set(turnId, 'turn');
    handle.appServer.send(
      jsonRpcRequest('turn/start', turnId, {
        threadId: handle.providerSessionRef,
        input: [{ type: 'text', text: handle.lastTurnInput }]
      })
    );
    return [];
  }

  if (willRetry) return [];
  return codexTurnErrorEvents(turnError);
}

function codexHistoryPageEvent(id: unknown, r: Record<string, unknown>): NativeCliOutputEvent[] {
  return [
    {
      type: 'history_page',
      payload: {
        responseId: id as string | number,
        items: Array.isArray(r.data) ? r.data : [],
        nextCursor: typeof r.nextCursor === 'string' ? r.nextCursor : null,
        backwardsCursor: typeof r.backwardsCursor === 'string' ? r.backwardsCursor : null
      }
    }
  ];
}

function codexThreadRefEvent(id: unknown, r: Record<string, unknown>): NativeCliOutputEvent[] {
  const thread = recordValue(r.thread);
  const threadId = thread?.id;
  if (typeof threadId !== 'string') return [];
  return [{ type: 'session_ref', payload: compactObject({ providerSessionRef: threadId, responseId: id }) }];
}

export function jsonRpcIdKey(id: unknown): string | number | undefined {
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function parseCodexClientResponse(
  record: CodexJsonRpcResponse,
  handle?: NativeCliRuntimeHandle
): NativeCliOutputEvent[] {
  const idKey = jsonRpcIdKey(record.id);
  const kind = idKey !== undefined ? handle?.pendingRequests?.get(idKey) : undefined;
  if (idKey !== undefined && kind !== undefined) handle?.pendingRequests?.delete(idKey);

  const error = recordValue(record.error);
  if (error) {
    // A failed thread start/resume means the session has no live thread — including after a reconnect
    // where codex has since dropped the thread. Surface a reconnect prompt (which tears the session
    // down) rather than a provider_error that leaves it "running" over a thread that no longer exists.
    if (isCodexAuthError(error) || kind === 'thread' || kind === 'threadResume') {
      return [
        {
          type: 'connection_required',
          payload: compactObject({
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined,
            reason:
              typeof error.message === 'string' && error.message.length > 0
                ? error.message
                : 'Codex requires reconnect in Studio'
          })
        }
      ];
    }
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          responseId: record.id,
          code: error.code,
          message: typeof error.message === 'string' ? error.message : JSON.stringify(error)
        })
      }
    ];
  }
  const result = recordValue(record.result);
  if (!result) return [];
  // The `initialize` response is the handshake gate: only once it lands is the server ready for
  // requests, so flush the parked `thread/start`|`thread/resume` frame now (protocol ordering).
  if (kind === 'initialize') {
    if (handle?.deferredThreadFrame && handle.appServer) {
      handle.appServer.send(handle.deferredThreadFrame);
      handle.deferredThreadFrame = undefined;
    }
    return [];
  }
  // Dispatch by the recorded request kind when the per-session ledger is available; fall back to
  // result-shape sniffing for contexts with no ledger (unit tests, the one-shot CLI history probe).
  if (kind === 'historyPage') return codexHistoryPageEvent(record.id, result);
  if (kind === 'thread' || kind === 'threadResume') return codexThreadRefEvent(record.id, result);
  if (kind === 'turn') return [];
  if (Array.isArray(result.data) && 'nextCursor' in result && 'backwardsCursor' in result) {
    return codexHistoryPageEvent(record.id, result);
  }
  return codexThreadRefEvent(record.id, result);
}

export function parseCodexSessionJsonl(chunk: string, handle?: NativeCliRuntimeHandle): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    const payload = record.payload;
    if (isCodexJsonRpcResponse(record)) {
      const responseEvents = parseCodexClientResponse(record, handle);
      if (responseEvents.length > 0) {
        events.push(...responseEvents);
        continue;
      }
    }
    if (isCodexJsonRpcNotification(record)) {
      // Track the in-flight turn so interrupt/steer can address it. turn/started opens it, turn/completed closes it.
      if (handle && (record.method === 'turn/started' || record.method === 'turn/completed')) {
        const turn = recordValue(recordValue(record.params)?.turn);
        handle.currentTurnId = record.method === 'turn/started' && typeof turn?.id === 'string' ? turn.id : undefined;
        if (record.method === 'turn/completed') handle.turnRecoveries = 0;
      }
      if (record.method === 'error') {
        const errorEvents = handleCodexTurnError(record, handle);
        if (errorEvents) {
          events.push(...errorEvents);
          continue;
        }
      }
      const appServerEvents = [...parseCodexApprovalRequest(record), ...parseCodexServerNotification(record)];
      if (appServerEvents.length > 0) {
        events.push(...appServerEvents);
        continue;
      }
      // Unhandled server-initiated *request* (method + id): reply method-not-found so codex doesn't
      // block waiting on us. Notifications (no id) are safely ignored. This makes opting into the
      // experimental API surface (which can trigger requests like tool/requestUserInput) safe: we
      // decline what we don't proxy rather than hang the turn.
      const requestId = jsonRpcIdKey(record.id);
      if (requestId !== undefined && handle?.appServer) {
        handle.appServer.send(jsonRpcErrorResponse(requestId, -32601, `Unsupported method: ${record.method}`));
        continue;
      }
    }

    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;

    if (record.type === 'session_meta') {
      events.push({
        type: 'session_ref',
        payload: compactObject({
          providerSessionRef: p.id,
          cwd: p.cwd,
          cliVersion: p.cli_version
        })
      });
      continue;
    }

    if (record.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') {
      events.push({ type: 'agent_message', payload: { text: p.message } });
      continue;
    }

    if (record.type === 'response_item' && isCodexResponseItem(p)) events.push(...parseCodexResponseItem(p));
  }
  return events;
}
