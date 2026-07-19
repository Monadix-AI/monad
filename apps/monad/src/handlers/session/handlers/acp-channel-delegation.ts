import type { AcpAgentConfig, McpServerConfig } from '@monad/environment';
import type { ChannelResponseNextTarget, Event, Session, SessionId } from '@monad/protocol';
import type { BuildChannelContextInput } from '#/agent/prompts/channel.ts';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId, parseChannelStructuredResponse } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { composeAcpChannelPrompt } from '#/agent/prompts/channel.ts';
import { channelDelegateMcpServers, projectAcpMembers } from '#/handlers/session/handlers/messaging-members.ts';
import { channelNextPrompt } from '#/handlers/session/handlers/messaging-notices.ts';
import { acpAuthGuidance, directDelegate } from '#/services/delegation/acp-delegate.ts';
import { makeEvent } from '#/services/event-bus.ts';

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
    requireSession,
    messageIngress
  } = ctx;

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);

  async function startAcpAssignedTask({
    sessionId,
    spec,
    text,
    channelPromptInput,
    mcpServers
  }: {
    sessionId: SessionId;
    spec: AcpAgentConfig;
    text: string;
    channelPromptInput?: BuildChannelContextInput;
    mcpServers?: Parameters<typeof directDelegate>[2]['mcpServers'];
  }): Promise<void> {
    const round: Event[] = [];
    const emit = makeEmit(round);
    const controller = new AbortController();
    const agentMessage = await messageIngress.begin({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'system', subsystem: 'acp' },
      role: 'assistant',
      type: 'text',
      text: '',
      data: { agentName: spec.name }
    });
    const agentMsgId = agentMessage.id;
    const acpToolCallId = newId('tc');
    let tokenIndex = 0;
    let acpProcessOutput = '';
    let acpResponseOutput = '';
    let ingressQueue = Promise.resolve();

    const emitAcpActivityProgress = () => {
      const sections = [
        acpProcessOutput.trim(),
        acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
      ].filter(Boolean);
      emit(
        makeEvent(sessionId as SessionId, 'tool.progress', {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: sections.join('\n\n') || 'waiting for response...'
        })
      );
    };

    emit(
      makeEvent(sessionId as SessionId, 'tool.called', {
        toolCallId: acpToolCallId,
        tool: `acp:${spec.name}`,
        input: { agent: spec.name }
      })
    );
    emitAcpActivityProgress();

    const rt = runtimeForSession(sessionId);
    directDelegate(spec, composeAcpChannelPrompt(text, channelPromptInput), {
      sessionId,
      signal: controller.signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireSession(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers,
      onChunk: (delta) => {
        const index = tokenIndex++;
        ingressQueue = ingressQueue.then(() =>
          messageIngress.append({
            transcriptTargetId: sessionId,
            messageId: agentMsgId,
            producer: { kind: 'system', subsystem: 'acp' },
            channel: 'content',
            index,
            delta
          })
        );
        acpResponseOutput += delta;
        emitAcpActivityProgress();
      },
      onActivity: (output) => {
        acpProcessOutput = output;
        emitAcpActivityProgress();
      }
    })
      .then(async (fullText) => {
        emit(
          makeEvent(sessionId as SessionId, 'tool.result', {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            ok: true,
            result: 'completed'
          })
        );
        await ingressQueue;
        await messageIngress.settle({
          transcriptTargetId: sessionId,
          messageId: agentMsgId,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'acp' },
          text: fullText,
          data: { agentName: spec.name }
        });
        persistAndRetire(sessionId, round);
      })
      .catch(async (err: unknown) => {
        const { code, message } = extractError(err);
        emit(
          makeEvent(sessionId as SessionId, 'tool.result', {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            ok: false,
            result: message
          })
        );
        await ingressQueue;
        await messageIngress.fail({
          transcriptTargetId: sessionId,
          messageId: agentMsgId,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'acp' },
          error: { code: code ?? 'acp_failed', message: code ? `[${code}] ${message}` : message },
          type: 'error',
          data: { agentName: spec.name }
        });
        persistAndRetire(sessionId, round);
      });
  }

  async function dispatchChannelNextTargets({
    sessionId,
    responseText,
    channelPromptInput,
    acpAgents,
    mcpServers
  }: {
    sessionId: SessionId;
    responseText: string;
    channelPromptInput: BuildChannelContextInput;
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
      await startAcpAssignedTask({
        sessionId,
        spec,
        text: channelNextPrompt(target),
        channelPromptInput,
        mcpServers
      });
    }
  }

  async function deliverProjectMessageToAcpMembers({
    session,
    acpAgents,
    mcpServers,
    text,
    channelPromptInput
  }: {
    session: Session;
    acpAgents: readonly AcpAgentConfig[];
    mcpServers: readonly McpServerConfig[] | undefined;
    text: string;
    channelPromptInput?: BuildChannelContextInput;
  }): Promise<void> {
    const members = projectAcpMembers(store, session.id, acpAgents);
    if (members.length === 0) return;
    await Promise.all(
      members.map(async (spec) => {
        const round: Event[] = [];
        const emit = makeEmit(round);
        const agentMessage = await messageIngress.begin({
          transcriptTargetId: session.id,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'acp' },
          role: 'assistant',
          type: 'text',
          text: '',
          data: { agentName: spec.name }
        });
        const agentMsgId = agentMessage.id;
        const acpToolCallId = newId('tc');
        let tokenIndex = 0;
        let acpProcessOutput = '';
        let acpResponseOutput = '';
        let ingressQueue = Promise.resolve();
        const emitAcpActivityProgress = (output = 'waiting for response...') => {
          emit(
            makeEvent(session.id as SessionId, 'tool.progress', {
              toolCallId: acpToolCallId,
              tool: `acp:${spec.name}`,
              output
            })
          );
        };
        emit(
          makeEvent(session.id as SessionId, 'tool.called', {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            input: { agent: spec.name }
          })
        );
        emitAcpActivityProgress();
        try {
          const rt = runtime.get(session.id);
          const fullText = await directDelegate(spec, composeAcpChannelPrompt(text, channelPromptInput), {
            sessionId: session.id,
            signal: new AbortController().signal,
            sandboxRoots: sandboxRootsFor(session.id, session.cwd, rt),
            backends: rt?.backends,
            toolFilter: rt?.toolFilter,
            extraTools: rt?.extraTools,
            extraSkills: rt?.extraSkills,
            mcpServers: channelDelegateMcpServers(mcpServers, rt?.mcpServers),
            onChunk: (delta) => {
              const index = tokenIndex++;
              ingressQueue = ingressQueue.then(() =>
                messageIngress.append({
                  transcriptTargetId: session.id,
                  messageId: agentMsgId,
                  producer: { kind: 'system', subsystem: 'acp' },
                  channel: 'content',
                  index,
                  delta
                })
              );
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
          emit(
            makeEvent(session.id as SessionId, 'tool.result', {
              toolCallId: acpToolCallId,
              tool: `acp:${spec.name}`,
              ok: true,
              result: 'completed'
            })
          );
          await ingressQueue;
          await messageIngress.settle({
            transcriptTargetId: session.id,
            messageId: agentMsgId,
            idempotencyKey: newId('idem'),
            producer: { kind: 'system', subsystem: 'acp' },
            text: fullText,
            data: { agentName: spec.name }
          });
        } catch (err) {
          const { code, message } = extractError(err);
          const hint = acpAuthGuidance(err, spec, localeService?.t);
          const errorText = hint ? `${message}\n\n${hint}` : message;
          emit(
            makeEvent(session.id as SessionId, 'tool.result', {
              toolCallId: acpToolCallId,
              tool: `acp:${spec.name}`,
              ok: false,
              result: errorText
            })
          );
          await ingressQueue;
          await messageIngress.fail({
            transcriptTargetId: session.id,
            messageId: agentMsgId,
            idempotencyKey: newId('idem'),
            producer: { kind: 'system', subsystem: 'acp' },
            error: { code: code ?? 'acp_failed', message: code ? `[${code}] ${errorText}` : errorText },
            type: 'error',
            data: { agentName: spec.name }
          });
        } finally {
          persistAndRetire(session.id, round);
        }
      })
    );
  }

  return { startAcpAssignedTask, dispatchChannelNextTargets, deliverProjectMessageToAcpMembers };
}
