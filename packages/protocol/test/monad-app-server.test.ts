import type { MonadAppServerNotification, MonadAppServerRequest, MonadAppServerResponse } from '../src/index.ts';

import { expect, test } from 'bun:test';

import {
  monadAppServerNotificationSchema,
  monadAppServerRequestSchema,
  monadAppServerResponseSchema
} from '../src/index.ts';

const sessionId = 'ses_1234567890ab';
const agentId = 'agt_1234567890ab';

test('Monad app-server requests preserve the complete control contract', () => {
  const requests: MonadAppServerRequest[] = [
    {
      kind: 'request',
      id: '1',
      method: 'initialize',
      params: { protocolVersion: 1 }
    },
    {
      kind: 'request',
      id: '2',
      method: 'session/open',
      params: {
        agentId,
        cwd: '/workspace',
        afterEventId: 'evt_1234567890ab',
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
    },
    {
      kind: 'request',
      id: '3',
      method: 'session/open',
      params: { agentId, cwd: '/workspace', providerSessionRef: sessionId }
    },
    {
      kind: 'request',
      id: '4',
      method: 'turn/start',
      params: { sessionId, input: { text: 'Inspect this', attachments: [] } }
    },
    {
      kind: 'request',
      id: '5',
      method: 'turn/steer',
      params: { sessionId, input: { text: 'Focus on storage', attachments: [] } }
    },
    {
      kind: 'request',
      id: '6',
      method: 'turn/interrupt',
      params: { sessionId }
    },
    {
      kind: 'request',
      id: '7',
      method: 'approval/resolve',
      params: { sessionId, requestId: 'approval-1', allow: true, scope: 'session' }
    },
    {
      kind: 'request',
      id: '8',
      method: 'clarify/respond',
      params: { sessionId, requestId: 'clarify-1', answer: 'Use SQLite' }
    },
    {
      kind: 'request',
      id: '9',
      method: 'clarify/respond',
      params: { sessionId, requestId: 'clarify-url', action: 'complete' }
    },
    {
      kind: 'request',
      id: '10',
      method: 'session/close',
      params: { sessionId }
    }
  ];

  expect(requests.map((request) => monadAppServerRequestSchema.parse(request))).toEqual([...requests]);
});

test('Monad app-server responses preserve method-specific results', () => {
  const responses: MonadAppServerResponse[] = [
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
    { kind: 'response', id: '3', method: 'turn/start', result: { accepted: true } },
    { kind: 'response', id: '4', method: 'turn/steer', result: { accepted: true } },
    { kind: 'response', id: '5', method: 'turn/interrupt', result: { ok: true } },
    { kind: 'response', id: '6', method: 'approval/resolve', result: { ok: true } },
    {
      kind: 'response',
      id: '7',
      method: 'clarify/respond',
      result: { status: 'answered', answer: 'Use SQLite', resolvedAt: '2026-07-22T00:00:00.000Z' }
    },
    { kind: 'response', id: '8', method: 'session/close', result: { ok: true } },
    {
      kind: 'response',
      id: '9',
      method: 'turn/start',
      error: { code: 'session_not_found', message: 'Session is unavailable', retryable: false }
    }
  ];

  expect(responses.map((response) => monadAppServerResponseSchema.parse(response))).toEqual([...responses]);
});

test('Monad app-server notifications preserve identity and raw Monad events', () => {
  const notifications: MonadAppServerNotification[] = [
    {
      kind: 'notification',
      method: 'session/identified',
      params: { sessionId }
    },
    {
      kind: 'notification',
      method: 'session/event',
      params: {
        event: {
          id: 'evt_1234567890ab',
          sessionId,
          type: 'session.message.created',
          actorAgentId: agentId,
          payload: { messageId: 'msg_1234567890ab' },
          at: '2026-07-22T00:00:00.000Z'
        }
      }
    },
    {
      kind: 'notification',
      method: 'session/error',
      params: { code: 'stream_disconnected', message: 'Event stream disconnected', retryable: true }
    }
  ];

  expect(notifications.map((notification) => monadAppServerNotificationSchema.parse(notification))).toEqual([
    ...notifications
  ]);
});

test('Monad app-server rejects malformed IDs, unknown methods, and extra fields', () => {
  expect(
    monadAppServerRequestSchema.safeParse({
      kind: 'request',
      id: '1',
      method: 'session/open',
      params: { agentId: 'not-an-agent-id', cwd: '/workspace' }
    }).success
  ).toBe(false);
  expect(
    monadAppServerRequestSchema.safeParse({ kind: 'request', id: '2', method: 'session/delete', params: {} }).success
  ).toBe(false);
  expect(
    monadAppServerNotificationSchema.safeParse({
      kind: 'notification',
      method: 'session/identified',
      params: { sessionId, unexpected: true }
    }).success
  ).toBe(false);
});
