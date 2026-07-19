// Observation Task 5: the panel's connection-lifecycle state machine as a pure reducer. It is driven
// by the stable protocol frames (connection snapshot + WS connection.opened/closed) and decides when a
// scoped raw/convenience SSE subscription should be held. Race-free: stale epochs/revisions are
// ignored so a late event from an older connection cannot resurrect a subscription. See the design's
// Observation-panel state machine.

import type { ExternalAgentConnectionSnapshot } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  initialObservationPanelState,
  observationPanelReducer,
  observationSubscription
} from '../../src/workspace-experiences/chat-room/components/observation/panel-state.ts';

const SESSION = 'exa_000000000001' as const;

function connected(epoch: string, revision: number): ExternalAgentConnectionSnapshot {
  return { state: 'connected', externalAgentSessionId: SESSION, provider: 'codex', observationEpoch: epoch, revision };
}

test('a fresh panel holds no subscription', () => {
  expect(observationSubscription(initialObservationPanelState)).toEqual({
    active: false,
    epoch: null,
    mode: 'convenience'
  });
});

test('opening the panel on a connected snapshot activates a scoped subscription', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e1', 3) });
  expect(observationSubscription(state)).toEqual({ active: true, epoch: 'e1', mode: 'convenience' });
});

test('a disconnected snapshot deactivates the subscription', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e1', 3) });
  state = observationPanelReducer(state, {
    type: 'connectionSnapshot',
    snapshot: { state: 'disconnected', externalAgentSessionId: SESSION, revision: 4 }
  });
  expect(observationSubscription(state).active).toBe(false);
});

test('connection.opened for a newer epoch re-scopes the subscription', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e1', 3) });
  state = observationPanelReducer(state, { type: 'connectionOpened', epoch: 'e2', revision: 5 });
  expect(observationSubscription(state)).toEqual({ active: true, epoch: 'e2', mode: 'convenience' });
});

test('a stale connection.opened with an older revision is ignored', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e2', 5) });
  state = observationPanelReducer(state, { type: 'connectionOpened', epoch: 'e1', revision: 2 });
  expect(observationSubscription(state)).toEqual({ active: true, epoch: 'e2', mode: 'convenience' });
});

test('connection.closed for the current epoch stops the subscription; a stale close is ignored', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e2', 5) });
  const staleClose = observationPanelReducer(state, { type: 'connectionClosed', epoch: 'e1' });
  expect(observationSubscription(staleClose).active).toBe(true);
  const realClose = observationPanelReducer(state, { type: 'connectionClosed', epoch: 'e2' });
  expect(observationSubscription(realClose).active).toBe(false);
});

test('switching mode re-scopes the subscription to the same epoch', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e1', 3) });
  state = observationPanelReducer(state, { type: 'modeSelected', mode: 'raw' });
  expect(observationSubscription(state)).toEqual({ active: true, epoch: 'e1', mode: 'raw' });
});

test('closing the panel disposes the subscription without losing connection state', () => {
  let state = observationPanelReducer(initialObservationPanelState, { type: 'panelOpened' });
  state = observationPanelReducer(state, { type: 'connectionSnapshot', snapshot: connected('e1', 3) });
  state = observationPanelReducer(state, { type: 'panelClosed' });
  expect(observationSubscription(state).active).toBe(false);
  const reopened = observationPanelReducer(state, { type: 'panelOpened' });
  expect(observationSubscription(reopened)).toEqual({ active: true, epoch: 'e1', mode: 'convenience' });
});
