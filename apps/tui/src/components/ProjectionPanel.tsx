import type { AgentObservationEvent, ExternalAgentObservationEvent, SessionId } from '@monad/protocol';

import {
  externalAgentSessionSelectors,
  useLazyGetExternalAgentHistoryPageQuery,
  useListExternalAgentSessionsQuery,
  useStreamExternalAgentUiObservationQuery
} from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../lib/i18n.ts';
import { mergeById } from '../shell/view-model.ts';
import { TUI_THEME } from './theme.ts';

type ProjectionEvent = AgentObservationEvent | ExternalAgentObservationEvent;

export function ProjectionPanel({ active, sessionId }: { active: boolean; sessionId: SessionId }) {
  const sessionsQuery = useListExternalAgentSessionsQuery(sessionId);
  const sessions = sessionsQuery.data ? externalAgentSessionSelectors.selectAll(sessionsQuery.data) : [];
  const observed =
    sessions.find((session) => session.state === 'running' || session.state === 'starting') ?? sessions[0];
  const observation = useStreamExternalAgentUiObservationQuery(
    { id: observed?.id ?? '', transcriptTargetId: sessionId },
    { skip: !observed }
  );
  const streamState = observation.data;
  const frame = streamState?.frame;
  const [loadHistory, historyQuery] = useLazyGetExternalAgentHistoryPageQuery();
  const [history, setHistory] = useState<ExternalAgentObservationEvent[]>([]);
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const historySession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (historySession.current === observed?.id) return;
    historySession.current = observed?.id;
    setHistory([]);
    setBefore(undefined);
    setHistoryUnavailable(false);
  }, [observed?.id]);
  const events = useMemo(
    () => mergeById<ProjectionEvent>(history, frame && frame.state !== 'unavailable' ? frame.events : []),
    [frame, history]
  );

  const loadOlder = async () => {
    if (!observed || historyQuery.isFetching || before === null || historyUnavailable) return;
    try {
      const page = await loadHistory({
        ...(before ? { before } : {}),
        id: observed.id,
        itemsView: 'full',
        limit: 20,
        sortDirection: 'desc',
        transcriptTargetId: sessionId
      }).unwrap();
      setHistory((current) => mergeById(page.events, current));
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
          {observed.agentName} · {observed.provider} · {observed.state}
        </Text>
      ) : null}
      {streamState?.fatalError ? (
        <Text color={TUI_THEME.warning}>{t('cli.tui.projection.historyUnavailable')}</Text>
      ) : frame?.state === 'unavailable' ? (
        <Text color={TUI_THEME.warning}>{frame.reason}</Text>
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

function renderEvent(event: ProjectionEvent): string {
  if (!('kind' in event)) return `· [${event.role}] ${event.text}`;
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
