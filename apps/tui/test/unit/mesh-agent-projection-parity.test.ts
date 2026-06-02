import type { MeshAgentStateSession, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { foldMeshAgentExperienceState } from '@monad/atoms/mesh-agent-state';

import { buildMeshAgentStateScenario } from '../../../../test/fixtures/mesh-agent-state-scenario.ts';
import { projectionPanelModel } from '../../src/components/projection-panel-model.ts';

const sessionId = 'ses_1234567890ab' as SessionId;

function observe(input: Parameters<typeof foldMeshAgentExperienceState>[0]) {
  const state = foldMeshAgentExperienceState(input);
  const sessions = [...state.sessions.values()];
  const observed =
    sessions.find((session) => session.lifecycle.state !== 'terminal') ?? (sessions[0] as MeshAgentStateSession);
  return projectionPanelModel(state, observed);
}

// The panel maps this model's runtime label plus its loginRequirements/approvals rows to Text lines;
// it must derive them from the shared atom fold over the same neutral frames the web surface consumes.
test('tui ProjectionPanel model exposes runtime status plus login and approval rows', () => {
  const scenario = buildMeshAgentStateScenario(sessionId);

  const running = observe(scenario.streamState);
  const idle = observe({ ...scenario.streamState, sessions: { [scenario.meshSessionId]: scenario.idle } });
  const terminal = observe({ ...scenario.streamState, sessions: { [scenario.meshSessionId]: scenario.terminal } });
  const stale = observe({ ...scenario.streamState, stale: true });

  expect({
    transitions: [running.runtime, idle.runtime, terminal.runtime, stale.runtime],
    loginRequirements: running.loginRequirements,
    approvals: running.approvals
  }).toEqual({
    transitions: [
      { kind: 'active', label: 'Active', tone: 'working' },
      { kind: 'idle', label: 'Idle', tone: 'idle' },
      { kind: 'terminal', label: 'Stopped', tone: 'idle' },
      { kind: 'stale', label: 'Reconnecting', tone: 'working' }
    ],
    loginRequirements: [scenario.loginRequirement],
    approvals: [scenario.approval]
  });
});
