import type { AcpAgentConfig, McpServerConfig } from '@monad/home';
import type { ChannelResponseNextTarget, Event, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { newId, parseChannelStructuredResponse } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { channelDelegateMcpServers, projectAcpMembers } from '@/handlers/session/handlers/messaging-members.ts';
import { channelNextPrompt } from '@/handlers/session/handlers/messaging-notices.ts';
import { acpAuthGuidance, directDelegate } from '@/services/delegation/acp-delegate.ts';

/** Direct-to-ACP-agent delegation for channel `next` targets and project fan-out. */
export function createAcpChannelDelegation(
  ctx: SessionContext,
  sandboxRootsFor: (
    sessionId: SessionId,
    cwd: string | undefined,
    rt: { sandboxRoots?: string[] } | undefined,
    override?: string[]
  ) => string[] | undefined
) {
  const {
    deps: { store, localeService },
    runtime,
    makeEmit,
    persistAndRetire,
    requireSession
  } = ctx;

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);

  function startAcpAssignedTask({
    sessionId,
    spec,
    text,
    ambientContext,
    mcpServers
  }: {
    sessionId: SessionId;
    spec: AcpAgentConfig;
    text: string;
    ambientContext?: string;
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): void {
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
        sessionId: sessionId as SessionId,
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
      sessionId: sessionId as SessionId,
      type: 'tool.called',
      actorAgentId: null,
      payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
      at: new Date().toISOString()
    });
    emitAcpActivityProgress();

    const rt = runtimeForSession(sessionId);
    directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
      sessionId,
      signal: controller.signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireSession(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers,
      onChunk: (delta) => {
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
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
          sessionId: sessionId as SessionId,
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
          sessionId: sessionId as SessionId,
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
          sessionId: sessionId as SessionId,
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
          sessionId: sessionId as SessionId,
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
    sessionId: SessionId;
    responseText: string;
    ambientContext: string;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): Promise<void> {
    const structured = parseChannelStructuredResponse(responseText);
    if (!structured?.next.length) return;
    const acpByName = new Map(acpAgents.map((agent) => [agent.name, agent]));
    for (const target of structured.next as ChannelResponseNextTarget[]) {
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

  async function deliverProjectMessageToAcpMembers({
    session,
    acpAgents,
    mcpServers,
    text,
    ambientContext
  }: {
    session: Session;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers: readonly McpServerConfig[] | undefined;
    text: string;
    ambientContext?: string;
  }): Promise<void> {
    const members = projectAcpMembers(store, session.id, acpAgents);
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
            sessionId: session.id as SessionId,
            type: 'tool.progress',
            actorAgentId: null,
            payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, output },
            at: new Date().toISOString()
          });
        };
        emit({
          id: newId('evt'),
          sessionId: session.id as SessionId,
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
                sessionId: session.id as SessionId,
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
            sessionId: session.id as SessionId,
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
            sessionId: session.id as SessionId,
            type: 'agent.message',
            actorAgentId: null,
            payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
            at: new Date().toISOString()
          });
        } catch (err) {
          const { code, message } = extractError(err);
          const hint = acpAuthGuidance(err, spec, localeService?.t);
          const errorText = hint ? `${message}\n\n${hint}` : message;
          emit({
            id: newId('evt'),
            sessionId: session.id as SessionId,
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
            sessionId: session.id as SessionId,
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

  return { startAcpAssignedTask, dispatchChannelNextTargets, deliverProjectMessageToAcpMembers };
}
