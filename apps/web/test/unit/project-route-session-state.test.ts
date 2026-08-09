import { expect, test } from 'bun:test';

import {
  deriveProjectRouteSessionState,
  resolveVisibleProjectSessionId
} from '../../src/features/workspace/project-route-session-state';

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

test('a newly routed session stays empty while the project session query catches up', () => {
  expect(
    resolveVisibleProjectSessionId({
      controllerSessionId: 'ses_PREVIOUS0000',
      routedSessionId: 'ses_NEW000000000',
      routedSessionState: { activeSessionId: null, activeSessionTitle: null }
    })
  ).toBeNull();
});

test('a project route without a session keeps the controller-selected session', () => {
  expect(
    resolveVisibleProjectSessionId({
      controllerSessionId: 'ses_ACTIVE00000',
      routedSessionId: null,
      routedSessionState: { activeSessionId: null, activeSessionTitle: null }
    })
  ).toBe('ses_ACTIVE00000');
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
