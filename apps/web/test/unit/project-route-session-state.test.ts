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
