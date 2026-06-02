import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildMeshAgentStateScenario } from '../../../../test/fixtures/mesh-agent-state-scenario.ts';
import { meshWorkspaceStatusView } from '../../src/features/workplace/mesh-workspace-status.ts';

const sessionId = 'ses_1234567890ab' as SessionId;

// Drives the same adapter ProjectHeader consumes, so the reconnecting indicator and the member
// status label both come from the shared atom fold — not from daemon-shipped presentation copy.
test('web workspace status adapter derives runtime status and the reconnecting indicator', () => {
  const scenario = buildMeshAgentStateScenario(sessionId);

  const running = meshWorkspaceStatusView(scenario.streamState);
  const idle = meshWorkspaceStatusView({
    ...scenario.streamState,
    sessions: { [scenario.meshSessionId]: scenario.idle }
  });
  const terminal = meshWorkspaceStatusView({
    ...scenario.streamState,
    sessions: { [scenario.meshSessionId]: scenario.terminal }
  });
  const stale = meshWorkspaceStatusView({ ...scenario.streamState, stale: true });
  const empty = meshWorkspaceStatusView(undefined);

  expect({ running, idle, terminal, stale, empty }).toEqual({
    running: { runtime: { kind: 'active', label: 'Active', tone: 'working' }, reconnecting: false },
    idle: { runtime: { kind: 'idle', label: 'Idle', tone: 'idle' }, reconnecting: false },
    terminal: { runtime: { kind: 'terminal', label: 'Stopped', tone: 'idle' }, reconnecting: false },
    stale: { runtime: { kind: 'stale', label: 'Reconnecting', tone: 'working' }, reconnecting: true },
    empty: { runtime: null, reconnecting: false }
  });
});
