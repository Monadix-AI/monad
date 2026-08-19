import type { LiveEventReplayCapture, MeshRawEventPage, ObservationCursor, SessionId } from '@monad/protocol';

import {
  skipToken,
  useGetDeveloperQuery,
  useGetLiveEventReplayFramesQuery,
  useLazyGetLiveEventReplayFramesQuery,
  useLazyGetMeshAgentRawEventsQuery,
  useListLiveEventReplayCapturesQuery,
  useListMeshSessionsQuery,
  useListSessionMembersQuery
} from '@monad/client-rtk';
import { observationCursorSchema } from '@monad/protocol';
import { Button, CodeBlock } from '@monad/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { LiveEventReplayPanel } from './LiveEventReplayPanel';
import {
  formattedReplayPayload,
  historyReplayFrames,
  liveReplayFrames,
  type ReplayRawFrame,
  type ReplaySource,
  replayProjection,
  selectReplayOption
} from './live-event-replay-model';

const LIVE_PAGE_LIMIT = 5_000;

export interface LiveEventReplayProps {
  initialSelection?: {
    projectId: string;
    sessionId: string;
    memberId: string;
    source: ReplaySource;
  };
}

export function LiveEventReplay({ initialSelection }: LiveEventReplayProps): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const developer = useGetDeveloperQuery(undefined, { refetchOnMountOrArgChange: true });
  const capturesQuery = useListLiveEventReplayCapturesQuery(undefined, {
    skip: developer.data?.developerMode !== true
  });
  const captures = capturesQuery.data?.captures ?? [];
  const [projectId, setProjectId] = useState(initialSelection?.projectId ?? '');
  const [sessionId, setSessionId] = useState(initialSelection?.sessionId ?? '');
  const [memberId, setMemberId] = useState(initialSelection?.memberId ?? '');
  const [meshSessionId, setMeshSessionId] = useState('');
  const [observationEpoch, setObservationEpoch] = useState('');
  const [source, setSource] = useState<ReplaySource>(initialSelection?.source ?? 'live');
  const [step, setStep] = useState(0);
  const [historyFrames, setHistoryFrames] = useState<ReplayRawFrame[]>([]);
  const [liveExtra, setLiveExtra] = useState<{ captureKey: string; frames: ReplayRawFrame[] }>({
    captureKey: '',
    frames: []
  });
  const [historyCursor, setHistoryCursor] = useState<ObservationCursor>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const finalRenderEndRef = useRef<HTMLDivElement>(null);
  const selectedNormalizedEventRef = useRef<HTMLDivElement>(null);
  const selectedRawFrameRef = useRef<HTMLButtonElement>(null);
  const [getHistory, historyRequest] = useLazyGetMeshAgentRawEventsQuery();
  const [getMoreLive, moreLiveRequest] = useLazyGetLiveEventReplayFramesQuery();

  const projects = uniqueCaptures(captures, 'projectId');
  const projectCaptures = captures.filter((capture) => capture.projectId === projectId);
  const sessions = uniqueCaptures(projectCaptures, 'sessionId');
  const sessionCaptures = projectCaptures.filter((capture) => capture.sessionId === sessionId);
  const sessionMembersQuery = useListSessionMembersQuery(sessionId ? (sessionId as SessionId) : skipToken);
  const meshSessionsQuery = useListMeshSessionsQuery(sessionId ? (sessionId as SessionId) : skipToken);
  const memberOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const capture of sessionCaptures)
      byId.set(capture.projectMemberId, { id: capture.projectMemberId, name: capture.memberName });
    if (sessionMembersQuery.data) {
      for (const id of sessionMembersQuery.data.ids) {
        const entry = sessionMembersQuery.data.entities[id];
        if (entry) byId.set(entry.member.id, { id: entry.member.id, name: entry.member.displayName });
      }
    }
    return [...byId.values()];
  }, [sessionCaptures, sessionMembersQuery.data]);
  const memberCaptures = sessionCaptures.filter((capture) => capture.projectMemberId === memberId);
  const nativeSessions = useMemo(() => {
    const byId = new Map<string, { id: string; provider: string; updatedAt: string }>();
    for (const capture of memberCaptures) {
      byId.set(capture.meshSessionId, {
        id: capture.meshSessionId,
        provider: capture.provider,
        updatedAt: capture.updatedAt
      });
    }
    if (meshSessionsQuery.data) {
      for (const id of meshSessionsQuery.data.ids) {
        const session = meshSessionsQuery.data.entities[id];
        if (session?.projectMemberId === memberId) {
          byId.set(session.id, { id: session.id, provider: session.provider, updatedAt: session.updatedAt });
        }
      }
    }
    return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [memberCaptures, memberId, meshSessionsQuery.data]);
  const epochs = memberCaptures.filter((capture) => capture.meshSessionId === meshSessionId);
  const capture = useMemo(
    () =>
      captures.find(
        (item) =>
          item.projectId === projectId &&
          item.sessionId === sessionId &&
          item.projectMemberId === memberId &&
          item.meshSessionId === meshSessionId &&
          item.observationEpoch === observationEpoch
      ),
    [captures, memberId, meshSessionId, observationEpoch, projectId, sessionId]
  );
  const captureKey = capture ? `${capture.meshSessionId}:${capture.observationEpoch}` : '';
  const liveExtraFrames = liveExtra.captureKey === captureKey ? liveExtra.frames : [];

  useEffect(() => setProjectId((current) => selectAvailable(current, projects, 'projectId')), [projects]);
  useEffect(() => setSessionId((current) => selectAvailable(current, sessions, 'sessionId')), [sessions]);
  useEffect(() => setMemberId((current) => selectOption(current, memberOptions)), [memberOptions]);
  useEffect(() => setMeshSessionId((current) => selectOption(current, nativeSessions)), [nativeSessions]);
  useEffect(() => setObservationEpoch((current) => selectAvailable(current, epochs, 'observationEpoch')), [epochs]);
  const routeSelectionIsAvailable =
    projects.some((item) => item.projectId === projectId) &&
    sessions.some((item) => item.sessionId === sessionId) &&
    memberOptions.some((item) => item.id === memberId);
  useEffect(() => {
    if (!routeSelectionIsAvailable) return;
    void navigate({
      params: { projectId, sessionId, memberId, source },
      replace: true,
      to: '/developer/live-event-replay/$projectId/$sessionId/$memberId/$source'
    });
  }, [memberId, navigate, projectId, routeSelectionIsAvailable, sessionId, source]);

  const liveQuery = useGetLiveEventReplayFramesQuery(
    capture
      ? {
          meshSessionId: capture.meshSessionId,
          observationEpoch: capture.observationEpoch,
          query: { offset: 0, limit: LIVE_PAGE_LIMIT }
        }
      : skipToken
  );
  const liveFrames = useMemo(
    () =>
      capture && liveQuery.data
        ? [...liveReplayFrames(liveQuery.data.frames, capture.observationEpoch), ...liveExtraFrames]
        : [],
    [capture, liveExtraFrames, liveQuery.data]
  );

  async function loadMoreLive(): Promise<void> {
    if (!capture || !liveQuery.data) return;
    const offset = liveQuery.data.frames.length + liveExtraFrames.length;
    const page = await getMoreLive({
      meshSessionId: capture.meshSessionId,
      observationEpoch: capture.observationEpoch,
      query: { offset, limit: LIVE_PAGE_LIMIT }
    }).unwrap();
    setLiveExtra((current) => ({
      captureKey,
      frames: [
        ...(current.captureKey === captureKey ? current.frames : []),
        ...liveReplayFrames(page.frames, capture.observationEpoch)
      ]
    }));
  }

  const loadHistory = useCallback(
    async (before?: ObservationCursor): Promise<void> => {
      if (!meshSessionId || !sessionId) return;
      setHistoryUnavailable(false);
      try {
        const page = await getHistory({
          id: meshSessionId,
          transcriptTargetId: sessionId as SessionId,
          request: { limit: 100, ...(before ? { before } : {}) }
        }).unwrap();
        const next = historyReplayFrames(page as MeshRawEventPage);
        setHistoryFrames((current) => (before ? mergeFrames(next, current) : next));
        const nextCursor = observationCursorSchema.safeParse(page.nextCursor);
        setHistoryCursor(nextCursor.success ? nextCursor.data : undefined);
        if (!before && next.length === 0) setHistoryUnavailable(true);
      } catch {
        setHistoryFrames([]);
        setHistoryCursor(undefined);
        setHistoryUnavailable(true);
      }
    },
    [getHistory, meshSessionId, sessionId]
  );

  useEffect(() => {
    setStep(0);
    setHistoryFrames([]);
    setHistoryCursor(undefined);
    setHistoryUnavailable(false);
    if (source === 'history' && meshSessionId) void loadHistory();
  }, [loadHistory, meshSessionId, source]);

  const frames = source === 'live' ? liveFrames : historyFrames;
  useEffect(() => setStep(frames.length), [frames.length]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      event.preventDefault();
      setStep((value) => (key === 'j' ? Math.min(frames.length, value + 1) : Math.max(0, value - 1)));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frames.length]);
  const applied = frames.slice(0, step);
  const projection = useMemo(
    () =>
      replayProjection({
        frames: applied,
        meshSessionId,
        provider: nativeSessions.find((item) => item.id === meshSessionId)?.provider ?? capture?.provider ?? '',
        source
      }),
    [applied, capture?.provider, meshSessionId, nativeSessions, source]
  );
  const selectedFrame = step > 0 ? frames[step - 1] : undefined;
  const selectedEvent = projection.events.at(-1);
  useEffect(() => {
    if (step === 0) return;
    finalRenderEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    selectedNormalizedEventRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    selectedRawFrameRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [step]);

  if (developer.isLoading) return <ReplayNotice>{t('web.developerReplay.loading')}</ReplayNotice>;
  if (developer.data?.developerMode !== true) {
    return (
      <ReplayNotice>
        <p>{t('web.developerReplay.disabled')}</p>
        <Link
          className="text-primary underline"
          params={{ section: 'system' }}
          to="/settings/$section"
        >
          {t('web.developerReplay.openSettings')}
        </Link>
      </ReplayNotice>
    );
  }

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b p-3">
        <ReplaySelect
          label={t('web.developerReplay.project')}
          onChange={setProjectId}
          value={projectId}
        >
          {projects.map((item) => (
            <option
              key={item.projectId}
              value={item.projectId}
            >
              {item.projectName ?? item.projectId}
            </option>
          ))}
        </ReplaySelect>
        <ReplaySelect
          label={t('web.developerReplay.session')}
          onChange={setSessionId}
          value={sessionId}
        >
          {sessions.map((item) => (
            <option
              key={item.sessionId}
              value={item.sessionId}
            >
              {item.sessionTitle ?? item.sessionId}
            </option>
          ))}
        </ReplaySelect>
        <ReplaySelect
          label={t('web.developerReplay.member')}
          onChange={setMemberId}
          value={memberId}
        >
          {memberOptions.map((item) => (
            <option
              key={item.id}
              value={item.id}
            >
              {item.name}
            </option>
          ))}
        </ReplaySelect>
        <ReplaySelect
          label={t('web.developerReplay.nativeSession')}
          onChange={setMeshSessionId}
          value={meshSessionId}
        >
          {nativeSessions.map((item) => (
            <option
              key={item.id}
              value={item.id}
            >
              {item.provider} · {item.id}
            </option>
          ))}
        </ReplaySelect>
        {epochs.length > 1 ? (
          <ReplaySelect
            label={t('web.developerReplay.epoch')}
            onChange={setObservationEpoch}
            value={observationEpoch}
          >
            {epochs.map((item) => (
              <option
                key={item.observationEpoch}
                value={item.observationEpoch}
              >
                {item.observationEpoch}
              </option>
            ))}
          </ReplaySelect>
        ) : null}
        <div className="ml-auto flex rounded-md border p-0.5">
          {(['live', 'history'] as const).map((value) => (
            <Button
              key={value}
              onClick={() => {
                setSource(value);
                setStep(value === 'live' ? liveFrames.length : 0);
              }}
              size="sm"
              variant={source === value ? 'secondary' : 'ghost'}
            >
              {t(value === 'live' ? 'web.developerReplay.live' : 'web.developerReplay.history')}
            </Button>
          ))}
        </div>
      </header>

      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <Button
          onClick={() => setStep(0)}
          size="sm"
          variant="outline"
        >
          {t('web.developerReplay.start')}
        </Button>
        <Button
          onClick={() => setStep((value) => Math.max(0, value - 1))}
          size="sm"
          variant="outline"
        >
          {t('web.developerReplay.previous')} · K
        </Button>
        <Button
          onClick={() => setStep((value) => Math.min(frames.length, value + 1))}
          size="sm"
          variant="outline"
        >
          {t('web.developerReplay.next')} · J
        </Button>
        <Button
          onClick={() => setStep(frames.length)}
          size="sm"
          variant="outline"
        >
          {t('web.developerReplay.latest')}
        </Button>
        <input
          className="min-w-24 flex-1"
          max={frames.length}
          min={0}
          onChange={(event) => setStep(Number(event.target.value))}
          type="range"
          value={step}
        />
        <span>
          {step} / {frames.length}
        </span>
        {source === 'history' && historyCursor ? (
          <Button
            disabled={historyRequest.isFetching}
            onClick={() => void loadHistory(historyCursor)}
            size="sm"
            variant="outline"
          >
            {t('web.developerReplay.older')}
          </Button>
        ) : null}
        {source === 'live' && liveQuery.data && liveFrames.length < liveQuery.data.total ? (
          <Button
            disabled={moreLiveRequest.isFetching}
            onClick={() => void loadMoreLive()}
            size="sm"
            variant="outline"
          >
            {t('web.developerReplay.more')}
          </Button>
        ) : null}
      </div>

      {capturesQuery.isLoading ? <ReplayNotice>{t('web.developerReplay.loading')}</ReplayNotice> : null}
      {!capturesQuery.isLoading && captures.length === 0 ? (
        <ReplayNotice>{t('web.developerReplay.empty')}</ReplayNotice>
      ) : null}
      {historyUnavailable ? (
        <div className="border-b px-4 py-2 text-muted-foreground text-sm">
          {t('web.developerReplay.historyUnavailable')}
        </div>
      ) : null}
      {meshSessionId ? (
        <div className="grid min-h-0 flex-1 grid-cols-3 divide-x">
          <ReplayColumn title={t('web.developerReplay.finalRender')}>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <LiveEventReplayPanel
                agentName={`${memberOptions.find((item) => item.id === memberId)?.name ?? memberId} replay`}
                cards={projection.cards}
                meshSessionId={meshSessionId}
                provider={nativeSessions.find((item) => item.id === meshSessionId)?.provider ?? capture?.provider ?? ''}
                source={source}
              />
              <div ref={finalRenderEndRef} />
            </div>
          </ReplayColumn>
          <ReplayColumn title={t('web.developerReplay.normalized')}>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 divide-y overflow-auto font-ui text-xs">
                {projection.events.map((event, index) => (
                  <div
                    className="flex h-9 min-w-0 items-center gap-2 px-3"
                    key={event.id}
                    ref={index === projection.events.length - 1 ? selectedNormalizedEventRef : undefined}
                  >
                    <strong className="shrink-0">
                      {index + 1}. {event.kind}
                      {event.tool?.name ? ` · ${event.tool.name}` : ''}
                    </strong>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {event.text ?? JSON.stringify(event, null, 2)}
                    </span>
                  </div>
                ))}
              </div>
              {selectedEvent ? <ReplayDetail value={JSON.stringify(selectedEvent, null, 2)} /> : null}
            </div>
          </ReplayColumn>
          <ReplayColumn title={t('web.developerReplay.rawFrame')}>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 divide-y overflow-auto font-ui text-xs">
                {frames.map((frame, index) => (
                  <button
                    className={`flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left ${index < step ? 'opacity-100' : 'opacity-40'} ${index === step - 1 ? 'bg-accent' : ''}`}
                    key={frame.identity}
                    onClick={() => setStep(index + 1)}
                    ref={index === step - 1 ? selectedRawFrameRef : undefined}
                    type="button"
                  >
                    <strong className="shrink-0">
                      {String(frame.seq)} · {frame.stream ?? 'history'}
                    </strong>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {formattedReplayPayload(frame.payload).replace(/\s+/g, ' ').slice(0, 160)}
                    </span>
                  </button>
                ))}
              </div>
              {selectedFrame ? <ReplayDetail value={formattedReplayPayload(selectedFrame.payload)} /> : null}
            </div>
          </ReplayColumn>
        </div>
      ) : null}
    </main>
  );
}

function uniqueCaptures<K extends keyof LiveEventReplayCapture>(captures: LiveEventReplayCapture[], key: K) {
  return [...new Map(captures.map((capture) => [capture[key], capture])).values()];
}

function selectAvailable<K extends keyof LiveEventReplayCapture>(
  current: string,
  items: LiveEventReplayCapture[],
  key: K
) {
  return selectReplayOption(
    current,
    items.map((item) => String(item[key]))
  );
}

function selectOption(current: string, items: Array<{ id: string }>): string {
  return selectReplayOption(
    current,
    items.map((item) => item.id)
  );
}

function mergeFrames(older: ReplayRawFrame[], current: ReplayRawFrame[]): ReplayRawFrame[] {
  const seen = new Set<string>();
  return [...older, ...current].filter((frame) => !seen.has(frame.identity) && seen.add(frame.identity));
}

function ReplaySelect(props: {
  children: React.ReactNode;
  label: string;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-muted-foreground text-xs">
      <span>{props.label}</span>
      <select
        className="h-8 max-w-52 rounded-md border bg-background px-2 text-foreground"
        onChange={(event) => props.onChange(event.target.value)}
        value={props.value}
      >
        {props.children}
      </select>
    </label>
  );
}

function ReplayColumn({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <h2 className="border-b px-3 py-2 font-medium text-sm">{title}</h2>
      {children}
    </section>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function ReplayDetail({ value }: { value: string }) {
  return (
    <div className="h-80 max-h-[42%] shrink-0 overflow-auto border-t bg-background p-3">
      <CodeBlock
        className="rounded-none border-0 text-xs"
        code={value.slice(0, 24_000)}
        language="json"
      />
    </div>
  );
}

function ReplayNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-muted-foreground text-sm">
      {children}
    </div>
  );
}
