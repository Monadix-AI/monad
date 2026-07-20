import type {
  AgentObservationEvent,
  Event,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage,
  SessionId
} from '@monad/protocol';
import type { AgentObservationCard } from '../../../../agent-adapters/observation-cards.ts';
import type { MeshAgentStreamView } from '../../../experience/types.ts';
import type { ObservationMode } from './panel-state.ts';
import type { RawFrameRow } from './raw-view.ts';

import { observationCursorSchema } from '@monad/protocol';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { agentObservationCards } from '../../../../agent-adapters/observation-cards.ts';
import {
  connectionControlAction,
  convenienceEventsRequest,
  foldConvenienceEvents,
  foldRawFrame,
  observationEventBootstrap,
  observationPanelLoading,
  prependRawEventsRows,
  rawEventsRows
} from './observation-panel-orchestration.ts';
import { initialObservationPanelState, observationPanelReducer, observationSubscription } from './panel-state.ts';
import { emptyObservationTimeline, mergeConvenienceFrame, type ObservationTimeline } from './timeline-merge.ts';

// The observation panel needs five daemon-facing RTK Query hooks. `@monad/atoms` reaches RTK hooks
// through `@monad/sdk-experience/react`; these are injected (not imported) so this container has a
// single, testable seam and no direct client-package dependency. Types are structural — a superset of
// the RTK results the container reads — so the concrete hooks satisfy them without adaptation.
export interface ObservationConnectionQueryResult {
  currentData?: MeshConnectionSnapshot;
  isLoading?: boolean;
  refetch: () => void;
}
export interface ObservationRawStreamResult {
  currentData?: { fatalError: boolean; frames: MeshRawEvent[]; frameOffset: number };
}
export interface ObservationConvenienceStreamResult {
  currentData?: { fatalError: boolean; frames: MeshConvenienceFrame[]; frameOffset: number };
}
export type ObservationLazyTrigger<Arg, Result> = (arg: Arg) => { unwrap: () => Promise<Result> };

export interface ObservationEventPageArg {
  id: string;
  transcriptTargetId: SessionId;
  request: ReturnType<typeof convenienceEventsRequest>;
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
  useRawEvents: () => readonly [ObservationLazyTrigger<ObservationEventPageArg, MeshRawEventPage>];
  useConvenienceEvents: () => readonly [ObservationLazyTrigger<ObservationEventPageArg, MeshConvenienceEventPage>];
}

export interface UseObservationPanelArgs {
  meshSessionId: string;
  transcriptTargetId: SessionId;
  agentName: string;
  provider: string;
  icon?: MeshAgentStreamView['icon'];
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
  cards: AgentObservationCard[];
  rawRows: RawFrameRow[];
  loading: boolean;
  canLoadOlderEvents: boolean;
  loadingOlderEvents: boolean;
  loadOlderEvents: () => void;
  retryOlderEvents: () => void;
  unavailableReason: string | null;
}

const EMPTY_RAW_FRAMES: MeshRawEvent[] = [];
const EMPTY_CONVENIENCE_FRAMES: MeshConvenienceFrame[] = [];

export function useObservationPanel(args: UseObservationPanelArgs): ObservationPanelController {
  const { meshSessionId, transcriptTargetId, hooks, connectionSignal, controlEvent } = args;
  const [state, dispatch] = useReducer(observationPanelReducer, {
    ...initialObservationPanelState,
    panelOpen: true
  });
  const subscription = observationSubscription(state);
  const panelScopeKey = `${meshSessionId}:${transcriptTargetId}`;

  useEffect(() => {
    if (!panelScopeKey) return;
    dispatch({ type: 'scopeReset' });
  }, [panelScopeKey]);

  const connection = hooks.useConnection(
    { id: meshSessionId, transcriptTargetId },
    { skip: !state.panelOpen || !meshSessionId }
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
    const action = connectionControlAction(controlEvent, meshSessionId);
    if (!action) return;
    if (action.kind === 'refetch') refetchConnection();
    else dispatch(action.event);
  }, [controlEvent, meshSessionId, refetchConnection]);

  const rawActive = subscription.active && subscription.mode === 'raw';
  const convenienceActive = subscription.active && subscription.mode === 'convenience';

  // Re-scoping is driven by `skip`, not the args: an epoch rotation runs connection.closed→opened, which
  // flips `active` false→true, so the stream is disposed and re-subscribed (the client resumes each leg
  // from its own last-event-id). `scopeKey` below drops the accumulated plane so no stale-epoch frame
  // survives the gap.
  const rawStream = hooks.useRawStream({ id: meshSessionId, transcriptTargetId }, { skip: !rawActive });
  const convenienceStream = hooks.useConvenienceStream(
    { id: meshSessionId, transcriptTargetId },
    { skip: !convenienceActive }
  );

  const [rawEventsTrigger] = hooks.useRawEvents();
  const [convenienceEventsTrigger] = hooks.useConvenienceEvents();

  const [rawRows, setRawRows] = useState<RawFrameRow[]>([]);
  const [timeline, setTimeline] = useState<ObservationTimeline>(emptyObservationTimeline);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsLoadingKind, setEventsLoadingKind] = useState<'bootstrap' | 'older' | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);
  const [loadedEventsKey, setLoadedEventsKey] = useState<string | null>(null);
  const [eventNextCursor, setEventsNextCursor] = useState<string | null>(null);
  // Bumped whenever a page request settles. A bootstrap that arrived while another request was in
  // flight is refused, and nothing else would ever re-trigger it — the panel would then wait on a
  // backfill that never runs, hiding the plane behind its loading state forever.
  const [eventsSettledCount, setEventsSettledCount] = useState(0);
  const eventsLoadGenerationRef = useRef(0);
  const eventsInFlightGenerationRef = useRef<number | null>(null);
  const lastEventRequestCursorRef = useRef<string | null>(null);
  const lastEventRequestKindRef = useRef<'bootstrap' | 'older'>('bootstrap');
  const rawFrameCountRef = useRef(0);
  const convenienceFrameCountRef = useRef(0);

  // A change of (epoch, mode) is a fresh subscription scope — drop the previously accumulated plane so
  // stale-connection frames never mix into the new epoch.
  const scopeKey = `${subscription.epoch ?? ''}:${subscription.mode}:${subscription.active ? '1' : '0'}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger, not read in the body.
  useEffect(() => {
    setRawRows([]);
    setTimeline(emptyObservationTimeline);
    setEventsLoading(false);
    setEventsLoadingKind(null);
    setEventsFailed(false);
    setLoadedEventsKey(null);
    setEventsNextCursor(null);
    eventsLoadGenerationRef.current += 1;
    eventsInFlightGenerationRef.current = null;
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

  const snapshotEventsBefore = snapshot?.state === 'connected' ? (snapshot.eventsBefore ?? null) : null;
  const eventsBefore = timeline.eventsBefore ?? snapshotEventsBefore;
  const eventBootstrap = useMemo(
    () =>
      observationEventBootstrap({
        panelOpen: state.panelOpen,
        connectionKnown: snapshot !== undefined,
        connected: state.connected,
        eventsBefore
      }),
    [state.panelOpen, state.connected, snapshot, eventsBefore]
  );
  const backfilledEventsKeyRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger, not read in the body.
  useEffect(() => {
    backfilledEventsKeyRef.current = null;
  }, [scopeKey]);
  const loadEventPage = useCallback(
    (
      before: string | null,
      bootstrapKey?: string,
      requestKind: 'bootstrap' | 'older' = bootstrapKey ? 'bootstrap' : 'older'
    ): boolean => {
      if (eventsInFlightGenerationRef.current !== null) return false;
      lastEventRequestCursorRef.current = before;
      lastEventRequestKindRef.current = requestKind;
      setEventsLoading(true);
      setEventsLoadingKind(requestKind);
      setEventsFailed(false);
      const generation = eventsLoadGenerationRef.current;
      eventsInFlightGenerationRef.current = generation;
      const arg: ObservationEventPageArg = {
        id: meshSessionId,
        transcriptTargetId,
        request: convenienceEventsRequest(before ? observationCursorSchema.parse(before) : null)
      };
      if (subscription.mode === 'convenience') {
        void convenienceEventsTrigger(arg)
          .unwrap()
          .then((page) => {
            if (eventsLoadGenerationRef.current !== generation) return;
            setTimeline((current) => foldConvenienceEvents(current, page.frames));
            setEventsNextCursor(page.nextCursor ?? null);
          })
          .catch(() => {
            if (eventsLoadGenerationRef.current === generation) setEventsFailed(true);
          })
          .finally(() => {
            if (eventsInFlightGenerationRef.current === generation) eventsInFlightGenerationRef.current = null;
            setEventsSettledCount((count) => count + 1);
            if (eventsLoadGenerationRef.current !== generation) return;
            if (bootstrapKey) setLoadedEventsKey(bootstrapKey);
            setEventsLoading(false);
            setEventsLoadingKind(null);
          });
      } else {
        void rawEventsTrigger(arg)
          .unwrap()
          .then((page) => {
            if (eventsLoadGenerationRef.current !== generation) return;
            setRawRows((rows) => prependRawEventsRows(rawEventsRows(page), rows));
            setEventsNextCursor(page.nextCursor ?? null);
          })
          .catch(() => {
            if (eventsLoadGenerationRef.current === generation) setEventsFailed(true);
          })
          .finally(() => {
            if (eventsInFlightGenerationRef.current === generation) eventsInFlightGenerationRef.current = null;
            setEventsSettledCount((count) => count + 1);
            if (eventsLoadGenerationRef.current !== generation) return;
            if (bootstrapKey) setLoadedEventsKey(bootstrapKey);
            setEventsLoading(false);
            setEventsLoadingKind(null);
          });
      }
      return true;
    },
    [subscription.mode, meshSessionId, transcriptTargetId, convenienceEventsTrigger, rawEventsTrigger]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventsSettledCount re-runs a refused bootstrap
  useEffect(() => {
    if (!eventBootstrap) return;
    if (backfilledEventsKeyRef.current === eventBootstrap.key) return;
    if (!loadEventPage(eventBootstrap.request.before ?? null, eventBootstrap.key)) return;
    backfilledEventsKeyRef.current = eventBootstrap.key;
  }, [eventBootstrap, eventsSettledCount, loadEventPage]);

  const open = useCallback(() => dispatch({ type: 'panelOpened' }), []);
  const close = useCallback(() => dispatch({ type: 'panelClosed' }), []);
  const setMode = useCallback((mode: ObservationMode) => dispatch({ type: 'modeSelected', mode }), []);

  const streamFatal =
    (rawActive && rawStream.currentData?.fatalError === true) ||
    (convenienceActive && convenienceStream.currentData?.fatalError === true);
  const events = useMemo(() => (streamFatal ? [] : timeline.events), [streamFatal, timeline.events]);
  const cards = useMemo(() => agentObservationCards(events, args.provider), [args.provider, events]);
  const waitingForConvenienceReady =
    convenienceActive && !streamFatal && !timeline.unavailableReason && timeline.epoch !== subscription.epoch;
  const waitingForEvents = Boolean(eventBootstrap && loadedEventsKey !== eventBootstrap.key);
  const loading = observationPanelLoading({
    panelOpen: state.panelOpen,
    contentAvailable: subscription.mode === 'raw' ? rawRows.length > 0 : timeline.events.length > 0,
    connectionLoading: connection.isLoading === true,
    connectionKnown: snapshot !== undefined,
    liveWaiting: subscription.active && !streamFatal && waitingForConvenienceReady,
    eventsWaiting: waitingForEvents,
    eventsLoading
  });
  const loadOlderEvents = useCallback(() => {
    if (eventNextCursor) loadEventPage(eventNextCursor);
  }, [eventNextCursor, loadEventPage]);
  const retryOlderEvents = useCallback(() => {
    loadEventPage(lastEventRequestCursorRef.current, undefined, lastEventRequestKindRef.current);
  }, [loadEventPage]);

  return {
    mode: state.mode,
    setMode,
    open,
    close,
    panelOpen: state.panelOpen,
    connected: state.connected,
    epoch: state.epoch,
    events,
    cards,
    rawRows: streamFatal ? [] : rawRows,
    loading,
    canLoadOlderEvents: eventNextCursor !== null && !eventsFailed,
    loadingOlderEvents: eventsLoading && eventsLoadingKind === 'older',
    loadOlderEvents,
    retryOlderEvents,
    unavailableReason:
      timeline.unavailableReason ??
      (streamFatal ? 'observation stream unavailable' : eventsFailed ? 'provider events unavailable' : null)
  };
}
