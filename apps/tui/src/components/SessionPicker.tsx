import type { Session, SessionId } from '@monad/protocol';
import type { AppDispatch, RootState } from '../store/index.ts';

import { monadApi, sessionAdapter, sessionSelectors } from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { t } from '../lib/i18n.ts';
import { setSessions, switchSession, upsertSession } from '../store/server.ts';
import { useUIStore } from '../store/ui.ts';

function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) return maybeMessage;
    try {
      return JSON.stringify(err);
    } catch {
      return t('cli.tui.requestFailed');
    }
  }
  return String(err);
}

export function SessionPicker() {
  const dispatch = useDispatch<AppDispatch>();
  const setOverlay = useUIStore((s) => s.setOverlay);
  const currentSessionId = useSelector((s: RootState) => s.server.currentSessionId);
  const sessions = useSelector((s: RootState) => s.server.sessions);

  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const req = dispatch(monadApi.endpoints.listSessions.initiate(undefined));
    try {
      const result = await req.unwrap();
      dispatch(setSessions(sessionSelectors.selectAll(result.sessions ?? sessionAdapter.getInitialState())));
    } catch (err) {
      setError(errorToMessage(err));
    } finally {
      req.unsubscribe();
      setLoading(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSession = useCallback(
    (id: SessionId) => {
      dispatch(switchSession(id));
      setOverlay('none');
    },
    [dispatch, setOverlay]
  );

  const createSession = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const title = t('cli.tui.sessionTitle', { n: sessions.length + 1 });
      const id = await dispatch(monadApi.endpoints.createSession.initiate({ title })).unwrap();
      const session: Session = {
        id,
        title,
        ownerPrincipalId: 'prn_unknown00000' as Session['ownerPrincipalId'],
        state: 'active',
        agentIds: [],
        parentSessionId: null,
        archived: false,
        restoreCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      dispatch(upsertSession(session));
      openSession(id);
    } catch (err) {
      setError(errorToMessage(err));
    } finally {
      setCreating(false);
    }
  }, [sessions.length, dispatch, openSession]);

  useInput((input, key) => {
    if (key.upArrow || input === 'k' || input === 'K') {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === 'j' || input === 'J') {
      setCursor((c) => Math.min(sessions.length, c + 1)); // sessions + "new" row
    } else if (key.return) {
      if (cursor === sessions.length) {
        void createSession();
      } else {
        const s = sessions[cursor];
        if (s) openSession(s.id);
      }
    } else if (input === 'n' || input === 'N') {
      void createSession();
    } else if (input === 'r' || input === 'R') {
      void load();
    } else if (key.escape && currentSessionId) {
      setOverlay('none');
    }
  });

  const rows = [...sessions, null]; // null = "new session" row

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>{t('cli.tui.sessionsTitle')}</Text>
      {error && <Text color="red">{error}</Text>}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        {loading ? (
          <Text dimColor>{t('cli.tui.loading')}</Text>
        ) : (
          rows.map((s, i) => {
            const isSelected = i === cursor;
            const isNew = s === null;
            const isCurrent = s !== null && s.id === currentSessionId;
            return (
              <Box key={s?.id ?? '__new'}>
                <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                {isNew ? (
                  <Text color={isSelected ? 'cyan' : 'green'}>
                    {creating ? t('cli.tui.creating') : t('cli.tui.newSession')}
                  </Text>
                ) : (
                  <>
                    <Text color={isSelected ? 'cyan' : undefined}>{s?.title}</Text>
                    <Text dimColor>
                      {'  '}
                      {s?.id}
                    </Text>
                    {isCurrent && <Text color="green">{'  '}●</Text>}
                  </>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
