import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { visibleSidebarSessions } from '../../src/features/shell/sidebar-chat-sessions';

test('the sidebar omits mesh chat sessions and keeps other session sources', () => {
  const sessions = [
    { id: 'ses_mesh00000001', origin: { surface: 'api', client: 'monad-app-server', transport: 'http' } },
    {
      id: 'ses_project000001',
      origin: { surface: 'api', client: 'monad-app-server', transport: 'http' },
      projectId: 'prj_project00001'
    },
    { id: 'ses_web000000001', origin: { surface: 'web', client: 'monad-web', transport: 'http' } },
    { id: 'ses_legacy000001' }
  ] satisfies Pick<Session, 'id' | 'origin' | 'projectId'>[];

  expect(visibleSidebarSessions(sessions).map((session) => session.id)).toEqual([
    'ses_project000001',
    'ses_web000000001',
    'ses_legacy000001'
  ]);
});
