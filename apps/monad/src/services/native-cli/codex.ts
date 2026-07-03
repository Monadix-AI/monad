import type {
  CodexAppServerNotification,
  CodexAppServerResponseItem,
  CodexAppServerServerRequest,
  CodexAppServerThreadReadResponse,
  CodexAppServerTurnsPage,
  NativeCliAgentView
} from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliProviderHistoryContext,
  NativeCliProviderHistoryPageContext
} from '@/services/native-cli/types.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultBinProbes, resolveBinary } from '@/infra/resolve-binary.ts';
import { parseNativeCliArgumentSupport } from '@/services/native-cli/argument-support.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';
import { readProviderHistoryFile } from '@/services/native-cli/history-files.ts';
import { resizePty, sendPtyInput, stopPty } from '@/services/native-cli/pty.ts';

const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const CODEX_NON_INTERACTIVE_ENV = { CODEX_NON_INTERACTIVE: '1' };
const CODEX_SUPPORTED_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'];
type CodexJsonRpcResponse = {
  id?: unknown;
  error?: Record<string, unknown>;
  result?: CodexAppServerThreadReadResponse | CodexAppServerTurnsPage | Record<string, unknown>;
} & Record<string, unknown>;
type CodexJsonRpcNotification = Partial<CodexAppServerNotification | CodexAppServerServerRequest> &
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

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function withCodexSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--ask-for-approval')) return args;
  return [...args, '--ask-for-approval', 'never'];
}

function codexSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--ask-for-approval')) return [];
  return ['--ask-for-approval', 'never'];
}

function codexExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--add-dir', path]);
}

function codexNonInteractiveEnv(env?: Record<string, string>): Record<string, string> {
  return { ...(env ?? {}), ...CODEX_NON_INTERACTIVE_ENV };
}

function uniqueModelNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function parseCodexModelOptions(output: string): string[] {
  const catalog = parseJsonObject(output);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const names = models
    .map((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined;
      const item = model as Record<string, unknown>;
      return item.visibility === 'list' && typeof item.slug === 'string' ? item.slug : undefined;
    })
    .filter((name): name is string => !!name);
  return uniqueModelNames(names);
}

function parseCodexArgumentSupport(output: string): ReturnType<typeof parseNativeCliArgumentSupport> {
  const catalog = parseJsonObject(output);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const reasoningEfforts = uniqueModelNames(
    models.flatMap((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
      const levels = (model as Record<string, unknown>).supported_reasoning_levels;
      if (!Array.isArray(levels)) return [];
      return levels
        .map((level) => {
          if (!level || typeof level !== 'object' || Array.isArray(level)) return undefined;
          const effort = (level as Record<string, unknown>).effort;
          return typeof effort === 'string' ? effort : undefined;
        })
        .filter((effort): effort is string => !!effort);
    })
  );
  const speeds = uniqueModelNames(
    models.flatMap((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
      const tiers = (model as Record<string, unknown>).additional_speed_tiers;
      return Array.isArray(tiers) ? tiers.filter((tier): tier is string => typeof tier === 'string') : [];
    })
  );
  return { ...parseNativeCliArgumentSupport(output), reasoningEfforts, speeds };
}

function buildCodexAuthLaunch(agent: NativeCliAgentView, args: string[]): NativeCliLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: codexNonInteractiveEnv(agent.env),
    launchMode: 'pty',
    provider: 'codex',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

function buildCodexLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
  let args = [...(agent.args ?? [])];
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  if (launchMode === 'app-server') {
    return {
      argv: [
        agent.command,
        ...codexExtraWorkingPathArgs(opts.extraWorkingPaths),
        ...codexSkipApprovalArgs(args, !!opts.skipProviderApprovals),
        ...(opts.mcpConfigArgs ?? []),
        'app-server',
        '--stdio',
        ...args
      ],
      cwd: opts.workingPath,
      env: agent.env,
      launchMode,
      provider: 'codex',
      approvalOwnership: 'provider-owned',
      capabilities: [
        'pty',
        'app-server',
        'remote-control',
        'provider-approval',
        'approval-resolution',
        'structured-output',
        'session-resume',
        'rollout-json-fallback'
      ]
    };
  }

  const hasCd = args.includes('--cd') || args.includes('-C');
  const hasAltScreen = args.includes('--no-alt-screen');
  args = withCodexSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  if (opts.reasoningEffort && !args.some((arg) => arg.startsWith('model_reasoning_effort'))) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  return {
    argv: [
      agent.command,
      ...(hasCd ? [] : ['--cd', opts.workingPath]),
      ...codexExtraWorkingPathArgs(opts.extraWorkingPaths),
      ...(hasAltScreen ? [] : ['--no-alt-screen']),
      ...args
    ],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'codex',
    approvalOwnership: 'provider-owned',
    capabilities: [
      'pty',
      'app-server',
      'remote-control',
      'provider-approval',
      'approval-resolution',
      'structured-output',
      'session-resume',
      'rollout-json-fallback'
    ]
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function parseStructuredAuthState(output: string): 'authenticated' | 'unauthenticated' | 'unknown' | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const record = parseJsonObject(rawLine.trim());
    if (!record) continue;
    if (record.state === 'authenticated' || record.authenticated === true || record.loggedIn === true)
      return 'authenticated';
    if (record.state === 'unauthenticated' || record.authenticated === false || record.loggedIn === false)
      return 'unauthenticated';
    if (record.state === 'unknown') return 'unknown';
  }
  return undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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

function parseCodexApprovalRequest(record: CodexJsonRpcNotification): NativeCliOutputEvent[] {
  const params = record.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const p = params as Record<string, unknown>;

  if (record.method === 'item/commandExecution/requestApproval') {
    return [
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
    ];
  }

  if (record.method === 'item/fileChange/requestApproval') {
    return [
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
    ];
  }

  if (record.method === 'item/permissions/requestApproval') {
    return [
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
    ];
  }

  if (record.method === 'execCommandApproval') {
    return [
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
    ];
  }

  if (record.method === 'applyPatchApproval') {
    return [
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
    ];
  }

  return [];
}

function parseCodexServerNotification(record: CodexJsonRpcNotification): NativeCliOutputEvent[] {
  const params = record.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const p = params as Record<string, unknown>;

  if (record.method === 'rawResponseItem/completed') {
    const item = p.item;
    if (isCodexResponseItem(item)) {
      return parseCodexResponseItem(item);
    }
  }

  if (record.method === 'turn/completed') {
    return [
      {
        type: 'agent_message',
        payload: { text: stringValue(p.text, p.result, p.outputText), final: true }
      }
    ];
  }

  if (record.method === 'thread/status/changed' && typeof p.threadId === 'string') {
    return [
      {
        type: 'session_ref',
        payload: compactObject({
          providerSessionRef: p.threadId,
          status: p.status
        })
      }
    ];
  }

  if (record.method === 'serverRequest/resolved') {
    return [
      {
        type: 'approval_resolved',
        payload: compactObject({
          requestId: p.requestId,
          threadId: p.threadId
        })
      }
    ];
  }

  return [];
}

function parseCodexClientResponse(record: CodexJsonRpcResponse): NativeCliOutputEvent[] {
  const error = record.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const e = error as Record<string, unknown>;
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          responseId: record.id,
          code: e.code,
          message: typeof e.message === 'string' ? e.message : JSON.stringify(e)
        })
      }
    ];
  }
  const result = record.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.data) && 'nextCursor' in r && 'backwardsCursor' in r) {
    return [
      {
        type: 'history_page',
        payload: {
          responseId: record.id,
          items: r.data,
          nextCursor: typeof r.nextCursor === 'string' ? r.nextCursor : null,
          backwardsCursor: typeof r.backwardsCursor === 'string' ? r.backwardsCursor : null
        }
      }
    ];
  }
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return [];
  const threadId = (thread as Record<string, unknown>).id;
  if (typeof threadId !== 'string') return [];
  return [
    {
      type: 'session_ref',
      payload: compactObject({
        providerSessionRef: threadId,
        responseId: record.id
      })
    }
  ];
}

function parseCodexSessionJsonl(chunk: string): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    const payload = record.payload;
    if (isCodexJsonRpcResponse(record)) {
      const responseEvents = parseCodexClientResponse(record);
      if (responseEvents.length > 0) {
        events.push(...responseEvents);
        continue;
      }
    }
    if (isCodexJsonRpcNotification(record)) {
      const appServerEvents = [...parseCodexApprovalRequest(record), ...parseCodexServerNotification(record)];
      if (appServerEvents.length > 0) {
        events.push(...appServerEvents);
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

function readCodexHistoryOutput(context: NativeCliProviderHistoryContext): string | null {
  return readProviderHistoryFile({
    roots: [join(homedir(), '.codex', 'sessions')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl'],
    limitBytes: context.limitBytes
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function codexHistoryPageOutput(context: NativeCliProviderHistoryPageContext): string | null {
  const records: Record<string, unknown>[] = [];
  for (const item of context.page.items) {
    const turn = recordValue(item);
    if (!turn) continue;
    const turnId = stringValue(turn.id);
    if (!turnId) continue;
    records.push({
      method: 'turn/started',
      params: {
        threadId: context.providerSessionRef,
        turnId,
        status: turn.status,
        startedAt: turn.startedAt
      }
    });
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const turnItem of items) {
      const record = recordValue(turnItem);
      if (!record) continue;
      records.push({
        method: 'item/completed',
        params: {
          threadId: context.providerSessionRef,
          turnId,
          item: record
        }
      });
    }
    records.push({
      method: 'turn/completed',
      params: {
        threadId: context.providerSessionRef,
        turnId,
        status: turn.status,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs
      }
    });
  }
  if (records.length === 0) return null;
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function buildCodexTurnStartRequest(id: number, threadId: string, input: string): Record<string, unknown> {
  return {
    method: 'turn/start',
    id,
    params: {
      threadId,
      input: [{ type: 'text', text: input }]
    }
  };
}

function buildCodexInitialTurnsPage(): Record<string, unknown> {
  return {
    limit: 20,
    sortDirection: 'desc',
    itemsView: 'summary'
  };
}

function initializeCodex(
  handle: Parameters<NonNullable<NativeCliProviderAdapter['initialize']>>[0],
  context: Parameters<NonNullable<NativeCliProviderAdapter['initialize']>>[1]
): void {
  if (handle.launchMode !== 'app-server') return;
  if (!handle.stdin) throw new Error('native CLI session has no app-server initialization bridge');
  const initializeId = handle.nextRequestId?.() ?? 0;
  const threadId = handle.nextRequestId?.() ?? 1;
  const threadRequest = context.providerSessionRef
    ? {
        method: 'thread/resume',
        id: threadId,
        params: {
          threadId: context.providerSessionRef,
          cwd: context.workingPath,
          ...((context.modelId ?? context.modelName) ? { model: context.modelId ?? context.modelName } : {}),
          ...(context.reasoningEffort ? { modelReasoningEffort: context.reasoningEffort } : {}),
          ...(context.developerInstructions ? { developerInstructions: context.developerInstructions } : {}),
          excludeTurns: true,
          initialTurnsPage: buildCodexInitialTurnsPage()
        }
      }
    : {
        method: 'thread/start',
        id: threadId,
        params: {
          cwd: context.workingPath,
          ...((context.modelId ?? context.modelName) ? { model: context.modelId ?? context.modelName } : {}),
          ...(context.reasoningEffort ? { modelReasoningEffort: context.reasoningEffort } : {}),
          ...(context.developerInstructions ? { developerInstructions: context.developerInstructions } : {})
        }
      };
  for (const message of [
    {
      method: 'initialize',
      id: initializeId,
      params: {
        clientInfo: { name: 'monad', title: 'Monad', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      }
    },
    { method: 'initialized', params: {} },
    threadRequest
  ]) {
    handle.stdin.write(`${JSON.stringify(message)}\n`);
  }
  void handle.stdin.flush?.();
}

function sendCodexInput(handle: Parameters<NativeCliProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'app-server') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.stdin) throw new Error('native CLI session has no app-server input bridge');
  if (!handle.providerSessionRef) throw new Error('native CLI app-server thread is not ready');
  handle.stdin.write(
    `${JSON.stringify(buildCodexTurnStartRequest(handle.nextRequestId?.() ?? Date.now(), handle.providerSessionRef, input))}\n`
  );
  void handle.stdin.flush?.();
}

function requestCodexHistoryPage(
  handle: Parameters<NonNullable<NativeCliProviderAdapter['requestHistoryPage']>>[0],
  request: Parameters<NonNullable<NativeCliProviderAdapter['requestHistoryPage']>>[1]
): string | number {
  if (handle.launchMode !== 'app-server') {
    throw new NativeCliError('unsupported_capability', 'Codex history paging requires app-server mode');
  }
  if (!handle.stdin)
    throw new NativeCliError('provider_protocol_error', 'native CLI session has no app-server history bridge');
  if (!handle.providerSessionRef) {
    throw new NativeCliError('provider_not_logged_in', 'native CLI app-server thread is not ready');
  }
  const id = handle.nextRequestId?.() ?? Date.now();
  handle.stdin.write(
    `${JSON.stringify({
      method: 'thread/turns/list',
      id,
      params: compactObject({
        threadId: handle.providerSessionRef,
        cursor: request.cursor,
        limit: request.limit,
        sortDirection: request.sortDirection,
        itemsView: request.itemsView
      })
    })}\n`
  );
  void handle.stdin.flush?.();
  return id;
}

function codexApprovalResult(request: Record<string, unknown> | undefined, allow: boolean): Record<string, unknown> {
  const kind = typeof request?.kind === 'string' ? request.kind : undefined;
  if (kind === 'execCommand' || kind === 'applyPatch') {
    return { decision: allow ? 'approved' : 'denied' };
  }
  if (kind === 'permissions') {
    return allow ? { permissions: {}, scope: 'turn' } : { permissions: {}, scope: 'turn', strictAutoReview: true };
  }
  return { decision: allow ? 'accept' : 'decline' };
}

function resolveCodexApproval(
  handle: Parameters<NativeCliProviderAdapter['resolveApproval']>[0],
  resolution: Parameters<NativeCliProviderAdapter['resolveApproval']>[1]
): void {
  if (handle.launchMode !== 'app-server') return;
  if (!handle.stdin) throw new Error('native CLI session has no app-server approval bridge');
  handle.stdin.write(
    `${JSON.stringify(buildCodexApprovalResponse(resolution.requestId, resolution.request, resolution.allow))}\n`
  );
  void handle.stdin.flush?.();
}

function buildCodexApprovalResponse(
  requestId: string,
  request: Record<string, unknown> | undefined,
  allow: boolean
): Record<string, unknown> {
  return {
    id: requestId,
    result: codexApprovalResult(request, allow)
  };
}

function resizeCodex(handle: Parameters<NativeCliProviderAdapter['resize']>[0], cols: number, rows: number): void {
  if (handle.launchMode === 'app-server') return;
  resizePty(handle, cols, rows);
}

function stopCodex(handle: Parameters<NativeCliProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'app-server') {
    void handle.stdin?.end?.();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}

export const codexNativeCliAdapter: NativeCliProviderAdapter = {
  provider: 'codex',
  productIcon: 'codex',
  detect(probes = defaultBinProbes) {
    const codexBin = resolveBinary('codex', [CODEX_APP_BIN], probes);
    const installed = codexBin !== undefined || probes.exists(join(homedir(), '.codex'));
    return {
      id: 'codex',
      label: 'Codex',
      provider: 'codex',
      productIcon: codexNativeCliAdapter.productIcon,
      command: 'codex',
      args: [],
      modelOptions: codexNativeCliAdapter.listSupportedModels(),
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'app-server', 'remote-control'],
      installHint: 'Install Codex CLI or Codex.app, then sign in with codex login.',
      installUrl: 'https://developers.openai.com/codex/cli',
      installed,
      resolvedBinPath: codexBin,
      capabilities: {
        auth: 'pty',
        history: 'paged',
        resume: 'structured',
        approval: 'provider-owned'
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, command === 'codex' ? [CODEX_APP_BIN] : [], probes);
  },
  listSupportedModels(agent) {
    return agent?.modelOptions?.length ? agent.modelOptions : CODEX_SUPPORTED_MODELS;
  },
  modelOptions(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['debug', 'models', '--bundled']),
      parse: (output) => parseCodexModelOptions(output)
    };
  },
  buildLaunch: buildCodexLaunch,
  buildAuthLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login', 'status']);
  },
  authStatus(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['login', 'status']),
      parse: (output, exitCode) => codexNativeCliAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['debug', 'models', '--bundled']),
      parse: (output) => parseCodexArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0) return 'authenticated';
    if (exitCode !== null) return 'unauthenticated';
    return 'unknown';
  },
  initialize: initializeCodex,
  parseOutput: parseCodexSessionJsonl,
  requestHistoryPage: requestCodexHistoryPage,
  historyPageOutput: codexHistoryPageOutput,
  historyOutput: readCodexHistoryOutput,
  sendInput: sendCodexInput,
  resolveApproval: resolveCodexApproval,
  resize: resizeCodex,
  stop: stopCodex
};
