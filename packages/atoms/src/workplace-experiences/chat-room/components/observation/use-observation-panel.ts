import type {
  AgentObservationEvent,
  Event,
  MeshAgentSessionUsage,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage,
  SessionId
} from '@monad/protocol';
import type { MeshAgentStreamView } from '../../../experience/types.ts';
import type { AgentObservationCard } from './card-projection.ts';
import type { ObservationMode } from './panel-state.ts';
import type { RawFrameRow } from './raw-view.ts';

import { observationCursorSchema } from '@monad/protocol';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { agentObservationCards } from './card-projection.ts';
import {
  connectionControlAction,
  convenienceEventsRequest,
  foldConvenienceEvents,
  foldRawFrame,
  observationEventBootstrap,
  observationPanelLoading,
  observationVisiblePlane,
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
  useSessionUsage: (
    arg: { id: string; transcriptTargetId: SessionId },
    options: { skip: boolean }
  ) => { currentData?: MeshAgentSessionUsage | null; isError?: boolean; isLoading?: boolean };
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

interface ObservationEventPageState {
  failed: boolean;
  loadedKey: string | null;
  loading: boolean;
  loadingKind: 'bootstrap' | 'older' | null;
  nextCursor: string | null;
  settledCount: number;
}

function initialObservationEventPageState(): Record<ObservationMode, ObservationEventPageState> {
  const page = (): ObservationEventPageState => ({
    failed: false,
    loadedKey: null,
    loading: false,
    loadingKind: null,
    nextCursor: null,
    settledCount: 0
  });
  return { convenience: page(), raw: page() };
}

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

  const [rawRows, setRawRows] = useState<RawFrameRow[]>([]);
  const [timeline, setTimeline] = useState<ObservationTimeline>(emptyObservationTimeline);
  const [eventPages, setEventPages] = useState(initialObservationEventPageState);
  const rawActive = subscription.active && subscription.mode === 'raw';
  const convenienceActive = subscription.active && subscription.mode === 'convenience';
  const rawResumeCursor = rawRows.at(-1)?.cursor || undefined;
  const convenienceResumeCursor = timeline.cursor ?? undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each activation captures one resume cursor; live cursor updates must not recreate the RTK stream cache entry.
  const rawStreamArg = useMemo(
    () => ({ id: meshSessionId, transcriptTargetId, ...(rawResumeCursor ? { afterCursor: rawResumeCursor } : {}) }),
    [meshSessionId, rawActive, subscription.epoch, transcriptTargetId]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: each activation captures one resume cursor; live cursor updates must not recreate the RTK stream cache entry.
  const convenienceStreamArg = useMemo(
    () => ({
      id: meshSessionId,
      transcriptTargetId,
      ...(convenienceResumeCursor ? { afterCursor: convenienceResumeCursor } : {})
    }),
    [convenienceActive, meshSessionId, subscription.epoch, transcriptTargetId]
  );

  // Re-scoping is driven by `skip`: Last-Event-ID resumes one cache entry, while the captured `afterCursor`
  // resumes a plane after mode switching created a new entry. `dataScopeKey` below still drops both planes
  // on epoch/activity changes so no stale-epoch frame survives the gap.
  const rawStream = hooks.useRawStream(rawStreamArg, { skip: !rawActive });
  const convenienceStream = hooks.useConvenienceStream(convenienceStreamArg, { skip: !convenienceActive });

  const [rawEventsTrigger] = hooks.useRawEvents();
  const [convenienceEventsTrigger] = hooks.useConvenienceEvents();

  const eventPage = eventPages[subscription.mode];
  // Bumped whenever a page request settles. A bootstrap that arrived while another request was in
  // flight is refused, and nothing else would ever re-trigger it — the panel would then wait on a
  // backfill that never runs, hiding the plane behind its loading state forever.
  const eventsLoadGenerationRef = useRef<Record<ObservationMode, number>>({ convenience: 0, raw: 0 });
  const eventsInFlightGenerationRef = useRef<Record<ObservationMode, number | null>>({
    convenience: null,
    raw: null
  });
  const lastEventRequestCursorRef = useRef<Record<ObservationMode, string | null>>({
    convenience: null,
    raw: null
  });
  const lastEventRequestKindRef = useRef<Record<ObservationMode, 'bootstrap' | 'older'>>({
    convenience: 'bootstrap',
    raw: 'bootstrap'
  });
  const backfilledEventsKeyRef = useRef<Record<ObservationMode, string | null>>({
    convenience: null,
    raw: null
  });
  const rawFrameCountRef = useRef(0);
  const convenienceFrameCountRef = useRef(0);
  const retainedPlaneRef = useRef<{
    panelScopeKey: string;
    rawRows: RawFrameRow[];
    events: AgentObservationEvent[];
  }>({ panelScopeKey, rawRows: [], events: [] });
  const retainedScopeChanged = retainedPlaneRef.current.panelScopeKey !== panelScopeKey;

  useEffect(() => {
    const retained = retainedPlaneRef.current;
    if (retainedScopeChanged) {
      retainedPlaneRef.current = { panelScopeKey, rawRows: [], events: [] };
      return;
    }
    if (rawRows.length === 0 && timeline.events.length === 0) return;
    retainedPlaneRef.current = {
      panelScopeKey,
      rawRows: rawRows.length > 0 ? rawRows : retained.rawRows,
      events: timeline.events.length > 0 ? timeline.events : retained.events
    };
  }, [panelScopeKey, rawRows, retainedScopeChanged, timeline.events]);

  // Epoch/activity changes replace both planes. Mode changes only select a plane; each plane keeps its
  // accumulated rows and pagination state so switching views never destroys already rendered data.
  const dataScopeKey = `${subscription.epoch ?? ''}:${subscription.active ? '1' : '0'}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataScopeKey is the reset trigger, not read in the body.
  useEffect(() => {
    setRawRows([]);
    setTimeline(emptyObservationTimeline);
    setEventPages(initialObservationEventPageState());
    eventsLoadGenerationRef.current.convenience += 1;
    eventsLoadGenerationRef.current.raw += 1;
    eventsInFlightGenerationRef.current = { convenience: null, raw: null };
    lastEventRequestCursorRef.current = { convenience: null, raw: null };
    lastEventRequestKindRef.current = { convenience: 'bootstrap', raw: 'bootstrap' };
    backfilledEventsKeyRef.current = { convenience: null, raw: null };
    rawFrameCountRef.current = 0;
    convenienceFrameCountRef.current = 0;
  }, [dataScopeKey]);

  // The RTK cache bounds `frames` to a fixed-size window (`RAW_FRAME_CAP`/`CONVENIENCE_FRAME_CAP`) and
  // reports how many older frames it evicted via `frameOffset`. Array length alone can't drive
  // consumption once the cap is reached — it stays flat while the window keeps sliding — so consumed
  // position is tracked as an absolute count (`frameOffset + frames.length`) and the read start clamps
  // to the current window (`max(consumed, frameOffset) - frameOffset`), which drops only frames that
  // were evicted before this consumer reached them and never drops one still in the window.
  const rawFrames = rawStream.currentData?.frames ?? EMPTY_RAW_FRAMES;
  const rawFrameOffset = rawStream.currentData?.frameOffset ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new RTK stream cache entry restarts frameOffset at zero.
  useEffect(() => {
    rawFrameCountRef.current = 0;
  }, [rawStreamArg]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new RTK stream cache entry restarts frameOffset at zero.
  useEffect(() => {
    convenienceFrameCountRef.current = 0;
  }, [convenienceStreamArg]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataScopeKey re-seeds cursors after the scope reset clears page state.
  useEffect(() => {
    if (!state.panelOpen || !state.connected) return;
    setEventPages((current) => {
      const convenienceCursor =
        current.convenience.loading || current.convenience.settledCount > 0
          ? current.convenience.nextCursor
          : eventsBefore;
      const rawCursor =
        current.raw.loading || current.raw.settledCount > 0 ? current.raw.nextCursor : snapshotEventsBefore;
      if (current.convenience.nextCursor === convenienceCursor && current.raw.nextCursor === rawCursor) return current;
      return {
        convenience: { ...current.convenience, nextCursor: convenienceCursor },
        raw: { ...current.raw, nextCursor: rawCursor }
      };
    });
  }, [dataScopeKey, eventsBefore, snapshotEventsBefore, state.connected, state.panelOpen]);
  // Connected sessions bootstrap their transcript page automatically too: loading history is the
  // panel's job, not a scroll gesture — a short timeline can never reach the scroll trigger, which
  // left the panel showing live-only events under a permanent "scroll up" hint.
  const eventBootstrap = useMemo(
    () =>
      observationEventBootstrap({
        panelOpen: state.panelOpen,
        connectionKnown: snapshot !== undefined,
        connected: state.connected,
        eventsBefore
      }),
    [state.connected, state.panelOpen, snapshot, eventsBefore]
  );
  const loadEventPage = useCallback(
    (
      before: string | null,
      bootstrapKey?: string,
      requestKind: 'bootstrap' | 'older' = bootstrapKey ? 'bootstrap' : 'older'
    ): boolean => {
      const mode = subscription.mode;
      if (eventsInFlightGenerationRef.current[mode] !== null) return false;
      lastEventRequestCursorRef.current[mode] = before;
      lastEventRequestKindRef.current[mode] = requestKind;
      setEventPages((current) => ({
        ...current,
        [mode]: { ...current[mode], failed: false, loading: true, loadingKind: requestKind }
      }));
      const generation = eventsLoadGenerationRef.current[mode];
      eventsInFlightGenerationRef.current[mode] = generation;
      const arg: ObservationEventPageArg = {
        id: meshSessionId,
        transcriptTargetId,
        request: convenienceEventsRequest(before ? observationCursorSchema.parse(before) : null)
      };
      if (mode === 'convenience') {
        void convenienceEventsTrigger(arg)
          .unwrap()
          .then((page) => {
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setTimeline((current) => foldConvenienceEvents(current, page.frames));
            setEventPages((current) => ({
              ...current,
              [mode]: { ...current[mode], nextCursor: page.nextCursor ?? null }
            }));
          })
          .catch(() => {
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setEventPages((current) => ({
              ...current,
              [mode]: { ...current[mode], failed: true }
            }));
          })
          .finally(() => {
            if (eventsInFlightGenerationRef.current[mode] === generation) {
              eventsInFlightGenerationRef.current[mode] = null;
            }
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setEventPages((current) => ({
              ...current,
              [mode]: {
                ...current[mode],
                ...(bootstrapKey ? { loadedKey: bootstrapKey } : {}),
                loading: false,
                loadingKind: null,
                settledCount: current[mode].settledCount + 1
              }
            }));
          });
      } else {
        void rawEventsTrigger(arg)
          .unwrap()
          .then((page) => {
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setRawRows((rows) => prependRawEventsRows(rawEventsRows(page), rows));
            setEventPages((current) => ({
              ...current,
              [mode]: { ...current[mode], nextCursor: page.nextCursor ?? null }
            }));
          })
          .catch(() => {
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setEventPages((current) => ({
              ...current,
              [mode]: { ...current[mode], failed: true }
            }));
          })
          .finally(() => {
            if (eventsInFlightGenerationRef.current[mode] === generation) {
              eventsInFlightGenerationRef.current[mode] = null;
            }
            if (eventsLoadGenerationRef.current[mode] !== generation) return;
            setEventPages((current) => ({
              ...current,
              [mode]: {
                ...current[mode],
                ...(bootstrapKey ? { loadedKey: bootstrapKey } : {}),
                loading: false,
                loadingKind: null,
                settledCount: current[mode].settledCount + 1
              }
            }));
          });
      }
      return true;
    },
    [subscription.mode, meshSessionId, transcriptTargetId, convenienceEventsTrigger, rawEventsTrigger]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventPage.settledCount re-runs a refused bootstrap
  useEffect(() => {
    if (!eventBootstrap) return;
    const mode = subscription.mode;
    if (backfilledEventsKeyRef.current[mode] === eventBootstrap.key) return;
    if (!loadEventPage(eventBootstrap.request.before ?? null, eventBootstrap.key)) return;
    backfilledEventsKeyRef.current[mode] = eventBootstrap.key;
  }, [eventBootstrap, eventPage.settledCount, loadEventPage, subscription.mode]);

  const open = useCallback(() => dispatch({ type: 'panelOpened' }), []);
  const close = useCallback(() => dispatch({ type: 'panelClosed' }), []);
  const setMode = useCallback((mode: ObservationMode) => dispatch({ type: 'modeSelected', mode }), []);

  const streamFatal =
    (rawActive && rawStream.currentData?.fatalError === true) ||
    (convenienceActive && convenienceStream.currentData?.fatalError === true);
  const waitingForConvenienceReady =
    convenienceActive && !streamFatal && !timeline.unavailableReason && timeline.epoch !== subscription.epoch;
  const waitingForEvents = Boolean(eventBootstrap && eventPage.loadedKey !== eventBootstrap.key);
  const currentLoading = observationPanelLoading({
    panelOpen: state.panelOpen,
    contentAvailable: subscription.mode === 'raw' ? rawRows.length > 0 : timeline.events.length > 0,
    connectionLoading: connection.isLoading === true,
    connectionKnown: snapshot !== undefined,
    liveWaiting: subscription.active && !streamFatal && waitingForConvenienceReady,
    eventsWaiting: waitingForEvents,
    eventsLoading: eventPage.loading
  });
  const retainedPlane =
    retainedPlaneRef.current.panelScopeKey === panelScopeKey
      ? retainedPlaneRef.current
      : { panelScopeKey, rawRows: [], events: [] };
  const unavailable = streamFatal || Boolean(timeline.unavailableReason) || eventPage.failed;
  const events = observationVisiblePlane({
    current: streamFatal ? [] : timeline.events,
    retained: retainedPlane.events,
    replacementPending: currentLoading,
    unavailable
  });
  const visibleRawRows = observationVisiblePlane({
    current: streamFatal ? [] : rawRows,
    retained: retainedPlane.rawRows,
    replacementPending: currentLoading,
    unavailable
  });
  const cards = useMemo(() => agentObservationCards(events, args.provider), [args.provider, events]);
  const contentAvailable = subscription.mode === 'raw' ? visibleRawRows.length > 0 : events.length > 0;
  const loading = currentLoading && !contentAvailable;
  useEffect(() => {
    if (retainedScopeChanged || (currentLoading && !unavailable)) return;
    const retained = retainedPlaneRef.current;
    if (retained.panelScopeKey !== panelScopeKey) return;
    if (subscription.mode === 'raw' && rawRows.length === 0 && retained.rawRows.length > 0) {
      retainedPlaneRef.current = { ...retained, rawRows: [] };
    }
    if (subscription.mode === 'convenience' && timeline.events.length === 0 && retained.events.length > 0) {
      retainedPlaneRef.current = { ...retainedPlaneRef.current, events: [] };
    }
  }, [
    currentLoading,
    panelScopeKey,
    rawRows.length,
    retainedScopeChanged,
    subscription.mode,
    timeline.events.length,
    unavailable
  ]);
  const loadOlderEvents = useCallback(() => {
    if (eventPage.nextCursor) loadEventPage(eventPage.nextCursor);
  }, [eventPage.nextCursor, loadEventPage]);
  const retryOlderEvents = useCallback(() => {
    const mode = subscription.mode;
    loadEventPage(lastEventRequestCursorRef.current[mode], undefined, lastEventRequestKindRef.current[mode]);
  }, [loadEventPage, subscription.mode]);

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
    rawRows: visibleRawRows,
    loading,
    canLoadOlderEvents: eventPage.nextCursor !== null && !eventPage.failed,
    // Any in-flight page fetch (bootstrap included) renders as loading — the scroll hint must never
    // show while the panel is already fetching.
    loadingOlderEvents: eventPage.loading,
    loadOlderEvents,
    retryOlderEvents,
    unavailableReason:
      timeline.unavailableReason ??
      (streamFatal ? 'observation stream unavailable' : eventPage.failed ? 'provider events unavailable' : null)
  };
}
