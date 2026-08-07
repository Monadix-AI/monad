import type { ChannelInstanceConfig } from '@monad/environment';
import type { ChannelInbound, SessionId } from '@monad/protocol';
import type { ChannelAdapter, CommandProjectInfo, CommandProjectSelection, CommandResult } from '@monad/sdk-atom';
import type { ChannelRoute, ChannelServiceDeps, ChannelTranslate, Instance } from '#/channels/types.ts';

import { errMsg } from '#/channels/helpers.ts';
import { type ChannelRenderMode, createRenderer } from '#/channels/render.ts';
import {
  type CommandBundle,
  type CommandExecution,
  type CommandServices,
  emitCommandTurn,
  executeCommand,
  type SessionNavigator
} from '#/handlers/commands/index.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';

const CHANNEL_BLOCKED_COMMANDS = new Set(['workdir']);
const PROJECT_SESSION_COMMANDS = new Set(['project', 'help', 'sessions', 'switch']);

type ChannelConversationEnvironment = 'chat' | 'project';

export interface CommandHost {
  deps: ChannelServiceDeps;
  channelT: ChannelTranslate;
  instances: Map<string, Instance>;
  resolveSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId>;
  startNewSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId>;
  registerMirror(channelId: string, conversationKey: string, sessionId: SessionId, adapter: ChannelAdapter): void;
  getRenderMode(channelId: string, conversationKey: string): ChannelRenderMode;
  setRenderMode(channelId: string, conversationKey: string, mode: ChannelRenderMode): void;
  listProjects(c: ChannelInstanceConfig, key: string): Promise<CommandProjectInfo[]>;
  currentProject(c: ChannelInstanceConfig, key: string): Promise<CommandProjectInfo | null>;
  hasPendingProject(c: ChannelInstanceConfig, key: string): boolean;
  clearPendingProject(c: ChannelInstanceConfig, key: string): void;
  useProject(
    c: ChannelInstanceConfig,
    key: string,
    target: string,
    label?: string
  ): Promise<CommandProjectSelection | null>;
  leaveProject(c: ChannelInstanceConfig, key: string, label?: string): Promise<{ sessionId?: string }>;
}

/** Dispatch one in-band command through the unified registry with a conversation-keyed navigator.
 *  Returns false when the text isn't a host command (→ caller routes it to the agent). */
export async function runCommand(
  host: CommandHost,
  inst: Instance,
  c: ChannelInstanceConfig,
  key: string,
  m: ChannelInbound,
  options: { sessionlessProject?: boolean } = {}
): Promise<boolean> {
  if (!inst.adapter) return false;
  const bundle = host.deps.commands;
  if (!bundle) return false;
  const command = m.command;
  if (!command) return false;
  const environment = channelConversationEnvironment(host, c, key);
  const entry = bundle.registry.resolve(command);
  if (!entry) {
    const skill = bundle.skills().find((candidate) => candidate.name === command);
    if (skill?.userInvocable && skill.available) return false;
  }
  const persistedSessionId = options.sessionlessProject
    ? undefined
    : await host.resolveSession(c, key, m.senderDisplay);
  // An unbound /project command only uses Project navigation services; this id is never persisted.
  const sessionId = persistedSessionId ?? ('ses_CHANNEL_UNBOUND' as SessionId);
  const text = `/${command}${m.commandArgs.length ? ` ${m.commandArgs.join(' ')}` : ''}`;
  const approve = bundle.approveHighRisk;
  const unsupported = !entry || !channelCommandSupported(entry.def.name, m.commandArgs, environment);
  const unsupportedInvocation =
    entry?.def.name === 'project' && m.commandArgs[0] ? `/${command} ${m.commandArgs[0]}` : `/${command}`;
  const exec: CommandExecution = {
    registry: bundle.registry,
    navigator: conversationNavigator(host, c, key, m.senderDisplay),
    // The channel serializes per conversation (one run at a time), so a command never races an
    // in-flight turn → not busy.
    isBusy: false,
    denyCommand: (def, args) => {
      const memoryDenied = bundle.denyCommand?.(sessionId, def, args);
      if (memoryDenied) return memoryDenied;
      return null;
    },
    gate: approve ? (def) => approve(sessionId, def) : undefined,
    services: channelServices(host, bundle, sessionId, c, key, m.senderDisplay)
  };
  const result = unsupported
    ? unsupportedCommand(host, unsupportedInvocation, environment)
    : await executeCommand(exec, sessionId, text);
  if (result === null) return false;
  if (result.effect?.type === 'observation-render-mode-changed') {
    host.setRenderMode(c.id, key, result.effect.mode);
  }

  const switchedSessionId =
    result.effect?.type === 'session-switched' && host.deps.store.getSession(result.effect.sessionId)
      ? (result.effect.sessionId as SessionId)
      : undefined;
  const transcriptSessionId = persistedSessionId ?? switchedSessionId;
  if (transcriptSessionId) {
    const renderer = createRenderer({
      adapter: inst.adapter,
      chatId: m.chatId,
      threadId: m.threadId,
      replyTo: m.replyTo,
      log: (level, msg) => host.deps.log[level](`[${c.id}] ${msg}`),
      t: host.channelT,
      renderMode: host.getRenderMode(c.id, key)
    });
    await emitCommandTurn(
      host.deps.messageIngress ?? createMessageIngress({ store: host.deps.store, bus: host.deps.bus }),
      (event) => renderer.consume(event),
      transcriptSessionId,
      text,
      result
    );
    await renderer.finalize();
  } else if (result.message) {
    await inst.adapter.send(m.chatId, result.message, { threadId: m.threadId, replyTo: m.replyTo });
  }

  // IM-native receipt: a ✅ on the command message — feedback even when the reply has no text
  // (e.g. /clear). Non-fatal: a platform that rejects the reaction just doesn't show one.
  if (inst.adapter?.react && inst.adapter?.capabilities.reactions) {
    await inst.adapter
      ?.react({ chatId: m.chatId, messageId: m.nativeMessageId }, '✅')
      .catch((err) => host.deps.log.warn(`channel "${c.id}": react failed: ${errMsg(err)}`));
  }
  return true;
}

function channelConversationEnvironment(
  host: CommandHost,
  c: ChannelInstanceConfig,
  key: string
): ChannelConversationEnvironment {
  const active = host.deps.store.getActiveConversation(c.id, key);
  if (!active) return host.hasPendingProject(c, key) ? 'project' : 'chat';
  return host.deps.store.getSession(active.activeSessionId)?.projectId ? 'project' : 'chat';
}

function channelCommandSupported(
  command: string,
  args: string[],
  environment: ChannelConversationEnvironment
): boolean {
  if (CHANNEL_BLOCKED_COMMANDS.has(command)) return false;
  if (environment === 'project') return PROJECT_SESSION_COMMANDS.has(command);
  if (command === 'project' && args[0] === 'leave') return false;
  return true;
}

function unsupportedCommand(
  host: CommandHost,
  invocation: string,
  environment: ChannelConversationEnvironment
): CommandResult {
  return {
    message: host.channelT(
      environment === 'project' ? 'channel.commandUnsupportedProject' : 'channel.commandUnsupportedChat',
      { command: invocation }
    )
  };
}

// Channels are always session-scoped (a conversation maps to a real chat session, never a Workplace
// Project id), so `sid` is cast to `SessionId` at each `bundle.*`/`session.*` call below.
function channelServices(
  host: CommandHost,
  bundle: CommandBundle,
  sessionId: SessionId,
  c: ChannelInstanceConfig,
  key: string,
  label?: string
): CommandServices {
  return {
    archiveSession: (sid) =>
      host.deps.session.update
        ? host.deps.session.update({ id: sid as SessionId, archived: true }).then(() => undefined)
        : Promise.reject(new Error('archive is unavailable')),
    resetHistory: (sid) =>
      host.deps.session.reset
        ? host.deps.session.reset({ id: sid as SessionId })
        : Promise.reject(new Error('reset is unavailable')),
    compact: (sid) => bundle.compact(sid as SessionId),
    consolidate: (level?: number) => bundle.consolidate(sessionId, level),
    explainBelief: (sid, query) => bundle.explainBelief(sid as SessionId, query),
    checkMemory: () => bundle.checkMemory(),
    listModels: (sid) => bundle.listModels(sid as SessionId),
    setModel: (sid, alias) => bundle.setModel(sid as SessionId, alias),
    setEffort: (sid, effort) => bundle.setEffort(sid as SessionId, effort),
    getWorkdir: async (sid) => ({ path: host.deps.store.getSession(sid)?.cwd }),
    setWorkdir: (sid, path) =>
      host.deps.session.setWorkspace
        ? host.deps.session.setWorkspace({ id: sid as SessionId, cwd: path }).then((r) => ({ path: r.cwd }))
        : Promise.reject(new Error('setWorkspace is unavailable')),
    handoff: (sid, initialTask) => bundle.handoff(sid as SessionId, initialTask),
    project: {
      listProjects: () => host.listProjects(c, key),
      currentProject: () => host.currentProject(c, key),
      switchProject: (target) => host.useProject(c, key, target, label),
      leaveProject: () => host.leaveProject(c, key, label)
    },
    listCommands: async () => {
      const environment = channelConversationEnvironment(host, c, key);
      const commands = bundle.listCommands?.(sessionId) ?? bundle.registry.list(bundle.skills(), host.deps.t);
      return commands.filter((command) => {
        if (command.type === 'skill') return command.enabled;
        const entry = bundle.registry.resolve(command.id);
        return entry ? channelCommandSupported(entry.def.name, [], environment) : false;
      });
    },
    t: host.deps.t,
    log: bundle.log
  };
}

/** Conversation-keyed navigator: a single chat multiplexes many sessions via the store's
 *  conversation mapping (the channel's session model, distinct from generic transports). */
function conversationNavigator(
  host: CommandHost,
  c: ChannelInstanceConfig,
  key: string,
  label?: string
): SessionNavigator {
  const { store } = host.deps;
  const channelId = c.id;
  return {
    newSession: async (l) => ({ sessionId: await host.startNewSession(c, key, l ?? label) }),
    listSessions: async () => {
      const project = await host.currentProject(c, key);
      const list = project
        ? store
            .listSessions({ projectId: project.projectId, archived: false, state: 'active' })
            .map((session) => ({ sessionId: session.id, label: session.title }))
        : store.listConversationSessions(channelId, key);
      const active = store.getActiveConversation(channelId, key)?.activeSessionId;
      return list.map((s) => ({
        sessionId: s.sessionId,
        label: s.label ?? undefined,
        active: s.sessionId === active
      }));
    },
    switchSession: async (target) => {
      const project = await host.currentProject(c, key);
      const list = project
        ? store
            .listSessions({ projectId: project.projectId, archived: false, state: 'active' })
            .map((session) => ({ sessionId: session.id, label: session.title }))
        : store.listConversationSessions(channelId, key);
      const byIndex = /^\d+$/.test(target) ? list[Number(target) - 1] : undefined;
      const found = byIndex ?? list.find((s) => s.sessionId === target);
      if (!found) return null;
      store.setActiveSession({
        channelId,
        conversationKey: key,
        sessionId: found.sessionId
      });
      host.clearPendingProject(c, key);
      // Register a mirror for the switched-to session so web-UI messages are immediately mirrored.
      const adapter = host.instances.get(channelId)?.adapter;
      if (adapter) host.registerMirror(channelId, key, found.sessionId as SessionId, adapter);
      return { sessionId: found.sessionId, label: found.label ?? undefined, active: true };
    }
  };
}
