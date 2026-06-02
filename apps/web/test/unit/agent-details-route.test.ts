import { describe, expect, test } from 'bun:test';

import { studioDetailPath } from '../../src/features/shell/routing/paths.ts';
import { parseAgentDetailsRoute } from '../../src/features/studio/agent-details/agent-details-route.ts';

const agentId = 'agt_000000000001';

describe('Agent details route model', () => {
  test('normalizes missing and invalid trails to Chat sessions', () => {
    expect(parseAgentDetailsRoute([agentId])).toEqual({
      mode: 'detail',
      primary: 'sessions',
      secondary: 'chat'
    });
    expect(parseAgentDetailsRoute([agentId, 'unknown', 'laws'])).toEqual({
      mode: 'detail',
      primary: 'sessions',
      secondary: 'chat'
    });
  });

  test('recognizes edit independently of detail tabs', () => {
    expect(parseAgentDetailsRoute([agentId, 'edit'])).toEqual({
      mode: 'edit',
      primary: 'sessions',
      secondary: 'chat'
    });
  });

  test('round-trips every explicit Session and Memory tab path', () => {
    const routes = [
      ['sessions', 'chat'],
      ['sessions', 'project'],
      ['sessions', 'monadix'],
      ['memory', 'facts'],
      ['memory', 'graph'],
      ['memory', 'laws']
    ] as const;
    expect(
      routes.map(([primary, secondary]) => ({
        path: studioDetailPath('agents', agentId, primary, secondary),
        route: parseAgentDetailsRoute([agentId, primary, secondary])
      }))
    ).toEqual([
      {
        path: `/studio/agents/${agentId}/sessions/chat`,
        route: { mode: 'detail', primary: 'sessions', secondary: 'chat' }
      },
      {
        path: `/studio/agents/${agentId}/sessions/project`,
        route: { mode: 'detail', primary: 'sessions', secondary: 'project' }
      },
      {
        path: `/studio/agents/${agentId}/sessions/monadix`,
        route: { mode: 'detail', primary: 'sessions', secondary: 'monadix' }
      },
      {
        path: `/studio/agents/${agentId}/memory/facts`,
        route: { mode: 'detail', primary: 'memory', secondary: 'facts' }
      },
      {
        path: `/studio/agents/${agentId}/memory/graph`,
        route: { mode: 'detail', primary: 'memory', secondary: 'graph' }
      },
      {
        path: `/studio/agents/${agentId}/memory/laws`,
        route: { mode: 'detail', primary: 'memory', secondary: 'laws' }
      }
    ]);
  });
});
