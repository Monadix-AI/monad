import type {
  AgentConnection,
  ClientCapabilities,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk';
import type { ApprovalScope, Event, SessionId } from '@monad/protocol';
import type { ToolBackends } from '@/capabilities/tools/types.ts';
import type { Handlers } from '@/transports/acp/types.ts';

import { toolKind } from '@/transports/acp/translate.ts';

/** Service a daemon delegation request against the editor: the daemon's remote fs/terminal backend
 * emitted a `delegation.{fs,terminal}_request` event (routed here over the turn's stream); we run it
 * via this session's editor-facing backends (createAcp*Backend) and answer through delegation.respond
 * (streaming terminal output via delegation.output). The reverse of services/delegation.ts. */
export async function bridgeDelegation(
  handlers: Handlers,
  backends: ToolBackends | undefined,
  event: Event
): Promise<void> {
  const p = event.payload as {
    requestId: string;
    op?: 'read' | 'write';
    path?: string;
    offset?: number;
    limit?: number;
    content?: string;
    command?: string;
    cwd?: string;
    timeoutMs?: number;
  };
  if (!backends) {
    await handlers.delegation.respond({ requestId: p.requestId, ok: false, error: 'no delegated backend' });
    return;
  }
  try {
    if (event.type === 'delegation.fs_request') {
      if (p.op === 'write') {
        const result = await backends.fs.writeTextFile(p.path ?? '', p.content ?? '');
        await handlers.delegation.respond({ requestId: p.requestId, ok: true, result });
      } else {
        const content = await backends.fs.readTextFile(p.path ?? '', { offset: p.offset, limit: p.limit });
        await handlers.delegation.respond({ requestId: p.requestId, ok: true, result: { content } });
      }
    } else {
      const result = await backends.terminal.exec({
        command: p.command ?? '',
        cwd: p.cwd,
        timeoutMs: p.timeoutMs,
        onChunk: (output) => void handlers.delegation.output({ requestId: p.requestId, output })
      });
      await handlers.delegation.respond({ requestId: p.requestId, ok: true, result });
    }
  } catch (err) {
    await handlers.delegation.respond({
      requestId: p.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Bridge a monad oversight gate request to the client's `session/request_permission`
 * reverse-RPC, then feed the user's decision back into the gate via `oversight.approve`. */
export async function bridgePermission(
  conn: AgentConnection,
  handlers: Handlers,
  sessionId: SessionId,
  event: Event
): Promise<void> {
  const { requestId, tool, input } = event.payload as { requestId: string; tool: string; input: unknown };
  const req: RequestPermissionRequest = {
    sessionId,
    toolCall: { toolCallId: requestId, title: tool, kind: toolKind(tool), status: 'pending', rawInput: input },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Always reject', kind: 'reject_once' }
    ]
  };
  try {
    const { outcome } = (await conn.client.request('session/request_permission', req)) as RequestPermissionResponse;
    if (outcome.outcome === 'cancelled') {
      // Cancellation never persists — single-call deny only.
      await handlers.oversight.approve({ requestId, allow: false, reason: 'cancelled', scope: 'once' });
      return;
    }
    // Map each editor option to a (allow, scope) pair. 'allow_always'/'reject_always' persist
    // globally; 'allow_session' persists for the session; the rest resolve a single call.
    const id = outcome.optionId;
    const allow = id === 'allow' || id === 'allow_session' || id === 'allow_always';
    const scope: ApprovalScope =
      id === 'allow_always' || id === 'reject_always' ? 'global' : id === 'allow_session' ? 'session' : 'once';
    await handlers.oversight.approve({
      requestId,
      allow,
      reason: allow ? undefined : 'rejected in editor',
      scope
    });
  } catch {
    // Connection error / client failure → fail closed so the gate doesn't hang.
    await handlers.oversight.approve({
      requestId,
      allow: false,
      reason: 'permission request failed',
      scope: 'once'
    });
  }
}

/** Bridge a monad `clarify_ask` question to the client. A multiple-choice question maps to
 * `session/request_permission` (each choice an option). A free-text question uses form
 * elicitation when the client supports it (real input box); otherwise it degrades to surfacing
 * the question and letting the agent proceed (the user answers in the next prompt turn). */
export async function bridgeClarify(
  conn: AgentConnection,
  handlers: Handlers,
  clientCaps: ClientCapabilities,
  sessionId: SessionId,
  event: Event
): Promise<void> {
  const { requestId, question, options } = event.payload as {
    requestId: string;
    question: string;
    options?: string[];
  };
  if (!options || options.length === 0) {
    await bridgeFreeTextClarify(conn, handlers, clientCaps, sessionId, requestId, question);
    return;
  }
  try {
    const { outcome } = (await conn.client.request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: requestId, title: question, kind: 'think', status: 'pending' },
      options: options.map((name, i) => ({ optionId: String(i), name, kind: 'allow_once' as const }))
    })) as RequestPermissionResponse;
    const answer = outcome.outcome === 'selected' ? (options[Number(outcome.optionId)] ?? '') : '';
    await handlers.clarify.respond({ requestId, answer });
  } catch {
    await handlers.clarify.respond({ requestId, answer: '' });
  }
}

async function bridgeFreeTextClarify(
  conn: AgentConnection,
  handlers: Handlers,
  clientCaps: ClientCapabilities,
  sessionId: SessionId,
  requestId: string,
  question: string
): Promise<void> {
  // No form-elicitation support → surface the question and let the agent proceed.
  if (!clientCaps.elicitation?.form) {
    void conn.client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[clarify] ${question}\n` } }
    });
    await handlers.clarify.respond({ requestId, answer: '' });
    return;
  }
  try {
    const res = await conn.client.request('elicitation/create', {
      mode: 'form',
      sessionId,
      message: question,
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string', title: 'Answer' } },
        required: ['answer']
      }
    });
    const answer = res.action === 'accept' ? String(res.content?.answer ?? '') : '';
    await handlers.clarify.respond({ requestId, answer });
  } catch {
    await handlers.clarify.respond({ requestId, answer: '' });
  }
}
