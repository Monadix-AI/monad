import type {
  AgentId,
  ClarifyRespondRequest,
  ClarifyRespondResponse,
  Event,
  EventId,
  MeshAgentTurnInput,
  SessionId,
  ToolApproveRequest,
  ToolApproveResponse
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import { requireMonadAppServerUnixSocket } from '../../src/app-server/bridge.ts';
import { createMonadAppServerConnection, type MonadAppServerClient } from '../../src/app-server/connection.ts';

const sessionId = 'ses_1234567890ab' as SessionId;
const resumedSessionId = 'ses_abcdef123456' as SessionId;
const event = {
  id: 'evt_1234567890ab',
  sessionId,
  type: 'session.message.created',
  actorAgentId: 'agt_1234567890ab',
  payload: { messageId: 'msg_1234567890ab' },
  at: '2026-07-22T00:00:00.000Z'
} satisfies Event;

class FakeClient implements MonadAppServerClient {
  calls: unknown[] = [];
  disposed = 0;
  eventHandler?: (value: Event) => void;
  errorHandler?: (error: { kind: 'fatal' | 'transient'; cause?: unknown; status?: number }) => void;

  async openSession(input: {
    agentId: AgentId;
    cwd: string;
    providerSessionRef?: SessionId;
    immutableInstructions?: string;
  }): Promise<SessionId> {
    this.calls.push(['openSession', input]);
    return input.providerSessionRef ?? sessionId;
  }

  subscribeEvents(
    id: SessionId,
    afterEventId: EventId | undefined,
    onEvent: (value: Event) => void,
    onError: (error: { kind: 'fatal' | 'transient'; cause?: unknown; status?: number }) => void
  ): () => void {
    this.calls.push(['subscribeEvents', id, afterEventId]);
    this.eventHandler = onEvent;
    this.errorHandler = onError;
    return () => {
      this.disposed += 1;
    };
  }

  async sendTurn(id: SessionId, input: MeshAgentTurnInput, steer: boolean): Promise<{ accepted: true }> {
    this.calls.push(['sendTurn', id, input, steer]);
    return { accepted: true };
  }

  async interrupt(id: SessionId): Promise<{ ok: boolean }> {
    this.calls.push(['interrupt', id]);
    return { ok: true };
  }

  async resolveApproval(input: ToolApproveRequest): Promise<ToolApproveResponse> {
    this.calls.push(['resolveApproval', input]);
    return { ok: true };
  }

  async respondClarify(input: ClarifyRespondRequest): Promise<ClarifyRespondResponse> {
    this.calls.push(['respondClarify', input]);
    if (input.action === 'cancel') return { status: 'cancelled', resolvedAt: '2026-07-22T00:00:01.000Z' };
    return {
      status: 'answered',
      answer: input.action === 'complete' ? 'Completed' : (input.answer ?? ''),
      resolvedAt: '2026-07-22T00:00:01.000Z'
    };
  }
}

const request = (id: string, method: string, params: unknown): string =>
  JSON.stringify({ kind: 'request', id, method, params });

test('Monad app-server rejects configurations without the local Unix socket', () => {
  expect(() => requireMonadAppServerUnixSocket({})).toThrow(
    'Monad app-server requires the local daemon Unix-socket transport'
  );
  expect(requireMonadAppServerUnixSocket({ unixSocket: '/tmp/monad.sock' })).toBe('/tmp/monad.sock');
});

test('Monad app-server connection maps a full session lifecycle and stream in order', async () => {
  const client = new FakeClient();
  const output: unknown[] = [];
  const connection = createMonadAppServerConnection({ client, write: (message) => output.push(message) });

  await connection.handleLine(request('1', 'initialize', { protocolVersion: 1 }));
  await connection.handleLine(
    request('2', 'session/open', {
      agentId: 'agt_1234567890ab',
      cwd: '/workspace',
      afterEventId: 'evt_000000000001',
      immutableInstructions: 'Managed Monad instructions',
      mcpServers: [
        {
          name: 'monad',
          command: 'monad',
          args: ['native-agent', 'mcp-server'],
          env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
        }
      ]
    })
  );
  client.eventHandler?.(event);
  await connection.handleLine(
    request('3', 'turn/start', { sessionId, input: { text: 'Inspect this', attachments: [] } })
  );
  await connection.handleLine(
    request('4', 'turn/steer', { sessionId, input: { text: 'Focus on storage', attachments: [] } })
  );
  await connection.handleLine(request('5', 'turn/interrupt', { sessionId }));
  await connection.handleLine(
    request('6', 'approval/resolve', {
      sessionId,
      requestId: 'approval-1',
      allow: true,
      scope: 'session'
    })
  );
  await connection.handleLine(
    request('7', 'clarify/respond', { sessionId, requestId: 'clarify-1', answer: 'Use SQLite' })
  );
  await connection.handleLine(
    request('8', 'clarify/respond', { sessionId, requestId: 'clarify-url', action: 'complete' })
  );
  await connection.handleLine(request('9', 'session/close', { sessionId }));

  expect(client.calls).toEqual([
    [
      'openSession',
      {
        agentId: 'agt_1234567890ab',
        cwd: '/workspace',
        immutableInstructions: 'Managed Monad instructions',
        mcpServers: [
          {
            name: 'monad',
            command: 'monad',
            args: ['native-agent', 'mcp-server'],
            env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
          }
        ]
      }
    ],
    ['subscribeEvents', sessionId, 'evt_000000000001'],
    ['sendTurn', sessionId, { text: 'Inspect this', attachments: [] }, false],
    ['sendTurn', sessionId, { text: 'Focus on storage', attachments: [] }, true],
    ['interrupt', sessionId],
    ['resolveApproval', { requestId: 'approval-1', allow: true, scope: 'session' }],
    ['respondClarify', { requestId: 'clarify-1', answer: 'Use SQLite' }],
    ['respondClarify', { requestId: 'clarify-url', action: 'complete' }]
  ]);
  expect(output).toEqual([
    {
      kind: 'response',
      id: '1',
      method: 'initialize',
      result: {
        protocolVersion: 1,
        capabilities: {
          input: true,
          steer: true,
          interrupt: true,
          approvalResolution: true,
          providerSessionContinuation: true,
          runtimeRestoration: true,
          sessionReopen: true
        }
      }
    },
    { kind: 'response', id: '2', method: 'session/open', result: { sessionId } },
    { kind: 'notification', method: 'session/identified', params: { sessionId } },
    { kind: 'notification', method: 'session/event', params: { event } },
    { kind: 'response', id: '3', method: 'turn/start', result: { accepted: true } },
    { kind: 'response', id: '4', method: 'turn/steer', result: { accepted: true } },
    { kind: 'response', id: '5', method: 'turn/interrupt', result: { ok: true } },
    { kind: 'response', id: '6', method: 'approval/resolve', result: { ok: true } },
    {
      kind: 'response',
      id: '7',
      method: 'clarify/respond',
      result: { status: 'answered', answer: 'Use SQLite', resolvedAt: '2026-07-22T00:00:01.000Z' }
    },
    {
      kind: 'response',
      id: '8',
      method: 'clarify/respond',
      result: { status: 'answered', answer: 'Completed', resolvedAt: '2026-07-22T00:00:01.000Z' }
    },
    { kind: 'response', id: '9', method: 'session/close', result: { ok: true } }
  ]);
  expect(client.disposed).toBe(1);
});

test('Monad app-server resumes the exact provider session and reports stream failures', async () => {
  const client = new FakeClient();
  const output: unknown[] = [];
  const connection = createMonadAppServerConnection({ client, write: (message) => output.push(message) });

  await connection.handleLine(
    request('1', 'session/open', {
      agentId: 'agt_1234567890ab',
      cwd: '/workspace',
      providerSessionRef: resumedSessionId
    })
  );
  client.errorHandler?.({ kind: 'transient', status: 503 });
  await connection.close();

  expect(client.calls).toEqual([
    ['openSession', { agentId: 'agt_1234567890ab', cwd: '/workspace', providerSessionRef: resumedSessionId }],
    ['subscribeEvents', resumedSessionId, undefined]
  ]);
  expect(output).toEqual([
    { kind: 'response', id: '1', method: 'session/open', result: { sessionId: resumedSessionId } },
    { kind: 'notification', method: 'session/identified', params: { sessionId: resumedSessionId } },
    {
      kind: 'notification',
      method: 'session/error',
      params: { code: 'stream_disconnected', message: 'Monad event stream disconnected (503)', retryable: true }
    }
  ]);
  expect(client.disposed).toBe(1);
});

test('Monad app-server rejects controls for a different session without calling the daemon', async () => {
  const client = new FakeClient();
  const output: unknown[] = [];
  const connection = createMonadAppServerConnection({ client, write: (message) => output.push(message) });

  await connection.handleLine(
    request('1', 'turn/start', {
      sessionId,
      input: { text: 'Must not run', attachments: [] }
    })
  );

  expect(client.calls).toEqual([]);
  expect(output).toEqual([
    {
      kind: 'response',
      id: '1',
      method: 'turn/start',
      error: { code: 'session_not_open', message: `Monad session is not open: ${sessionId}`, retryable: false }
    }
  ]);
});
