import { expect, test } from 'bun:test';

import { type ProjectedAgentErrorPayload, projectAgentError } from '#/services/public-agent-error.ts';

function expectProjectedError(
  payload: ProjectedAgentErrorPayload,
  expected: Omit<ProjectedAgentErrorPayload, 'requestId'>
): void {
  const requestId = payload.requestId;
  if (!requestId) throw new Error('expected canonical request correlation');
  expect(requestId).toMatch(/^req_[0-9a-zA-Z]{12}$/);
  expect(payload).toEqual({ ...expected, requestId });
}

test('unknown thrown text projects to a safe non-retryable agent error', () => {
  const payload = projectAgentError(new Error('secret internal path'), { messageId: 'msg_1234567890ab' });
  expectProjectedError(payload, {
    messageId: 'msg_1234567890ab',
    code: 'AGENT_ERROR',
    message: 'generation failed',
    retryable: false
  });
  expect(JSON.stringify(payload)).not.toContain('secret internal path'); // presence-ok: raw errors must not cross the public event boundary
});

test('aggregate status 429 projects to a retryable rate-limit error', () => {
  const upstream = Object.assign(new Error('raw rate limit body'), { statusCode: 429 });
  const payload = projectAgentError(new AggregateError([upstream], 'all providers failed'));
  expectProjectedError(payload, {
    code: 'RATE_LIMITED',
    message: 'rate limit exceeded',
    retryable: true
  });
});

test('status 503 with provider metadata projects to a redacted retryable gateway error', () => {
  const error = Object.assign(new Error('sdk raw response'), {
    statusCode: 503,
    data: { error: { metadata: { raw: 'token=secret upstream payload' } } }
  });
  const payload = projectAgentError(error, { agentName: 'worker' });
  expectProjectedError(payload, {
    agentName: 'worker',
    code: 'BAD_GATEWAY',
    message: 'upstream service unavailable',
    retryable: true
  });
  expect(JSON.stringify(payload)).not.toContain('token=secret'); // presence-ok: raw provider metadata must remain internal
});

test('status 401 projects to a non-retryable authentication error', () => {
  const payload = projectAgentError(Object.assign(new Error('raw invalid api key'), { statusCode: 401 }));
  expectProjectedError(payload, {
    code: 'UNAUTHORIZED',
    message: 'authentication failed',
    retryable: false
  });
});

test('AbortError projects to a non-retryable cancellation', () => {
  const payload = projectAgentError(new DOMException('raw abort reason', 'AbortError'));
  expectProjectedError(payload, {
    code: 'CANCELLED',
    message: 'generation cancelled',
    retryable: false
  });
});

test('network timeout message projects to a retryable gateway error', () => {
  const payload = projectAgentError(new Error('network timeout while contacting provider'));
  expectProjectedError(payload, {
    code: 'BAD_GATEWAY',
    message: 'upstream service unavailable',
    retryable: true
  });
});

test('standard status 503 projects to a retryable gateway error', () => {
  const payload = projectAgentError(Object.assign(new Error('raw service failure'), { status: 503 }));
  expectProjectedError(payload, {
    code: 'BAD_GATEWAY',
    message: 'upstream service unavailable',
    retryable: true
  });
});

test('AggregateError unwraps an AbortError for cancellation classification', () => {
  const payload = projectAgentError(
    new AggregateError([new DOMException('raw abort reason', 'AbortError')], 'all attempts failed')
  );
  expectProjectedError(payload, {
    code: 'CANCELLED',
    message: 'generation cancelled',
    retryable: false
  });
});

test('plain 429 message projects to a retryable rate-limit error', () => {
  const payload = projectAgentError(new Error('429 Too Many Requests'));
  expectProjectedError(payload, {
    code: 'RATE_LIMITED',
    message: 'rate limit exceeded',
    retryable: true
  });
});

test('authorization semantics project to forbidden rather than authentication failure', () => {
  const payload = projectAgentError(Object.assign(new Error('raw policy detail'), { code: 'AUTHORIZATION_FAILED' }));
  expectProjectedError(payload, {
    code: 'FORBIDDEN',
    message: 'request forbidden',
    retryable: false
  });
});
