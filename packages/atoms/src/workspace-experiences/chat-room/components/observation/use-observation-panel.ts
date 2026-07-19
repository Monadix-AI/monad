import type {
  AgentObservationEvent,
  Event,
  ExternalAgentConnectionSnapshot,
  ExternalAgentConvenienceFrame,
  ExternalAgentRawFrame,
  ExternalAgentRawHistoryPage,
  SessionId
} from '@monad/protocol';
import type { ExternalAgentStreamView } from '../../../experience/types.ts';
import type { ObservationMode } from './panel-state.ts';
import type { RawFrameRow } from './raw-view.ts';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  connectionControlAction,
  convenienceHistoryRequest,
  foldConvenienceHistory,
  foldRawFrame,
  rawHistoryRows
} from './observation-panel-orchestration.ts';
import { initialObservationPanelState, observationPanelReducer, observationSubscription } from './panel-state.ts';
import { emptyObservationTimeline, mergeConvenienceFrame, type ObservationTimeline } from './timeline-merge.ts';

// The observation panel needs five daemon-facing RTK Query hooks. `@monad/atoms` reaches RTK hooks
// through `@monad/sdk-experience/react`; these are injected (not imported) so this container has a
// single, testable seam and no direct client-package dependency. Types are structural — a superset of
// the RTK results the container reads — so the concrete hooks satisfy them without adaptation.
export interface ObservationConnectionQueryResult {
  currentData?: ExternalAgentConnectionSnapshot;
  isLoading?: boolean;
  refetch: () => void;
}
export interface ObservationRawStreamResult {
  currentData?: { fatalError: boolean; frames: ExternalAgentRawFrame[]; frameOffset: number };
}
export interface ObservationConvenienceStreamResult {
  currentData?: { fatalError: boolean; frames: ExternalAgentConvenienceFrame[]; frameOffset: number };
}
export type ObservationLazyTrigger<Arg, Result> = (arg: Arg) => { unwrap: () => Promise<Result> };

export interface ObservationHistoryPageArg {
  id: string;
  transcriptTargetId: SessionId;
  request: ReturnType<typeof convenienceHistoryRequest>;
}

export interface ObservationPanelHooks {
  useConnection: (
    arg: { id: string; transcriptTargetId: SessionId },
    options: { skip: boolean }
  ) => ObservationConnectionQueryResult;
  useRawStream: (
    arg: { id: string; transcriptTargetId: SessionId; afterCursor?: string },
    options: { skip: boolean }
  ) => ObservationRawStreamResult;
  useConvenienceStream: (
    arg: { id: string; transcriptTargetId: SessionId; afterCursor?: string },
    options: { skip: boolean }
  ) => ObservationConvenienceStreamResult;
  useRawHistory: () => readonly [ObservationLazyTrigger<ObservationHistoryPageArg, ExternalAgentRawHistoryPage>];
  useConvenienceHistory: () => readonly [
    ObservationLazyTrigger<ObservationHistoryPageArg, ExternalAgentConvenienceFrame[]>
  ];
}

export interface UseObservationPanelArgs {
  externalAgentSessionId: string;
  transcriptTargetId: SessionId;
  agentName: string;
  provider: string;
  icon?: ExternalAgentStreamView['icon'];
  hooks: ObservationPanelHooks;
  // A source-derived signal (e.g. the observed stream's running status) that flips on connect/disconnect.
  // A change refetches the connection snapshot — the subscribe-first-then-refetch repair for the WS
  // connection.opened/closed notifications that `@monad/client-rtk`'s control stream does not yet surface.
  connectionSignal?: string;
  // Optional direct control-notification feed. When a connection-events hook lands, push each WS event
  // here and the container refetches (opened) or tears down (closed) per `connectionControlAction`.
  controlEvent?: Event | null;
}

export interface ObservationPanelController {
  mode: ObservationMode;
  setMode: (mode: ObservationMode) => void;
  open: () => void;
  close: () => void;
  panelOpen: boolean;
  connected: boolean;
  epoch: string | null;
  events: AgentObservationEvent[];
  rawRows: RawFrameRow[];
  loading: boolean;
  unavailableReason: string | null;
}

const EMPTY_RAW_FRAMES: ExternalAgentRawFrame[] = [];
const EMPTY_CONVENIENCE_FRAMES: ExternalAgentConvenienceFrame[] = [];

export function useObservationPanel(args: UseObservationPanelArgs): ObservationPanelController {
  const { externalAgentSessionId, transcriptTargetId, hooks, connectionSignal, controlEvent } = args;
  const [state, dispatch] = useReducer(observationPanelReducer, initialObservationPanelState);
  const subscription = observationSubscription(state);

  const connection = hooks.useConnection(
    { id: externalAgentSessionId, transcriptTargetId },
    { skip: !state.panelOpen || !externalAgentSessionId }
  );

  const snapshot = connection.currentData;
  useEffect(() => {
    if (snapshot) dispatch({ type: 'connectionSnapshot', snapshot });
  }, [snapshot]);

  const refetchConnection = connection.refetch;
  useEffect(() => {
    if (!state.panelOpen || !connectionSignal) return;
    refetchConnection();
  }, [connectionSignal, state.panelOpen, refetchConnection]);

  useEffect(() => {
    if (!controlEvent) return;
    const action = connectionControlAction(controlEvent, externalAgentSessionId);
    if (!action) return;
    if (action.kind === 'refetch') refetchConnection();
    else dispatch(action.event);
  }, [controlEvent, externalAgentSessionId, refetchConnection]);

  const rawActive = subscription.active && subscription.mode === 'raw';
  const convenienceActive = subscription.active && subscription.mode === 'convenience';

  // Re-scoping is driven by `skip`, not the args: an epoch rotation runs connection.closed→opened, which
  // flips `active` false→true, so the stream is disposed and re-subscribed (the client resumes each leg
  // from its own last-event-id). `scopeKey` below drops the accumulated plane so no stale-epoch frame
  // survives the gap.
  const rawStream = hooks.useRawStream({ id: externalAgentSessionId, transcriptTargetId }, { skip: !rawActive });
  const convenienceStream = hooks.useConvenienceStream(
    { id: externalAgentSessionId, transcriptTargetId },
    { skip: !convenienceActive }
  );

  const [rawHistoryTrigger] = hooks.useRawHistory();
  const [convenienceHistoryTrigger] = hooks.useConvenienceHistory();

  const [rawRows, setRawRows] = useState<RawFrameRow[]>([]);
  const [timeline, setTimeline] = useState<ObservationTimeline>(emptyObservationTimeline);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [loadedHistoryBoundary, setLoadedHistoryBoundary] = useState<string | null>(null);
  const historyLoadGenerationRef = useRef(0);
  const rawFrameCountRef = useRef(0);
  const convenienceFrameCountRef = useRef(0);

  // A change of (epoch, mode) is a fresh subscription scope — drop the previously accumulated plane so
  // stale-connection frames never mix into the new epoch.
  const scopeKey = `${subscription.epoch ?? ''}:${subscription.mode}:${subscription.active ? '1' : '0'}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger, not read in the body.
  useEffect(() => {
    setRawRows([]);
    setTimeline(emptyObservationTimeline);
    setHistoryLoading(false);
    setHistoryFailed(false);
    setLoadedHistoryBoundary(null);
    historyLoadGenerationRef.current += 1;
    rawFrameCountRef.current = 0;
    convenienceFrameCountRef.current = 0;
  }, [scopeKey]);

  // The RTK cache bounds `frames` to a fixed-size window (`RAW_FRAME_CAP`/`CONVENIENCE_FRAME_CAP`) and
  // reports how many older frames it evicted via `frameOffset`. Array length alone can't drive
  // consumption once the cap is reached — it stays flat while the window keeps sliding — so consumed
  // position is tracked as an absolute count (`frameOffset + frames.length`) and the read start clamps
  // to the current window (`max(consumed, frameOffset) - frameOffset`), which drops only frames that
  // were evicted before this consumer reached them and never drops one still in the window.
  const rawFrames = rawStream.currentData?.frames ?? EMPTY_RAW_FRAMES;
  const rawFrameOffset = rawStream.currentData?.frameOffset ?? 0;
  useEffect(() => {
    const consumed = rawFrameCountRef.current;
    const availableEnd = rawFrameOffset + rawFrames.length;
    if (availableEnd < consumed) rawFrameCountRef.current = 0;
    if (!rawActive || availableEnd <= rawFrameCountRef.current) return;
    const sliceStart = Math.max(rawFrameCountRef.current, rawFrameOffset) - rawFrameOffset;
    const nextFrames = rawFrames.slice(sliceStart);
    rawFrameCountRef.current = availableEnd;
    setRawRows((rows) => nextFrames.reduce(foldRawFrame, rows));
  }, [rawActive, rawFrames, rawFrameOffset]);

  const convenienceFrames = convenienceStream.currentData?.frames ?? EMPTY_CONVENIENCE_FRAMES;
  const convenienceFrameOffset = convenienceStream.currentData?.frameOffset ?? 0;
  useEffect(() => {
    const consumed = convenienceFrameCountRef.current;
    const availableEnd = convenienceFrameOffset + convenienceFrames.length;
    if (availableEnd < consumed) convenienceFrameCountRef.current = 0;
    if (!convenienceActive || availableEnd <= convenienceFrameCountRef.current) return;
    const sliceStart = Math.max(convenienceFrameCountRef.current, convenienceFrameOffset) - convenienceFrameOffset;
    const nextFrames = convenienceFrames.slice(sliceStart);
    convenienceFrameCountRef.current = availableEnd;
    setTimeline((current) => nextFrames.reduce(mergeConvenienceFrame, current));
  }, [convenienceActive, convenienceFrames, convenienceFrameOffset]);

  const snapshotHistoryBefore = snapshot?.state === 'connected' ? (snapshot.historyBefore ?? null) : null;
  const historyBefore = timeline.historyBefore ?? snapshotHistoryBefore;
  const backfilledBoundaryRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger, not read in the body.
  useEffect(() => {
    backfilledBoundaryRef.current = null;
  }, [scopeKey]);
  useEffect(() => {
    if (!subscription.active || !historyBefore) return;
    if (backfilledBoundaryRef.current === historyBefore) return;
    backfilledBoundaryRef.current = historyBefore;
    setHistoryLoading(true);
    setHistoryFailed(false);
    const generation = historyLoadGenerationRef.current;
    const arg: ObservationHistoryPageArg = {
      id: externalAgentSessionId,
      transcriptTargetId,
      request: convenienceHistoryRequest(historyBefore)
    };
    if (subscription.mode === 'convenience') {
      void convenienceHistoryTrigger(arg)
        .unwrap()
        .then((frames) => {
          if (historyLoadGenerationRef.current !== generation) return;
          setTimeline((current) => foldConvenienceHistory(current, frames));
        })
        .catch(() => {
          if (historyLoadGenerationRef.current === generation) setHistoryFailed(true);
        })
        .finally(() => {
          if (historyLoadGenerationRef.current !== generation) return;
          setLoadedHistoryBoundary(historyBefore);
          setHistoryLoading(false);
        });
    } else {
      void rawHistoryTrigger(arg)
        .unwrap()
        .then((page) => {
          if (historyLoadGenerationRef.current !== generation) return;
          setRawRows((rows) => [...rawHistoryRows(page), ...rows]);
        })
        .catch(() => {
          if (historyLoadGenerationRef.current === generation) setHistoryFailed(true);
        })
        .finally(() => {
          if (historyLoadGenerationRef.current !== generation) return;
          setLoadedHistoryBoundary(historyBefore);
          setHistoryLoading(false);
        });
    }
  }, [
    subscription.active,
    subscription.mode,
    historyBefore,
    externalAgentSessionId,
    transcriptTargetId,
    convenienceHistoryTrigger,
    rawHistoryTrigger
  ]);

  const open = useCallback(() => dispatch({ type: 'panelOpened' }), []);
  const close = useCallback(() => dispatch({ type: 'panelClosed' }), []);
  const setMode = useCallback((mode: ObservationMode) => dispatch({ type: 'modeSelected', mode }), []);

  const streamFatal =
    (rawActive && rawStream.currentData?.fatalError === true) ||
    (convenienceActive && convenienceStream.currentData?.fatalError === true);
  const events = useMemo(() => (streamFatal ? [] : timeline.events), [streamFatal, timeline.events]);
  const waitingForConvenienceReady =
    convenienceActive && !streamFatal && !timeline.unavailableReason && timeline.epoch !== subscription.epoch;
  const waitingForHistory = Boolean(historyBefore && loadedHistoryBoundary !== historyBefore);
  const loading =
    state.panelOpen &&
    (connection.isLoading === true ||
      !snapshot ||
      (subscription.active && !streamFatal && (waitingForConvenienceReady || waitingForHistory || historyLoading)));

  return {
    mode: state.mode,
    setMode,
    open,
    close,
    panelOpen: state.panelOpen,
    connected: state.connected,
    epoch: state.epoch,
    events,
    rawRows: streamFatal ? [] : rawRows,
    loading,
    unavailableReason:
      timeline.unavailableReason ??
      (streamFatal ? 'observation stream unavailable' : historyFailed ? 'provider history unavailable' : null)
  };
}
