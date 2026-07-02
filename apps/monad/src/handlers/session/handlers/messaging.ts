import type { AcpAgentConfig, McpServerConfig, NativeCliAgentConfig } from '@monad/home';
import type {
  ChannelResponseNextTarget,
  ChatMessage,
  Event,
  ManagedNativeCliLifecycleLogEvent,
  MessageId,
  NativeCliSessionView,
  SendMessageRequest,
  Session,
  SessionId,
  SessionMcpServer,
  SessionTransport,
  SessionUiEvent,
  TranscriptTarget,
  TranscriptTargetId,
  WorkplaceProjectMember,
  WorkplaceProjectMemberSettings
} from '@monad/protocol';
import type { ImageAttachment } from '@/agent/index.ts';
import type { Tool, ToolBackends } from '@/capabilities/tools/types.ts';
import type { CommandBundle, LifecycleOps } from '@/handlers/commands/index.ts';
import type { EventSink, SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import {
  newId,
  parseChannelStructuredResponse,
  workplaceProjectMembersExtKey,
  workplaceProjectMembersExtSchema
} from '@monad/protocol';

import { parseDurableSummary } from '@/agent/history.ts';
import { extractError } from '@/agent/index.ts';
import { buildChannelTurnContext, type ChannelParticipant, composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { emitCommandTurn, executeSessionCommand, tryRunSessionCommand } from '@/handlers/commands/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  CHANNEL_HOST_EXT_KEY,
  normalizeChannelModeratorId,
  routeChannelMessage
} from '@/handlers/session/channel-routing.ts';
import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';
import {
  acpAuthGuidance,
  directDelegate,
  sessionMcpServersToAcp,
  toAcpMcpServers
} from '@/services/delegation/acp-delegate.ts';
import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';

// Access control reads the write policy STORED on the session (origin.writableBy) — derived from the
// originating surface at creation, overridable per-session — not a label→transport lookup at the call
// site. Sessions with no origin stay unrestricted.
function assertWriteAllowed(session: TranscriptTarget, transport: SessionTransport): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Slash-command wiring, supplied by the session module once the lifecycle handlers exist. */
export interface MessagingCommandDeps {
  lifecycle: LifecycleOps;
  commands: CommandBundle;
}

type ToolFilter = (toolName: string) => boolean;
const CONTROL_ROOM_SESSION_PREFIX = 'Control Room: ';
const WORKPLACE_SESSION_PREFIX = 'Workplace: ';

// Size of the live UI snapshot window. Older history is paged lazily over GET /ui-items.
// Keep ≥ a realistic single agent round so a tool call+result pair never straddles the window.
const LIVE_SNAPSHOT_LIMIT = 80;
const MANAGED_NATIVE_CLI_RESUME_FAILED_COLD_START_EVENT =
  'project.managed_native_cli.resume_failed_cold_start' satisfies ManagedNativeCliLifecycleLogEvent;
const MANAGED_NATIVE_CLI_DELIVERY_ERROR_EVENT =
  'project.managed_native_cli.delivery_error' satisfies ManagedNativeCliLifecycleLogEvent;
const MANAGED_NATIVE_CLI_DIRECT_DELIVERY_ERROR_EVENT =
  'project.managed_native_cli.direct_delivery_error' satisfies ManagedNativeCliLifecycleLogEvent;
type NativeCliProjectMemberShape = {
  type: string;
  name: string;
  templateName?: string;
  displayName?: string;
  instanceId?: string;
  settings?: WorkplaceProjectMemberSettings;
};

interface ManagedNativeCliProjectMember {
  spec: NativeCliAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  settings: Pick<
    WorkplaceProjectMemberSettings,
    'managedProjectAgent' | 'launchMode' | 'modelName' | 'modelId' | 'reasoningEffort' | 'speed' | 'customPrompt'
  >;
}

/** AND two optional tool filters: a tool passes only if every present filter admits it. Undefined-safe;
 *  returns undefined when neither is set so the loop keeps its no-filter fast path. */
function composeFilter(a?: ToolFilter, b?: ToolFilter): ToolFilter | undefined {
  if (!a) return b;
  if (!b) return a;
  return (name) => a(name) && b(name);
}

function nativeCliProjectMemberSettings(
  session: TranscriptTarget,
  agentName: string
): Pick<
  WorkplaceProjectMemberSettings,
  'managedProjectAgent' | 'launchMode' | 'modelName' | 'modelId' | 'reasoningEffort' | 'speed' | 'customPrompt'
> {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return {};
  const member = parsed.data.find(
    (candidate) =>
      candidate.type === 'native-cli' &&
      (nativeCliProjectMemberRuntimeName(candidate) === agentName ||
        nativeCliProjectMemberTemplateName(candidate) === agentName)
  );
  if (member?.settings) {
    return {
      managedProjectAgent: member.settings.managedProjectAgent !== false,
      ...(member.settings.launchMode ? { launchMode: member.settings.launchMode } : {}),
      ...(member.settings.modelName ? { modelName: member.settings.modelName } : {}),
      ...(member.settings.modelId ? { modelId: member.settings.modelId } : {}),
      ...(member.settings.reasoningEffort ? { reasoningEffort: member.settings.reasoningEffort } : {}),
      ...(member.settings.speed ? { speed: member.settings.speed } : {}),
      ...(member.settings.customPrompt ? { customPrompt: member.settings.customPrompt } : {})
    };
  }
  return member ? { managedProjectAgent: true } : { managedProjectAgent: false };
}

function nativeCliProjectMemberDisplayNameForAgent(session: TranscriptTarget, agentName: string): string {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return agentName;
  const member = parsed.data.find(
    (candidate) =>
      candidate.type === 'native-cli' &&
      (nativeCliProjectMemberRuntimeName(candidate) === agentName ||
        nativeCliProjectMemberTemplateName(candidate) === agentName)
  );
  return member ? nativeCliProjectMemberDisplayName(member) : agentName;
}

function workplaceProjectMembers(session: TranscriptTarget): WorkplaceProjectMember[] {
  const parsed = workplaceProjectMembersExtSchema.safeParse(session.origin?.ext?.[workplaceProjectMembersExtKey]);
  return parsed.success ? parsed.data : [];
}

function nativeCliProjectMemberTemplateName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.templateName ?? member.name) : member.name;
}

function nativeCliProjectMemberRuntimeName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.instanceId ?? member.name) : member.name;
}

function nativeCliProjectMemberDisplayName(member: NativeCliProjectMemberShape): string {
  return member.type === 'native-cli' ? (member.displayName ?? member.name) : member.name;
}

function lastAgentMessageText(round: Event[]): string | null {
  for (let i = round.length - 1; i >= 0; i -= 1) {
    const event = round[i];
    if (event?.type !== 'agent.message') continue;
    const text = (event.payload as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

export function isChannelStructuredSession(session: Pick<Session, 'origin' | 'title'>): boolean {
  return (
    session.origin?.client === 'control-room' ||
    session.origin?.client === 'workplace' ||
    session.title.startsWith(CONTROL_ROOM_SESSION_PREFIX) ||
    session.title.startsWith(WORKPLACE_SESSION_PREFIX)
  );
}

function isWorkplaceProjectTarget(session: Pick<Session, 'origin' | 'title'>): boolean {
  return session.origin?.client === 'workplace' || session.title.startsWith(WORKPLACE_SESSION_PREFIX);
}

export function channelDelegateMcpServers(
  configured: readonly McpServerConfig[] | undefined,
  sessionScoped: readonly SessionMcpServer[] | undefined
) {
  return [...toAcpMcpServers([...(configured ?? [])]), ...sessionMcpServersToAcp([...(sessionScoped ?? [])])];
}

export function createMessagingHandlers(ctx: SessionContext, cmd?: MessagingCommandDeps) {
  const {
    deps: { agent, bus, cache, store, ownerPrincipalId, sessionSandbox, agentToolFilter, agentSandboxRoots, log },
    aborts,
    runtime,
    beginRun,
    makeEmit,
    persistAndRetire,
    requireTranscriptTarget
  } = ctx;

  // Effective fs/shell sandbox roots for a turn, single precedence chain so every call site agrees:
  // an explicit per-turn override (the editor's workspace) > the per-session runtime entry (set by
  // applyWorkspaceRuntime on /workdir, create, update) > the persisted session.cwd (source of truth,
  // so a working folder survives a daemon restart that left the in-memory runtime map empty) > the
  // bound agent's per-agent override. A site that also has an async ephemeral fallback applies it to
  // this result (`?? await …`).
  const sandboxRootsFor = (
    sessionId: TranscriptTargetId,
    cwd: string | undefined,
    rt: { sandboxRoots?: string[] } | undefined,
    override?: string[]
  ) =>
    override ??
    rt?.sandboxRoots ??
    (cwd ? [cwd] : sessionId.startsWith('ses_') ? agentSandboxRoots?.(sessionId as SessionId) : undefined);

  const runner = cmd ? { store, bus, lifecycle: cmd.lifecycle, commands: cmd.commands, ownerPrincipalId } : null;
  const pendingManagedNativeCliWakeMessages = new Map<string, MessageId>();

  function emitManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): MessageId {
    const existing = pendingManagedNativeCliWakeMessages.get(nativeCliSessionId);
    if (existing) return existing;
    const messageId = newId('msg');
    // Entries are deleted on completion, but a native CLI session that dies mid-turn never
    // completes; cap the map so abandoned wake placeholders can't accumulate for the daemon's
    // lifetime (oldest-first eviction — Map preserves insertion order).
    if (pendingManagedNativeCliWakeMessages.size >= 256) {
      const oldest = pendingManagedNativeCliWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedNativeCliWakeMessages.delete(oldest);
    }
    pendingManagedNativeCliWakeMessages.set(nativeCliSessionId, messageId);
    store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
      data: { agentName, nativeCliSessionId, reasoning: 'Thinking', source: 'managed-native-cli' },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    const emit = makeEmit(round);
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.token',
      actorAgentId: null,
      payload: { messageId, agentName, delta: '', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.reasoning',
      actorAgentId: null,
      payload: { messageId, delta: 'Thinking', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return messageId;
  }

  function completeManagedNativeCliThinking({
    sessionId,
    nativeCliSessionId,
    agentName,
    text
  }: {
    sessionId: TranscriptTargetId;
    nativeCliSessionId: string;
    agentName: string;
    text: string;
  }): MessageId | null {
    const messageId = pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ?? newId('msg');
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    const completed = store.setGenStatus(sessionId, messageId, 'complete', new Date().toISOString(), {
      data: { agentName, nativeCliSessionId, source: 'managed-native-cli' },
      includeInContext: true,
      text
    });
    if (!completed && !store.getMessage(sessionId, messageId)) {
      store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
        data: { agentName, nativeCliSessionId, source: 'managed-native-cli' }
      });
    }
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return messageId;
  }

  function startAcpAssignedTask({
    sessionId,
    spec,
    text,
    ambientContext,
    mcpServers
  }: {
    sessionId: TranscriptTargetId;
    spec: AcpAgentConfig;
    text: string;
    ambientContext?: string;
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): void {
    log?.debug({ sessionId, event: 'channel.next.dispatch', agent: spec.name, text }, 'channel next dispatch');
    const round: Event[] = [];
    const emit = makeEmit(round);
    const controller = new AbortController();
    const agentMsgId = newId('msg');
    const acpToolCallId = newId('tc');
    let tokenIndex = 0;
    let acpProcessOutput = '';
    let acpResponseOutput = '';

    const emitAcpActivityProgress = () => {
      const sections = [
        acpProcessOutput.trim(),
        acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
      ].filter(Boolean);
      emit({
        id: newId('evt'),
        transcriptTargetId: sessionId,
        type: 'tool.progress',
        actorAgentId: null,
        payload: {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: sections.join('\n\n') || 'waiting for response...'
        },
        at: new Date().toISOString()
      });
    };

    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'tool.called',
      actorAgentId: null,
      payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
      at: new Date().toISOString()
    });
    emitAcpActivityProgress();

    const rt = runtimeForTranscriptTarget(sessionId);
    directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
      sessionId,
      signal: controller.signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireTranscriptTarget(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers,
      onChunk: (delta) => {
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'agent.token',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
          at: new Date().toISOString()
        });
        acpResponseOutput += delta;
        emitAcpActivityProgress();
      },
      onActivity: (output) => {
        acpProcessOutput = output;
        emitAcpActivityProgress();
      }
    })
      .then((fullText) => {
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
          at: new Date().toISOString()
        });
        store.insertMessage(agentMsgId, sessionId, fullText, new Date().toISOString(), 'assistant', {
          data: { agentName: spec.name }
        });
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'agent.message',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      })
      .catch((err: unknown) => {
        const { code, message } = extractError(err);
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: message },
          at: new Date().toISOString()
        });
        store.insertMessage(
          agentMsgId,
          sessionId,
          code ? `[${code}] ${message}` : message,
          new Date().toISOString(),
          'assistant',
          { type: 'error', data: { agentName: spec.name } }
        );
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, code, message },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      });
  }

  async function dispatchChannelNextTargets({
    sessionId,
    responseText,
    ambientContext,
    acpAgents,
    mcpServers
  }: {
    sessionId: TranscriptTargetId;
    responseText: string;
    ambientContext: string;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): Promise<void> {
    const structured = parseChannelStructuredResponse(responseText);
    if (!structured?.next.length) return;
    const acpByName = new Map(acpAgents.map((agent) => [agent.name, agent]));
    for (const target of structured.next) {
      if (!target.agentId.startsWith('acp:')) continue;
      const agentName = target.agentId.slice(4);
      const spec = acpByName.get(agentName);
      if (!spec) continue;
      startAcpAssignedTask({
        sessionId,
        spec,
        text: channelNextPrompt(target),
        ambientContext,
        mcpServers
      });
    }
  }

  function channelNextPrompt(target: ChannelResponseNextTarget): string {
    return [
      target.title ? `Task: ${target.title}` : '',
      target.context ? `Context:\n${target.context}` : '',
      target.prompt
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function managedNativeCliProjectMembers(
    session: TranscriptTarget,
    nativeCliAgents: readonly NativeCliAgentConfig[]
  ): ManagedNativeCliProjectMember[] {
    const members = workplaceProjectMembers(session);
    const configured = new Map(nativeCliAgents.map((agent) => [agent.name, agent]));
    return members
      .filter((member) => member.type === 'native-cli' && member.settings?.managedProjectAgent !== false)
      .flatMap((member) => {
        const templateAgentName = nativeCliProjectMemberTemplateName(member);
        const spec = configured.get(templateAgentName);
        if (!spec) return [];
        return [
          {
            spec,
            runtimeAgentName: nativeCliProjectMemberRuntimeName(member),
            templateAgentName,
            displayName: nativeCliProjectMemberDisplayName(member),
            settings: {
              managedProjectAgent: true,
              ...(member.settings?.launchMode ? { launchMode: member.settings.launchMode } : {}),
              ...(member.settings?.modelName ? { modelName: member.settings.modelName } : {}),
              ...(member.settings?.modelId ? { modelId: member.settings.modelId } : {}),
              ...(member.settings?.reasoningEffort ? { reasoningEffort: member.settings.reasoningEffort } : {}),
              ...(member.settings?.speed ? { speed: member.settings.speed } : {}),
              ...(member.settings?.customPrompt ? { customPrompt: member.settings.customPrompt } : {})
            }
          }
        ];
      });
  }

  function projectAcpMembers(session: TranscriptTarget, acpAgents: readonly AcpAgentConfig[]): AcpAgentConfig[] {
    const configured = new Map(acpAgents.map((agent) => [agent.name, agent]));
    return workplaceProjectMembers(session)
      .filter((member) => member.type === 'acp')
      .flatMap((member) => {
        const spec = configured.get(member.name);
        return spec ? [spec] : [];
      });
  }

  async function deliverProjectMessageToAcpMembers({
    session,
    acpAgents,
    mcpServers,
    text,
    ambientContext
  }: {
    session: TranscriptTarget;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers: readonly McpServerConfig[] | undefined;
    text: string;
    ambientContext?: string;
  }): Promise<void> {
    const members = projectAcpMembers(session, acpAgents);
    if (members.length === 0) return;
    await Promise.all(
      members.map(async (spec) => {
        const round: Event[] = [];
        const emit = makeEmit(round);
        const agentMsgId = newId('msg');
        const acpToolCallId = newId('tc');
        let tokenIndex = 0;
        let acpProcessOutput = '';
        let acpResponseOutput = '';
        const emitAcpActivityProgress = (output = 'waiting for response...') => {
          emit({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'tool.progress',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, output },
            at: new Date().toISOString()
          });
        };
        emit({
          id: newId('evt'),
          transcriptTargetId: session.id,
          type: 'tool.called',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
          at: new Date().toISOString()
        });
        emitAcpActivityProgress();
        try {
          const rt = runtime.get(session.id);
          const fullText = await directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
            sessionId: session.id,
            signal: new AbortController().signal,
            sandboxRoots: sandboxRootsFor(session.id, session.cwd, rt),
            backends: rt?.backends,
            toolFilter: rt?.toolFilter,
            extraTools: rt?.extraTools,
            extraSkills: rt?.extraSkills,
            mcpServers: channelDelegateMcpServers(mcpServers, rt?.mcpServers),
            onChunk: (delta) => {
              emit({
                id: newId('evt'),
                transcriptTargetId: session.id,
                type: 'agent.token',
                actorAgentId: null,
                payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
                at: new Date().toISOString()
              });
              acpResponseOutput += delta;
              const sections = [
                acpProcessOutput.trim(),
                acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
              ].filter(Boolean);
              emitAcpActivityProgress(sections.join('\n\n') || 'waiting for response...');
            },
            onActivity: (output) => {
              acpProcessOutput = output;
              const sections = [
                acpProcessOutput.trim(),
                acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
              ].filter(Boolean);
              emitAcpActivityProgress(sections.join('\n\n') || 'waiting for response...');
            }
          });
          emit({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
            at: new Date().toISOString()
          });
          store.insertMessage(agentMsgId, session.id, fullText, new Date().toISOString(), 'assistant', {
            data: { agentName: spec.name }
          });
          emit({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'agent.message',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
            at: new Date().toISOString()
          });
        } catch (err) {
          const { code, message } = extractError(err);
          const hint = acpAuthGuidance(err, spec, ctx.deps.localeService?.t);
          const errorText = hint ? `${message}\n\n${hint}` : message;
          emit({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: errorText },
            at: new Date().toISOString()
          });
          store.insertMessage(
            agentMsgId,
            session.id,
            code ? `[${code}] ${errorText}` : errorText,
            new Date().toISOString(),
            'assistant',
            { type: 'error', data: { agentName: spec.name } }
          );
          emit({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'agent.error',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, code, message: errorText },
            at: new Date().toISOString()
          });
        } finally {
          persistAndRetire(session.id, round);
        }
      })
    );
  }

  function managedNativeCliInboxNotice(member: ManagedNativeCliProjectMember, text: string): string {
    return [
      'New Workplace Project message is available.',
      'Process this project message now.',
      '',
      `Your display name: ${member.displayName}`,
      `Your runtime agent id: ${member.runtimeAgentName}`,
      `Template agent: ${member.templateAgentName}`,
      `Provider: ${member.spec.provider}`,
      '',
      text,
      '',
      'Run `monad project inbox check` or `monad project read` before answering if you need more context.',
      'If a public response is appropriate, post it with `monad project post <text>`.',
      'Use `monad agent send --to <agent|human> <text>` only for private/direct conversation.',
      'Do not use greetings, small talk, or filler. Reply only with necessary project information.'
    ].join('\n');
  }

  function managedNativeCliBusyInboxNotice(member: ManagedNativeCliProjectMember): string {
    return [
      'New Workplace Project message is available.',
      'You are being woken to process the pending project inbox now.',
      '',
      `Your display name: ${member.displayName}`,
      `Your runtime agent id: ${member.runtimeAgentName}`,
      `Template agent: ${member.templateAgentName}`,
      `Provider: ${member.spec.provider}`,
      '',
      'You are already running. Run `monad project inbox check` or `monad project read` to fetch the latest project context.',
      'If a public response is appropriate, post it with `monad project post <text>`.',
      'Use `monad agent send --to <agent|human> <text>` only for private/direct conversation.',
      'Do not use greetings, small talk, or filler. Reply only with necessary project information.'
    ].join('\n');
  }

  function managedNativeCliDirectNotice({ fromAgentName, text }: { fromAgentName: string; text: string }): string {
    return [
      `New direct/private message from ${fromAgentName} is available.`,
      '',
      text,
      '',
      `Use \`monad agent read --with ${fromAgentName}\` to read the private conversation.`,
      `Reply privately with \`monad agent send --to ${fromAgentName} <text>\`.`,
      'Use `monad project post` only when you want to speak publicly in the Workplace Project.',
      'Terminal stdout/stderr is diagnostic output only. It is not a Workplace Project message.'
    ].join('\n');
  }

  function managedNativeCliResumeRecoveryNotice(notice: string): string {
    return [
      'Provider session resume failed. Monad started a fresh managed project runtime.',
      'Before replying, restore context from MEMORY.md and `monad project read`.',
      '',
      notice
    ].join('\n');
  }

  function nativeCliInputText(input: string): string {
    return input.endsWith('\n') ? input : `${input}\n`;
  }

  function normalizeManagedNativeCliDirectTarget(to: string): string {
    return to.startsWith('native-cli:') ? to.slice('native-cli:'.length) : to;
  }

  function recordManagedNativeCliProjectDeliveryError(
    sessionId: TranscriptTargetId,
    agentName: string,
    code: string | undefined,
    message: string
  ): void {
    const text = `${agentName} failed to process the project message: ${message}`;
    const messageId = newId('msg');
    const round: Event[] = [];
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      type: 'error',
      data: { agentName }
    });
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.error',
      actorAgentId: null,
      payload: {
        messageId,
        agentName,
        code: code ?? 'managed_native_cli_delivery_failed',
        message: text
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
  }

  function managedNativeCliSessionsForAgent(
    transcriptTargetId: TranscriptTargetId,
    agentName: string
  ): NativeCliSessionView[] {
    return (ctx.deps.nativeCliHost?.list(transcriptTargetId).sessions ?? []).filter(
      (candidate) => candidate.agentName === agentName && candidate.runtimeRole === 'managed-project-agent'
    );
  }

  async function startManagedNativeCliRuntimeWithRecovery({
    session,
    spec,
    runtimeAgentName,
    templateAgentName,
    displayName,
    modelName,
    modelId,
    reasoningEffort,
    speed,
    customPrompt,
    launchMode,
    providerSessionRef,
    input
  }: {
    session: TranscriptTarget;
    spec: NativeCliAgentConfig;
    runtimeAgentName: string;
    templateAgentName: string;
    displayName: string;
    modelName?: string;
    modelId?: string;
    reasoningEffort?: string;
    speed?: 'standard' | 'fast';
    customPrompt?: string;
    launchMode: NativeCliAgentConfig['defaultLaunchMode'];
    providerSessionRef?: string;
    input: string;
  }): Promise<NativeCliSessionView> {
    const nativeCliHost = ctx.deps.nativeCliHost;
    if (!nativeCliHost) throw new HandlerError('internal', 'native CLI host not configured');
    if (!session.cwd)
      throw new HandlerError('invalid', `native CLI agent "${spec.name}" requires a project working path`);
    const startArgs = {
      transcriptTargetId: session.id,
      agentName: runtimeAgentName,
      displayName,
      templateAgentName,
      workingPath: session.cwd,
      launchMode,
      runtimeRole: 'managed-project-agent' as const,
      modelName,
      modelId,
      reasoningEffort,
      speed,
      customPrompt
    };
    try {
      const nativeSession = await nativeCliHost.start({
        ...startArgs,
        providerSessionRef
      });
      nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(input) });
      return nativeSession;
    } catch (err) {
      if (!providerSessionRef) throw err;
      const { code, message } = extractError(err);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_NATIVE_CLI_RESUME_FAILED_COLD_START_EVENT,
          agentName: runtimeAgentName,
          providerSessionRef,
          code,
          message
        },
        'managed native cli resume failed; cold starting'
      );
      const round: Event[] = [];
      makeEmit(round)({
        id: newId('evt'),
        transcriptTargetId: session.id,
        type: 'native_cli.resume_failed',
        actorAgentId: null,
        payload: {
          agentName: runtimeAgentName,
          provider: spec.provider,
          providerSessionRef,
          code,
          message,
          fallback: 'cold-start'
        },
        at: new Date().toISOString()
      });
      persistAndRetire(session.id, round);
      const nativeSession = await nativeCliHost.start(startArgs);
      nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(managedNativeCliResumeRecoveryNotice(input)) });
      return nativeSession;
    }
  }

  async function deliverProjectMessageToManagedNativeCliMembers({
    session,
    nativeCliAgents,
    text,
    exceptAgentName
  }: {
    session: TranscriptTarget;
    nativeCliAgents: readonly NativeCliAgentConfig[];
    text: string;
    exceptAgentName?: string;
  }): Promise<void> {
    const managedMembers = managedNativeCliProjectMembers(session, nativeCliAgents);
    if (managedMembers.length === 0) return;
    const nativeCliHost = ctx.deps.nativeCliHost;
    if (!nativeCliHost || !session.cwd) return;
    for (const member of managedMembers) {
      const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
      if (runtimeAgentName === exceptAgentName) continue;
      try {
        const notice = managedNativeCliInboxNotice(member, text);
        const deliveredSeq = store.maxMessageSeq(session.id);
        const managedSessions = managedNativeCliSessionsForAgent(session.id, runtimeAgentName);
        const existing = managedSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          if (deliveredSeq > 0) store.enqueueNativeCliInboxItem(existing.id, deliveredSeq);
          emitManagedNativeCliThinking(session.id, existing.id, runtimeAgentName);
          if (existing.lastDeliveredSeq === 0) {
            nativeCliHost.input(existing.id, { input: nativeCliInputText(notice) });
            if (deliveredSeq > 0) store.markNativeCliInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq <= existing.lastVisibleSeq) {
            nativeCliHost.input(existing.id, { input: nativeCliInputText(managedNativeCliBusyInboxNotice(member)) });
          }
          store.markNativeCliInboxDelivered(existing.id, deliveredSeq);
          continue;
        }
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await nativeCliHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          const round: Event[] = [];
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            makeEmit(round)({
              id: newId('evt'),
              transcriptTargetId: session.id,
              type: 'native_cli.connection_required',
              actorAgentId: null,
              payload: {
                agentName: runtimeAgentName,
                provider: spec.provider,
                reason: preflight.reason,
                reconnectIn: 'studio'
              },
              at: new Date().toISOString()
            });
            persistAndRetire(session.id, round);
          }
          continue;
        }
        if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedNativeCliRuntimeWithRecovery({
          session,
          spec,
          runtimeAgentName,
          templateAgentName,
          displayName,
          reasoningEffort: settings.reasoningEffort,
          modelId: settings.modelId ?? settings.modelName,
          speed: settings.speed,
          customPrompt: settings.customPrompt,
          launchMode: managedProjectLaunchMode(spec, settings.launchMode),
          providerSessionRef: resumeFrom ?? undefined,
          input: notice
        });
        if (deliveredSeq > 0) store.enqueueNativeCliInboxItem(nativeSession.id, deliveredSeq);
        store.markNativeCliInboxDelivered(nativeSession.id, deliveredSeq);
        store.markNativeCliInboxVisible(nativeSession.id, deliveredSeq);
        emitManagedNativeCliThinking(session.id, nativeSession.id, runtimeAgentName);
      } catch (err) {
        const { code, message } = extractError(err);
        recordManagedNativeCliProjectDeliveryError(session.id, runtimeAgentName, code, message);
        log?.debug(
          {
            sessionId: session.id,
            event: MANAGED_NATIVE_CLI_DELIVERY_ERROR_EVENT,
            agentName: runtimeAgentName,
            code,
            message
          },
          'managed native cli project delivery failed'
        );
      }
    }
  }

  async function deliverDirectMessageToManagedNativeCliMember({
    session,
    nativeCliAgents,
    fromAgentName,
    to,
    text
  }: {
    session: TranscriptTarget;
    nativeCliAgents: readonly NativeCliAgentConfig[];
    fromAgentName: string;
    to: string;
    text: string;
  }): Promise<void> {
    const targetName = normalizeManagedNativeCliDirectTarget(to);
    if (!targetName || targetName === fromAgentName) return;
    const member = managedNativeCliProjectMembers(session, nativeCliAgents).find(
      (candidate) => candidate.runtimeAgentName === targetName
    );
    if (!member) return;
    const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
    const nativeCliHost = ctx.deps.nativeCliHost;
    if (!nativeCliHost || !session.cwd) return;
    try {
      const notice = managedNativeCliDirectNotice({ fromAgentName, text });
      const managedSessions = managedNativeCliSessionsForAgent(session.id, runtimeAgentName);
      const existing = managedSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        nativeCliHost.input(existing.id, { input: nativeCliInputText(notice) });
        return;
      }
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await nativeCliHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const round: Event[] = [];
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          makeEmit(round)({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'native_cli.connection_required',
            actorAgentId: null,
            payload: {
              agentName: runtimeAgentName,
              provider: spec.provider,
              reason: preflight.reason,
              reconnectIn: 'studio'
            },
            at: new Date().toISOString()
          });
          persistAndRetire(session.id, round);
        }
        return;
      }
      if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
      await startManagedNativeCliRuntimeWithRecovery({
        session,
        spec,
        runtimeAgentName,
        templateAgentName,
        displayName,
        reasoningEffort: settings.reasoningEffort,
        modelId: settings.modelId ?? settings.modelName,
        speed: settings.speed,
        customPrompt: settings.customPrompt,
        launchMode: managedProjectLaunchMode(spec, settings.launchMode),
        providerSessionRef: resumeFrom ?? undefined,
        input: notice
      });
    } catch (err) {
      const { code, message } = extractError(err);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_NATIVE_CLI_DIRECT_DELIVERY_ERROR_EVENT,
          fromAgentName,
          to,
          code,
          message
        },
        'managed native cli direct delivery failed'
      );
    }
  }

  const runtimeForTranscriptTarget = (sessionId: TranscriptTargetId) => runtime.get(sessionId);
  const agentToolFilterForTranscriptTarget = (sessionId: TranscriptTargetId) =>
    sessionId.startsWith('ses_') ? agentToolFilter?.(sessionId as SessionId) : undefined;

  const handlers = {
    async send({
      sessionId,
      text,
      generate,
      ambientContext,
      onComplete
    }: { sessionId: TranscriptTargetId; onComplete?: (text: string) => void | Promise<void> } & SendMessageRequest) {
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, 'http');
      log?.debug({ sessionId, event: 'session.send.accept', text, generate, ambientContext }, 'session send accept');
      // `busy` = a prior turn is still streaming for this session — the concurrency guard refuses a
      // command that would race it (the command check runs before beginRun, so aborts reflects prior).
      if (runner && (await tryRunSessionCommand(runner, session, text, { busy: aborts.has(sessionId) })))
        return { accepted: true as const };
      if (generate === false) {
        const messageId = newId('msg');
        const round: Event[] = [];
        store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'user');
        makeEmit(round)({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'user.message',
          actorAgentId: null,
          payload: { messageId, text },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
        log?.debug({ sessionId, event: 'session.send.recorded', messageId, text }, 'session send recorded');
        return { accepted: true as const };
      }
      const { round, signal } = beginRun(sessionId);
      const rt = runtimeForTranscriptTarget(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        ambientContext,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForTranscriptTarget(sessionId))
      });
      loop
        .runStream(sessionId, text, signal)
        .then(async () => {
          const finalText = lastAgentMessageText(round);
          persistAndRetire(sessionId, round);
          aborts.delete(sessionId);
          log?.debug({ sessionId, event: 'session.send.complete', finalText }, 'session send complete');
          if (finalText && onComplete) {
            try {
              await onComplete(finalText);
            } catch (err) {
              process.stderr.write(`channel next dispatch error (${sessionId}): ${err}\n`);
            }
          }
        })
        .catch((err: unknown) => {
          process.stderr.write(`runStream error (${sessionId}): ${err}\n`);
          log?.debug(
            {
              sessionId,
              event: 'session.send.error',
              err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
            },
            'session send error'
          );
          persistAndRetire(sessionId, round);
          aborts.delete(sessionId);
        });
      return { accepted: true as const };
    },

    async sendProjectMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const acpAgents = (cfg?.acpAgents ?? []).filter((agent: AcpAgentConfig) => agent.enabled !== false);
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      const isWorkplaceProject = isWorkplaceProjectTarget(session);
      const projectMembers = isWorkplaceProject ? workplaceProjectMembers(session) : [];
      const projectAcpAgentNames = projectMembers
        .filter((member) => member.type === 'acp')
        .map((member) => member.name);
      const projectNativeCliAgentNames = projectMembers
        .filter((member) => member.type === 'native-cli')
        .map((member) => nativeCliProjectMemberRuntimeName(member));
      const hasMonadMember = projectMembers.some((member) => member.type === 'monad');
      const moderatorAgentId = normalizeChannelModeratorId(session.origin?.ext?.[CHANNEL_HOST_EXT_KEY]);
      const route = routeChannelMessage({
        text,
        moderatorAgentId,
        acpAgentNames: isWorkplaceProject ? projectAcpAgentNames : acpAgents.map((agent: AcpAgentConfig) => agent.name),
        nativeCliAgentNames: isWorkplaceProject
          ? projectNativeCliAgentNames
          : nativeCliAgents.map((agent: NativeCliAgentConfig) => agent.name)
      });
      if (route.kind === 'none') return { accepted: true as const };
      const targetRole = moderatorAgentId && !route.direct ? 'moderator' : 'agent';
      log?.debug(
        {
          sessionId,
          transcriptTargetId: sessionId,
          event: 'project.message.route',
          text,
          moderatorAgentId,
          route,
          targetRole
        },
        'project message route'
      );
      const responseMode = moderatorAgentId
        ? targetRole === 'moderator'
          ? 'moderator_structured'
          : 'worker_plain'
        : route.direct
          ? 'direct_structured'
          : 'worker_plain';
      const studioAgents = cfg?.agent.agents ?? [];
      const studioHostName = moderatorAgentId?.startsWith('agent:')
        ? (studioAgents.find((agent) => `agent:${agent.id}` === moderatorAgentId)?.name ?? moderatorAgentId)
        : undefined;
      const nativeCliParticipants: ChannelParticipant[] = isWorkplaceProject
        ? projectMembers
            .filter((member) => member.type === 'native-cli')
            .map((member) => {
              const templateName = nativeCliProjectMemberTemplateName(member);
              return {
                id: `native-cli:${nativeCliProjectMemberRuntimeName(member)}`,
                name: nativeCliProjectMemberDisplayName(member),
                kind: 'native-cli' as const,
                description: `template:${templateName}`
              };
            })
        : nativeCliAgents.map((agent: NativeCliAgentConfig) => ({
            id: `native-cli:${agent.name}`,
            name: agent.name,
            kind: 'native-cli' as const
          }));
      const participants: ChannelParticipant[] = [
        { id: 'human', name: 'User', kind: 'human' },
        ...studioAgents.map((agent) => ({
          id: `agent:${agent.id}`,
          name: agent.name,
          kind: 'studio' as const,
          description: agent.description
        })),
        ...acpAgents.map((agent: AcpAgentConfig) => ({
          id: `acp:${agent.name}`,
          name: agent.name,
          kind: 'acp' as const
        })),
        ...nativeCliParticipants
      ];
      const ambientContext =
        route.kind === 'send' && route.generate === false
          ? undefined
          : buildChannelTurnContext({
              channelId: session.title,
              sessionId,
              routeKind: route.kind,
              targetName: route.kind === 'forward-acp' ? route.agentName : (studioHostName ?? 'monad'),
              targetRole,
              responseMode,
              moderatorAgentId,
              participants,
              targetMention: route.targetMention
            });
      const mcpServers = channelDelegateMcpServers(cfg?.mcpServers, runtimeForTranscriptTarget(sessionId)?.mcpServers);
      const isPublicProjectFanout = isWorkplaceProject && route.kind === 'send' && !route.direct && !moderatorAgentId;
      const publicAmbientContext = buildChannelTurnContext({
        channelId: session.title,
        sessionId,
        routeKind: route.kind,
        targetName: 'project members',
        targetRole,
        responseMode,
        moderatorAgentId,
        participants,
        targetMention: route.targetMention
      });
      const dispatchStructuredNext =
        ambientContext && (responseMode === 'moderator_structured' || responseMode === 'direct_structured')
          ? (responseText: string) =>
              dispatchChannelNextTargets({
                sessionId,
                responseText,
                ambientContext,
                acpAgents,
                mcpServers
              })
          : undefined;
      if (route.kind === 'send') {
        if (isPublicProjectFanout) {
          const shouldRunMonad = hasMonadMember || route.generate === true;
          const result = shouldRunMonad
            ? await handlers.send({
                sessionId,
                text: route.text,
                ambientContext: publicAmbientContext
              })
            : await handlers.send({ sessionId, text: route.text, generate: false });
          await Promise.all([
            deliverProjectMessageToManagedNativeCliMembers({ session, nativeCliAgents, text: route.text }),
            deliverProjectMessageToAcpMembers({
              session,
              acpAgents,
              mcpServers: cfg?.mcpServers,
              text: route.text,
              ambientContext: publicAmbientContext
            })
          ]);
          return result;
        }
        const routeGenerate =
          moderatorAgentId || !isWorkplaceProject ? route.generate : hasMonadMember ? route.generate : false;
        const result = await handlers.send({
          sessionId,
          text: route.text,
          generate: routeGenerate,
          ambientContext,
          onComplete: dispatchStructuredNext
        });
        if (!route.direct && route.generate === false) {
          await deliverProjectMessageToManagedNativeCliMembers({ session, nativeCliAgents, text: route.text });
        }
        return result;
      }
      if (route.kind === 'forward-native-cli')
        return handlers.forwardToNativeCli({
          sessionId,
          agentName: route.agentName,
          text: route.text,
          displayText: route.displayText
        });
      return handlers.forwardToAcp({
        sessionId,
        agentName: route.agentName,
        text: route.text,
        displayText: route.displayText,
        ambientContext,
        onComplete: dispatchStructuredNext
      });
    },

    async sendChannelMessage({ sessionId, text }: { sessionId: TranscriptTargetId; text: string }) {
      return handlers.sendProjectMessage({ sessionId, text });
    },

    async notifyManagedNativeCliProjectMembers({
      sessionId,
      text,
      exceptAgentName
    }: {
      sessionId: TranscriptTargetId;
      text: string;
      exceptAgentName?: string;
    }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      await deliverProjectMessageToManagedNativeCliMembers({ session, nativeCliAgents, text, exceptAgentName });
      return { accepted: true as const };
    },

    async notifyManagedNativeCliDirectMessage({
      sessionId,
      fromAgentName,
      to,
      text
    }: {
      sessionId: TranscriptTargetId;
      fromAgentName: string;
      to: string;
      text: string;
    }) {
      const session = requireTranscriptTarget(sessionId);
      const paths = ctx.deps.paths;
      const cfg = paths ? await loadAll(paths.config, paths.profile) : null;
      const nativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      await deliverDirectMessageToManagedNativeCliMember({ session, nativeCliAgents, fromAgentName, to, text });
      return { accepted: true as const };
    },

    async completeManagedNativeCliProjectMessage({
      sessionId,
      nativeCliSessionId,
      agentName,
      text
    }: {
      sessionId: TranscriptTargetId;
      nativeCliSessionId: string;
      agentName: string;
      text: string;
    }) {
      return {
        messageId: completeManagedNativeCliThinking({ sessionId, nativeCliSessionId, agentName, text })
      };
    },

    async completeManagedNativeCliProviderMessage({
      sessionId,
      nativeCliSessionId,
      agentName,
      text,
      error
    }: {
      sessionId: TranscriptTargetId;
      nativeCliSessionId: string;
      agentName: string;
      text: string;
      error?: boolean;
    }) {
      const messageId =
        completeManagedNativeCliThinking({ sessionId, nativeCliSessionId, agentName, text }) ?? newId('msg');
      store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
        ...(error ? { type: 'error' as const } : {}),
        data: { agentName, nativeCliSessionId, source: 'native-cli-provider' }
      });
      return { messageId };
    },

    async sendInline(
      { sessionId, text }: { sessionId: TranscriptTargetId } & SendMessageRequest,
      sink: EventSink,
      // ACP sessions pass a delegating backend (fs/shell run in the connected editor), a toolFilter
      // dropping tools that would otherwise run on the daemon host, and any image attachments for
      // the turn. Other transports omit these and the loop defaults to sandbox + text-only.
      runOpts?: {
        transport?: SessionTransport;
        backends?: ToolBackends;
        toolFilter?: (toolName: string) => boolean;
        attachments?: ImageAttachment[];
        ambientContext?: string;
        extraTools?: Tool[];
        sandboxRoots?: string[];
      }
    ) {
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, runOpts?.transport ?? 'acp');
      if (runner && (await tryRunSessionCommand(runner, session, text, { sink, busy: aborts.has(sessionId) }))) return;
      // Out-of-band per-session runtime config (sandbox roots / session-scoped MCP tools / delegating
      // backends) set via configureRuntime — used when the caller doesn't pass explicit runOpts (the
      // ACP bridge proxies turns over HTTP and can't ship in-process backends, so it configures the
      // daemon out-of-band).
      const rt = runtimeForTranscriptTarget(sessionId);
      // Shared precedence (runOpts override > rt > session.cwd > per-agent), then this session's
      // disposable ephemeral root (sandbox mode 'ephemeral'), then the loop's global default.
      const sandboxRoots =
        sandboxRootsFor(sessionId, session.cwd, rt, runOpts?.sandboxRoots) ?? (await sessionSandbox?.ensure(sessionId));
      const { round, signal } = beginRun(sessionId);
      const base = makeEmit(round);
      const loop = agent.loop(
        (event) => {
          base(event);
          sink(event);
        },
        {
          backends: runOpts?.backends ?? rt?.backends,
          toolFilter: composeFilter(
            runOpts?.toolFilter ?? rt?.toolFilter,
            agentToolFilterForTranscriptTarget(sessionId)
          ),
          ambientContext: runOpts?.ambientContext,
          extraTools: runOpts?.extraTools ?? rt?.extraTools,
          extraSkills: rt?.extraSkills,
          sandboxRoots,
          defaultCwd: session.cwd,
          modelOverride: session.model
        }
      );
      // Oversight (tool.approval_requested) and clarify (clarify.requested) are emitted by their
      // services straight to the bus, NOT through the loop's emit — so an inline consumer (ACP)
      // would never see them. Bridge those out-of-band events into the same sink for this turn.
      // Live-only (bus.subscribe doesn't replay) and filtered, so loop events aren't duplicated.
      const oob = bus.subscribe(sessionId, (event) => {
        switch (event.type) {
          case 'tool.approval_requested':
          case 'tool.approval_resolved':
          case 'clarify.requested':
          case 'clarify.resolved':
          case 'session.updated': // title/metadata changes → editors get a live session_info_update
          // Reverse fs/terminal delegation: the ACP bridge consumes these off the turn's stream and
          // services them against the editor, answering via the delegation.respond RPC.
          case 'delegation.fs_request':
          case 'delegation.terminal_request':
            sink(event);
        }
      });
      try {
        await loop.runStream(sessionId, text, signal, runOpts?.attachments);
      } finally {
        oob();
        persistAndRetire(sessionId, round);
        aborts.delete(sessionId);
      }
    },

    async generate({ sessionId, text }: { sessionId: TranscriptTargetId } & SendMessageRequest) {
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, 'http');
      log?.debug({ sessionId, event: 'session.generate.start', text }, 'session generate start');
      if (runner) {
        const result = await executeSessionCommand(runner, session, text, { busy: aborts.has(sessionId) });
        if (result !== null) {
          const round: Event[] = [];
          const message = emitCommandTurn(store, makeEmit(round), sessionId, text, result);
          store.appendEvents(round);
          cache.retire(sessionId);
          return { message };
        }
      }
      const round: Event[] = [];
      const rt = runtimeForTranscriptTarget(sessionId);
      const loop = agent.loop(makeEmit(round), {
        modelOverride: session.model,
        sandboxRoots: sandboxRootsFor(sessionId, session.cwd, rt),
        defaultCwd: session.cwd,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        toolFilter: composeFilter(rt?.toolFilter, agentToolFilterForTranscriptTarget(sessionId))
      });
      try {
        const msg = await loop.runBlock(sessionId, text);
        log?.debug({ sessionId, event: 'session.generate.complete', text: msg.text }, 'session generate complete');
        const message: ChatMessage = {
          id: msg.id as ChatMessage['id'],
          transcriptTargetId: msg.transcriptTargetId as ChatMessage['transcriptTargetId'],
          role: msg.role,
          text: msg.text,
          type: 'text',
          stream: { status: 'complete' },
          active: true,
          createdAt: msg.createdAt
        };
        return { message };
      } catch (err) {
        // The model/gateway failed upstream — the daemon itself is healthy, so 502
        // (Bad Gateway) is the accurate status, not 500. runBlock already persisted
        // and emitted the failure; surface the parsed message in the response body.
        const { code, message } = extractError(err);
        log?.debug({ sessionId, event: 'session.generate.error', code, message }, 'session generate error');
        throw new HandlerError('bad_gateway', code ? `[${code}] ${message}` : message);
      } finally {
        persistAndRetire(sessionId, round);
      }
    },

    async subscribe(
      { sessionId, afterEventId }: { sessionId: TranscriptTargetId; afterEventId?: string },
      sink: EventSink
    ) {
      const buffered = cache.since(sessionId, afterEventId);
      let replay: Event[];
      if (afterEventId !== undefined && store.hasEvent(afterEventId)) {
        // Reconnect from a persisted cursor: durable events after it cover COMPLETED rounds the client
        // missed while disconnected, while `buffered` holds only the in-flight (un-persisted) round.
        // Using `buffered` alone would drop every finished round between the cursor and the active one.
        // Merge, de-duped by id (the two sets are normally disjoint — tokens are never persisted).
        const durable = store.listEvents(sessionId, afterEventId);
        const seen = new Set(durable.map((e) => e.id));
        replay = [...durable, ...buffered.filter((e) => !seen.has(e.id))];
      } else {
        // Fresh subscribe, or a cursor that is an un-persisted live event (client resuming within the
        // active round): `buffered` is the correct tail; fall back to durable only when idle. Passing
        // an un-persisted cursor to listEvents would replay the whole session (missing-cursor fallback).
        replay = buffered.length > 0 ? buffered : store.listEvents(sessionId, afterEventId);
      }
      for (const event of replay) sink(event);
      const dispose = bus.subscribe(sessionId, sink);
      return { subscribed: true as const, dispose };
    },

    async subscribeUi(
      { sessionId, afterEventId }: { sessionId: TranscriptTargetId; afterEventId?: string },
      sink: (event: SessionUiEvent) => void
    ) {
      const session = requireTranscriptTarget(sessionId);
      const projector = new SessionUiProjector({ channelStructured: isChannelStructuredSession(session) });
      // Bound the initial snapshot to the most-recent window; older history is loaded lazily by
      // the client over GET /ui-items. A full window implies there may be older messages.
      const recent = store.listMessages(sessionId, {
        includeInactive: false,
        latest: true,
        limit: LIVE_SNAPSHOT_LIMIT
      });
      const hasMore = recent.length === LIVE_SNAPSHOT_LIMIT;
      projector.hydrateMessages(recent, parseDurableSummary(store.getMemory(sessionId, 'ctx:summary')));
      // Rebuild native CLI tool cards from their durable output snapshots (native_cli.output chunks are
      // not persisted as events). Scope to this window: runs that started within it, plus any still
      // active, so an in-flight or recent CLI run survives a refresh/reconnect without dragging every
      // historical run into the bounded snapshot.
      const oldestTs = recent[0]?.createdAt;
      projector.hydrateNativeCliSessions(
        store
          .listNativeCliSessionsForTranscriptTarget(sessionId)
          .filter(
            (s) =>
              s.runtimeRole === 'managed-project-agent' ||
              s.state === 'running' ||
              s.state === 'starting' ||
              oldestTs === undefined ||
              s.startedAt >= oldestTs
          )
      );
      // Replay only the in-flight (un-persisted) round on top of the hydrated window. This is a
      // snapshot endpoint (the client replaces its view wholesale), so hydration IS the reconnect
      // baseline — every settled round is already in the bounded message window. We must NOT replay
      // the durable event log here: a reconnect cursor is usually an `agent.token` id that isn't in
      // the log, so listEvents would fall back to a full-session replay and scramble the bounded
      // snapshot (breaking oldestCursor/hasMore pagination). The active round lives only in `buffered`.
      const buffered = cache.since(sessionId, afterEventId);
      for (const event of buffered) projector.applyEvent(event);
      sink(projector.snapshot({ hasMore }));
      const dispose = bus.subscribe(sessionId, (event) => {
        for (const uiEvent of projector.applyEvent(event)) sink(uiEvent);
      });
      return { subscribed: true as const, dispose };
    },

    /**
     * Subscribe to the cross-session control stream (session-list-level changes
     * across all sessions). No replay: a (re)connecting client should re-fetch the
     * list via `sessions.list`, then apply live deltas from here.
     */
    subscribeControl(sink: EventSink) {
      const dispose = bus.subscribeControl(sink);
      return { subscribed: true as const, dispose };
    },

    /** Send text directly to a configured ACP agent, bypassing the monad LLM layer.
     *  Emits user.message + streaming agent.token + final agent.message into the session event stream
     *  so the existing session subscriber sees the exchange without any monad turn overhead. */
    async forwardToAcp({
      sessionId,
      agentName,
      text,
      displayText,
      ambientContext,
      onComplete
    }: {
      sessionId: TranscriptTargetId;
      agentName: string;
      text: string;
      displayText?: string;
      ambientContext?: string;
      onComplete?: (text: string) => void | Promise<void>;
    }) {
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, 'http');
      // Reject if a turn is already streaming for this session — same concurrency guard as `send`.
      if (aborts.has(sessionId)) throw new HandlerError('conflict', 'a turn is already in progress for this session');
      const paths = ctx.deps.paths;
      if (!paths) throw new HandlerError('internal', 'daemon paths not configured');
      const cfg = await loadAll(paths.config, paths.profile);
      const spec = (cfg?.acpAgents ?? []).find((a: AcpAgentConfig) => a.name === agentName && a.enabled !== false);
      if (!spec) throw new HandlerError('invalid', `ACP agent "${agentName}" not found or disabled`);
      log?.debug(
        { sessionId, event: 'session.forward_acp.start', agentName, text, ambientContext },
        'forward acp start'
      );

      const { round, signal } = beginRun(sessionId);
      const emit = makeEmit(round);
      const userMsgId = newId('msg');
      const agentMsgId = newId('msg');
      const acpToolCallId = newId('tc');
      let tokenIndex = 0;
      let acpActivityStarted = false;
      let acpProcessOutput = '';
      let acpResponseOutput = '';

      const emitAcpActivityStart = () => {
        if (acpActivityStarted) return;
        acpActivityStarted = true;
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'tool.called',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
          at: new Date().toISOString()
        });
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'tool.progress',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, output: 'waiting for response...' },
          at: new Date().toISOString()
        });
      };
      const emitAcpActivityProgress = () => {
        const sections = [
          acpProcessOutput.trim(),
          acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
        ].filter(Boolean);
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'tool.progress',
          actorAgentId: null,
          payload: {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            output: sections.join('\n\n') || 'waiting for response...'
          },
          at: new Date().toISOString()
        });
      };

      emit({
        id: newId('evt'),
        transcriptTargetId: sessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId: userMsgId, text: displayText ?? text },
        at: new Date().toISOString()
      });
      store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');

      const rt = runtimeForTranscriptTarget(sessionId);
      emitAcpActivityStart();
      directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
        sessionId,
        signal,
        sandboxRoots: sandboxRootsFor(sessionId, requireTranscriptTarget(sessionId).cwd, rt),
        backends: rt?.backends,
        toolFilter: rt?.toolFilter,
        extraTools: rt?.extraTools,
        extraSkills: rt?.extraSkills,
        mcpServers: channelDelegateMcpServers(cfg?.mcpServers, rt?.mcpServers),
        onChunk: (delta) => {
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'agent.token',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
            at: new Date().toISOString()
          });
          acpResponseOutput += delta;
          emitAcpActivityProgress();
        },
        onActivity: (output) => {
          acpProcessOutput = output;
          emitAcpActivityProgress();
        }
      })
        .then(async (fullText) => {
          log?.debug(
            { sessionId, event: 'session.forward_acp.complete', agentName: spec.name, fullText },
            'forward acp complete'
          );
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
            at: new Date().toISOString()
          });
          store.insertMessage(agentMsgId, sessionId, fullText, new Date().toISOString(), 'assistant', {
            data: { agentName: spec.name }
          });
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'agent.message',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
            at: new Date().toISOString()
          });
          if (onComplete) {
            try {
              await onComplete(fullText);
            } catch (err) {
              process.stderr.write(`channel next dispatch error (${sessionId}): ${err}\n`);
            }
          }
          persistAndRetire(sessionId, round);
        })
        .catch((err: unknown) => {
          const { code, message } = extractError(err);
          log?.debug(
            { sessionId, event: 'session.forward_acp.error', agentName: spec.name, code, message },
            'forward acp error'
          );
          const hint = acpAuthGuidance(err, spec, ctx.deps.localeService?.t);
          const errorText = hint ? `${message}\n\n${hint}` : message;
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'tool.result',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: errorText },
            at: new Date().toISOString()
          });
          store.insertMessage(
            agentMsgId,
            sessionId,
            code ? `[${code}] ${errorText}` : errorText,
            new Date().toISOString(),
            'assistant',
            {
              type: 'error',
              data: { agentName: spec.name }
            }
          );
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'agent.error',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, code, message: errorText },
            at: new Date().toISOString()
          });
          try {
            persistAndRetire(sessionId, round);
          } catch (innerErr) {
            process.stderr.write(`forwardToAcp persistAndRetire error (${sessionId}): ${innerErr}\n`);
          }
        })
        .finally(() => aborts.delete(sessionId));

      return { accepted: true as const };
    },

    async forwardToNativeCli({
      sessionId,
      agentName,
      text,
      displayText
    }: {
      sessionId: TranscriptTargetId;
      agentName: string;
      text: string;
      displayText?: string;
    }) {
      const session = requireTranscriptTarget(sessionId);
      assertWriteAllowed(session, 'http');
      const userRound: Event[] = [];
      const userEmit = makeEmit(userRound);
      const userMsgId = newId('msg');
      userEmit({
        id: newId('evt'),
        transcriptTargetId: sessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId: userMsgId, text: displayText ?? text },
        at: new Date().toISOString()
      });
      store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');
      persistAndRetire(sessionId, userRound);

      const emitNativeCliError = (err: unknown, fallbackCode?: string) => {
        const { code, message } = extractError(err);
        const agentMsgId = newId('msg');
        const round: Event[] = [];
        const emit = makeEmit(round);
        store.insertMessage(
          agentMsgId,
          sessionId,
          (code ?? fallbackCode) ? `[${code ?? fallbackCode}] ${message}` : message,
          new Date().toISOString(),
          'assistant',
          { type: 'error', data: { agentName } }
        );
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName, code: code ?? fallbackCode, message },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
      };

      const paths = ctx.deps.paths;
      if (!paths) {
        emitNativeCliError(new HandlerError('internal', 'daemon paths not configured'));
        return { accepted: true as const };
      }
      const nativeCliHost = ctx.deps.nativeCliHost;
      if (!nativeCliHost) {
        emitNativeCliError(new HandlerError('internal', 'native CLI host not configured'));
        return { accepted: true as const };
      }
      const cfg = await loadAll(paths.config, paths.profile);
      const configuredNativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
        (agent: NativeCliAgentConfig) => agent.enabled !== false
      );
      const managedMember = managedNativeCliProjectMembers(session, configuredNativeCliAgents).find(
        (candidate) => candidate.runtimeAgentName === agentName || candidate.templateAgentName === agentName
      );
      const runtimeAgentName = managedMember?.runtimeAgentName ?? agentName;
      const templateAgentName = managedMember?.templateAgentName ?? agentName;
      const spec =
        managedMember?.spec ??
        configuredNativeCliAgents.find((agent: NativeCliAgentConfig) => agent.name === templateAgentName);
      if (!spec) {
        emitNativeCliError(new HandlerError('invalid', `native CLI agent "${agentName}" not found or disabled`));
        return { accepted: true as const };
      }
      if (!session.cwd) {
        emitNativeCliError(
          new HandlerError('invalid', `native CLI agent "${agentName}" requires a project working path`)
        );
        return { accepted: true as const };
      }
      log?.debug({ sessionId, event: 'session.forward_native_cli.start', agentName, text }, 'forward native cli start');
      try {
        const memberSettings = managedMember?.settings ?? nativeCliProjectMemberSettings(session, runtimeAgentName);
        const runtimeRole = memberSettings.managedProjectAgent ? 'managed-project-agent' : 'interactive';
        const nativeSessions = nativeCliHost
          .list(sessionId)
          .sessions.filter(
            (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === runtimeRole
          );
        const existing = nativeSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          nativeCliHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
          log?.debug(
            { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: existing.id },
            'forward native cli accepted'
          );
          return { accepted: true as const };
        }
        const preflight = await nativeCliHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          const reason = preflight.reason;
          const round: Event[] = [];
          const emit = makeEmit(round);
          const agentMsgId = newId('msg');
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            emit({
              id: newId('evt'),
              transcriptTargetId: sessionId,
              type: 'native_cli.connection_required',
              actorAgentId: null,
              payload: {
                agentName,
                provider: spec.provider,
                reason,
                reconnectIn: 'studio'
              },
              at: new Date().toISOString()
            });
          }
          store.insertMessage(agentMsgId, sessionId, reason, new Date().toISOString(), 'assistant', {
            type: 'error',
            data: { agentName }
          });
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'agent.error',
            actorAgentId: null,
            payload: {
              messageId: agentMsgId,
              agentName,
              code:
                preflight.state === 'not_authenticated'
                  ? 'provider_auth_required'
                  : preflight.state === 'unavailable'
                    ? 'provider_unavailable'
                    : 'provider_readiness_unknown',
              message: reason
            },
            at: new Date().toISOString()
          });
          persistAndRetire(sessionId, round);
          log?.debug(
            {
              sessionId,
              event: 'session.forward_native_cli.preflight_blocked',
              agentName,
              provider: spec.provider,
              state: preflight.state
            },
            'forward native cli connection required'
          );
          return { accepted: true as const };
        }
        const resumeFrom =
          runtimeRole === 'managed-project-agent'
            ? nativeSessions.find((candidate) => candidate.providerSessionRef)?.providerSessionRef
            : undefined;
        const nativeSession =
          runtimeRole === 'managed-project-agent'
            ? await startManagedNativeCliRuntimeWithRecovery({
                session,
                spec,
                runtimeAgentName,
                templateAgentName,
                displayName: nativeCliProjectMemberDisplayNameForAgent(session, runtimeAgentName),
                reasoningEffort: memberSettings.reasoningEffort,
                modelId: memberSettings.modelId ?? memberSettings.modelName,
                speed: memberSettings.speed,
                customPrompt: memberSettings.customPrompt,
                launchMode: managedProjectLaunchMode(spec, memberSettings.launchMode),
                providerSessionRef: resumeFrom ?? undefined,
                input: text
              })
            : await nativeCliHost.start({
                transcriptTargetId: sessionId,
                agentName: runtimeAgentName,
                templateAgentName,
                workingPath: session.cwd,
                launchMode: memberSettings.launchMode ?? spec.defaultLaunchMode,
                runtimeRole
              });
        if (runtimeRole !== 'managed-project-agent') {
          nativeCliHost.input(nativeSession.id, { input: nativeCliInputText(text) });
        }
        log?.debug(
          { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: nativeSession.id },
          'forward native cli accepted'
        );
      } catch (err) {
        const { code, message } = extractError(err);
        log?.debug(
          { sessionId, event: 'session.forward_native_cli.error', agentName, code, message },
          'forward native cli error'
        );
        emitNativeCliError(err);
      }
      return { accepted: true as const };
    }
  };
  return handlers;
}
