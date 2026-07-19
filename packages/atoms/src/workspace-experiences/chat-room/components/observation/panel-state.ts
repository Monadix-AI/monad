import type { ExternalAgentConnectionSnapshot } from '@monad/protocol';

export type ObservationMode = 'raw' | 'convenience';

export interface ObservationPanelState {
  panelOpen: boolean;
  mode: ObservationMode;
  epoch: string | null;
  // The connection revision this state was reconciled from. Monotonic per session; a snapshot or
  // connection event carrying a lower revision is a stale straggler from an older connection and is
  // dropped, so a late frame can never resurrect a subscription for a connection that already moved on.
  revision: number;
  connected: boolean;
}

export type ObservationPanelEvent =
  | { type: 'panelOpened' }
  | { type: 'panelClosed' }
  | { type: 'connectionSnapshot'; snapshot: ExternalAgentConnectionSnapshot }
  | { type: 'connectionOpened'; epoch: string; revision: number }
  | { type: 'connectionClosed'; epoch: string }
  | { type: 'modeSelected'; mode: ObservationMode };

export const initialObservationPanelState: ObservationPanelState = {
  panelOpen: false,
  mode: 'convenience',
  epoch: null,
  revision: 0,
  connected: false
};

export function observationPanelReducer(
  state: ObservationPanelState,
  event: ObservationPanelEvent
): ObservationPanelState {
  switch (event.type) {
    case 'panelOpened':
      return { ...state, panelOpen: true };
    case 'panelClosed':
      return { ...state, panelOpen: false };
    case 'modeSelected':
      return { ...state, mode: event.mode };
    case 'connectionSnapshot': {
      const { snapshot } = event;
      if (snapshot.revision < state.revision) return state;
      if (snapshot.state === 'connected') {
        return { ...state, epoch: snapshot.observationEpoch, revision: snapshot.revision, connected: true };
      }
      return { ...state, epoch: null, revision: snapshot.revision, connected: false };
    }
    case 'connectionOpened':
      if (event.revision < state.revision) return state;
      return { ...state, epoch: event.epoch, revision: event.revision, connected: true };
    case 'connectionClosed':
      if (event.epoch !== state.epoch) return state;
      return { ...state, connected: false };
  }
}

export interface ObservationSubscription {
  active: boolean;
  epoch: string | null;
  mode: ObservationMode;
}

/** The scoped SSE subscription the panel should currently hold. The caller (re)opens a stream whenever
 *  `(active, epoch, mode)` changes and disposes it when `active` goes false. */
export function observationSubscription(state: ObservationPanelState): ObservationSubscription {
  return {
    active: state.panelOpen && state.connected && state.epoch !== null,
    epoch: state.epoch,
    mode: state.mode
  };
}
