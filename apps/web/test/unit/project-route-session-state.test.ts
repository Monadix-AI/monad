import { expect, test } from 'bun:test';

import { deriveProjectRouteSessionState } from '../../src/features/workspace/project-route-session-state';

test('route session state follows the URL session even when the project controller already selected it', () => {
  expect(
    deriveProjectRouteSessionState(
      {
        activeSessionId: 'ses_TARGET00000',
        projectSessions: [
          { id: 'ses_OTHER000000', title: 'other' },
          { id: 'ses_TARGET00000', title: 'target' }
        ]
      },
      'ses_TARGET00000'
    )
  ).toEqual({ activeSessionId: 'ses_TARGET00000', activeSessionTitle: 'target' });
});

test('project route without a session id uses the controller-selected active session', () => {
  expect(
    deriveProjectRouteSessionState(
      {
        activeSessionId: 'ses_ACTIVE00000',
        projectSessions: [
          { id: 'ses_ARCHIVED000', title: 'archived', archived: true },
          { id: 'ses_ACTIVE00000', title: 'active', archived: false }
        ]
      },
      null
    )
  ).toEqual({ activeSessionId: 'ses_ACTIVE00000', activeSessionTitle: 'active' });
});

test('missing URL session does not fall back to another project session', () => {
  expect(
    deriveProjectRouteSessionState(
      {
        activeSessionId: 'ses_ACTIVE00000',
        projectSessions: [{ id: 'ses_ACTIVE00000', title: 'active', archived: false }]
      },
      'ses_DELETED0000'
    )
  ).toEqual({ activeSessionId: null, activeSessionTitle: null });
});

test('project route without a session id does not reopen an archived session', () => {
  expect(
    deriveProjectRouteSessionState(
      {
        activeSessionId: 'ses_ARCHIVED000',
        projectSessions: [{ id: 'ses_ARCHIVED000', title: 'archived', archived: true }]
      },
      null
    )
  ).toEqual({ activeSessionId: null, activeSessionTitle: null });
});
