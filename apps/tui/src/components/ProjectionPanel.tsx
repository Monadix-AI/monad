import type { AgentObservationEvent, ObservationCursor, SessionId } from '@monad/protocol';

import {
  meshSessionSelectors,
  useLazyGetMeshAgentConvenienceEventsQuery,
  useListMeshSessionsQuery,
  useStreamMeshAgentConvenienceQuery
} from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../lib/i18n.ts';
import { mergeById } from '../shell/view-model.ts';
import { TUI_THEME } from './theme.ts';

export function ProjectionPanel({ active, sessionId }: { active: boolean; sessionId: SessionId }) {
  const sessionsQuery = useListMeshSessionsQuery(sessionId);
  const sessions = sessionsQuery.data ? meshSessionSelectors.selectAll(sessionsQuery.data) : [];
  const observed = sessions.find((session) => session.lifecycle.state !== 'terminal') ?? sessions[0];
  const observation = useStreamMeshAgentConvenienceQuery(
    { id: observed?.id ?? '', transcriptTargetId: sessionId },
    { skip: !observed }
  );
  const streamState = observation.data;
  const [loadEvents, historyQuery] = useLazyGetMeshAgentConvenienceEventsQuery();
  const [history, setHistory] = useState<AgentObservationEvent[]>([]);
  const [before, setBefore] = useState<ObservationCursor | null | undefined>(undefined);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const historySession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (historySession.current === observed?.id) return;
    historySession.current = observed?.id;
    setHistory([]);
    setBefore(undefined);
    setHistoryUnavailable(false);
  }, [observed?.id]);
  const liveEvents = useMemo(() => {
    const byId = new Map<string, AgentObservationEvent>();
    for (const frame of streamState?.frames ?? []) {
      if (frame.kind !== 'patch') continue;
      for (const operation of frame.operations) {
        if (operation.op === 'remove') byId.delete(operation.eventId);
        else byId.set(operation.event.id, operation.event);
      }
    }
    return [...byId.values()];
  }, [streamState?.frames]);
  const events = useMemo(() => mergeById(history, liveEvents), [history, liveEvents]);
  const unavailable = streamState?.frames.findLast((candidate) => candidate.kind === 'unavailable');

  const loadOlder = async () => {
    if (!observed || historyQuery.isFetching || before === null || historyUnavailable) return;
    try {
      const page = await loadEvents({
        id: observed.id,
        transcriptTargetId: sessionId,
        request: { ...(before ? { before } : {}), limit: 20 }
      }).unwrap();
      const older = page.frames.flatMap((candidate) =>
        candidate.kind === 'patch'
          ? candidate.operations.flatMap((operation) => (operation.op === 'upsert' ? [operation.event] : []))
          : []
      );
      setHistory((current) => mergeById(older, current));
      setBefore(page.nextCursor ?? null);
    } catch {
      setHistoryUnavailable(true);
    }
  };

  useInput(
    (input, key) => {
      if (input === 'h' || key.pageUp) void loadOlder();
    },
    { isActive: active }
  );

  return (
    <Box
      borderColor={active ? TUI_THEME.accent : TUI_THEME.frame}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {t('cli.tui.projection.title')}
      </Text>
      {!observed ? <Text color={TUI_THEME.dim}>{t('cli.tui.projection.empty')}</Text> : null}
      {observed ? (
        <Text color={TUI_THEME.dim}>
          {observed.agentName} · {observed.provider} ·{' '}
          {observed.lifecycle.state === 'terminal' ? observed.lifecycle.termination.kind : observed.lifecycle.state}
        </Text>
      ) : null}
      {streamState?.fatalError ? (
        <Text color={TUI_THEME.warning}>{t('cli.tui.projection.historyUnavailable')}</Text>
      ) : unavailable?.kind === 'unavailable' ? (
        <Text color={TUI_THEME.warning}>{unavailable.reason}</Text>
      ) : null}
      {events.slice(-18).map((event) => (
        <Box key={event.id}>
          <Text color={'kind' in event && event.kind === 'reasoning' ? TUI_THEME.dim : TUI_THEME.accent}>
            {renderEvent(event)}
          </Text>
        </Box>
      ))}
      {historyQuery.isFetching ? <Text color={TUI_THEME.dim}>{t('cli.tui.projection.historyLoading')}</Text> : null}
      {historyUnavailable ? <Text color={TUI_THEME.warning}>{t('cli.tui.projection.historyUnavailable')}</Text> : null}
      {observed ? <Text color={TUI_THEME.dim}>{t('cli.tui.projection.readOnly')}</Text> : null}
    </Box>
  );
}

function renderEvent(event: AgentObservationEvent): string {
  if (event.kind === 'tool-call') return `├ ${event.tool?.name ?? 'tool'} ${stringify(event.tool?.input)}`;
  if (event.kind === 'tool-result') return `└ ${event.tool?.name ?? 'result'} ${stringify(event.tool?.output)}`;
  return `${event.streaming ? '…' : '·'} ${event.text ?? event.reason ?? event.kind}`;
}

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
