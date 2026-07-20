import { expect, test } from 'bun:test';

import {
  meshAgentAuthErrorMessage,
  meshAgentAuthSessionMissing,
  meshAgentGone
} from '../../src/features/workplace/cli/mesh-agent-auth-errors';

const agentNotFound = {
  message: 'MeshAgent not found or disabled: codex',
  status: 404,
  code: 'MESH_AGENT_NOT_FOUND',
  raw: { error: 'MeshAgent not found or disabled: codex', code: 'MESH_AGENT_NOT_FOUND' }
};

const authSessionNotFound = {
  message: 'MeshAgent auth session not found: ncliauth_01KWAUTHGSVp',
  status: 404,
  code: 'MESH_AUTH_SESSION_NOT_FOUND',
  raw: { error: 'MeshAgent auth session not found: ncliauth_01KWAUTHGSVp', code: 'MESH_AUTH_SESSION_NOT_FOUND' }
};

test('a disconnected agent stops the login restart loop instead of restarting it', () => {
  expect(meshAgentGone(agentNotFound)).toBe(true);
  expect(meshAgentAuthSessionMissing(agentNotFound)).toBe(false);
});

test('a missing auth session restarts the login', () => {
  expect(meshAgentGone(authSessionNotFound)).toBe(false);
  expect(meshAgentAuthSessionMissing(authSessionNotFound)).toBe(true);
  expect(meshAgentAuthSessionMissing(new Error('404 not found'))).toBe(true);
});

test('an unrelated failure neither restarts nor reads as a removed agent', () => {
  const failure = { message: 'spawn codex ENOENT', status: 502, code: 'MESH_SPAWN_FAILED' };
  expect(meshAgentAuthSessionMissing(failure)).toBe(false);
  expect(meshAgentGone(failure)).toBe(false);
});

test('the login modal surfaces the daemon message for any shape of failure', () => {
  expect(meshAgentAuthErrorMessage(agentNotFound)).toBe('MeshAgent not found or disabled: codex');
  expect(meshAgentAuthErrorMessage(new Error('network error'))).toBe('network error');
  expect(meshAgentAuthErrorMessage({ status: 500 })).toBe('{"status":500}');
});
