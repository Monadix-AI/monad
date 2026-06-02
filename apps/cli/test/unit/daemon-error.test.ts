import { expect, test } from 'bun:test';

import { EXIT, exitCodeFor } from '../../src/commands/types.ts';
import { DaemonError } from '../../src/lib/daemon-error.ts';
import { requireTreatyData } from '../../src/lib/treaty.ts';

function failure(status: number, value: unknown) {
  return { data: null, status, error: { status, value } };
}

test('a failed call surfaces the daemon descriptor instead of a bare status', () => {
  let thrown: unknown;
  try {
    requireTreatyData(
      failure(429, {
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retryable: true,
        requestId: 'req_abcdefghijkl'
      })
    );
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(DaemonError);
  expect((thrown as DaemonError).toJSON()).toEqual({
    error: 'Rate limit exceeded',
    status: 429,
    code: 'RATE_LIMITED',
    requestId: 'req_abcdefghijkl',
    retryable: true
  });
});

test('an unparseable error body still yields the status, not a crash', () => {
  let thrown: unknown;
  try {
    requireTreatyData(failure(503, '<html>gateway</html>'));
  } catch (err) {
    thrown = err;
  }
  expect((thrown as DaemonError).toJSON()).toEqual({ error: 'request failed: 503', status: 503 });
});

test('a successful call returns the body untouched', () => {
  expect(requireTreatyData({ data: { sessionId: 'ses_OK' }, status: 200 })).toEqual({ sessionId: 'ses_OK' });
});

test('an unreachable daemon exits 4 whichever call reported it', () => {
  // The regression this pins: 503 used to miss the message regex and exit 1 from every command
  // except `status`, breaking the documented exit-code contract.
  for (const status of [502, 503, 504]) {
    expect(exitCodeFor(new DaemonError(status, undefined))).toBe(EXIT.DAEMON);
  }
  expect(exitCodeFor(new Error('connect ECONNREFUSED 127.0.0.1:47749'))).toBe(EXIT.DAEMON);
});

test('client and server faults map onto the documented exit codes', () => {
  expect(exitCodeFor(new DaemonError(404, { error: 'no such session' }))).toBe(EXIT.USAGE);
  expect(exitCodeFor(new DaemonError(422, { error: 'bad body' }))).toBe(EXIT.USAGE);
  expect(exitCodeFor(new DaemonError(409, { error: 'already initialized' }))).toBe(EXIT.CONFIG);
  expect(exitCodeFor(new DaemonError(500, { error: 'boom' }))).toBe(EXIT.ERROR);
});

test('a malformed field is dropped without costing the fields beside it', () => {
  // `retryable` arrives as a string; the message and requestId next to it must still survive.
  const err = new DaemonError(400, {
    error: 'title is too long',
    requestId: 'req_abcdefghijkl',
    retryable: 'yes'
  });
  expect(err.toJSON()).toEqual({ error: 'title is too long', status: 400, requestId: 'req_abcdefghijkl' });
});
