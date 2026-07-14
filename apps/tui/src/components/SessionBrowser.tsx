import type { AgentId, SessionId } from '@monad/protocol';

import {
  agentSelectors,
  sessionSelectors,
  useCreateSessionMutation,
  useDeleteSessionMutation,
  useListAgentsQuery,
  useListSessionsQuery,
  useUpdateSessionMutation
} from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { filterByTitle, safeErrorMessage } from '../shell/view-model.ts';
import { chatAgentLabel, chatCreateRequest, confirmDestructive, plainChatSessions } from '../shell/workspace-model.ts';
import { TUI_THEME } from './theme.ts';

type BrowserMode = 'list' | 'agent' | 'rename';

export function SessionBrowser({ active, onOpen }: { active: boolean; onOpen: (id: SessionId) => void }) {
  const query = useListSessionsQuery({ archived: false, limit: 100 });
  const sessions = query.data ? plainChatSessions(sessionSelectors.selectAll(query.data.sessions)) : [];
  const agentsQuery = useListAgentsQuery();
  const agents = agentsQuery.data ? agentSelectors.selectAll(agentsQuery.data) : [];
  const [createSession] = useCreateSessionMutation();
  const [updateSession] = useUpdateSessionMutation();
  const [deleteSession] = useDeleteSessionMutation();
  const [cursor, setCursor] = useState(0);
  const [agentCursor, setAgentCursor] = useState(0);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<BrowserMode>('list');
  const [draft, setDraft] = useState('');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const visible = filterByTitle(sessions, search);
  const agentOptions: Array<{ id: AgentId | null; name: string }> = [
    { id: null, name: 'Default Agent' },
    ...agents.map((agent) => ({ id: agent.id, name: agent.name }))
  ];
  useEffect(() => setCursor((value) => Math.min(value, Math.max(0, visible.length - 1))), [visible.length]);

  const create = async () => {
    const selectedAgent = agentOptions[agentCursor]?.id ?? null;
    try {
      const id = await createSession(chatCreateRequest(`chat ${new Date().toLocaleString()}`, selectedAgent)).unwrap();
      setMode('list');
      setStatus('Chat created.');
      onOpen(id);
    } catch (cause) {
      setStatus(safeErrorMessage(cause));
    }
  };

  const rename = async () => {
    const session = visible[cursor];
    const title = draft.trim();
    if (!session || !title) return;
    try {
      await updateSession({ id: session.id, title }).unwrap();
      setMode('list');
      setStatus('Chat renamed.');
    } catch (cause) {
      setStatus(safeErrorMessage(cause));
    }
  };

  const remove = async () => {
    const session = visible[cursor];
    if (!session) return;
    const confirmation = confirmDestructive(armedDelete, session.id);
    setArmedDelete(confirmation.armedId);
    if (!confirmation.confirmed) {
      setStatus(`Press x again to delete “${session.title}”.`);
      return;
    }
    try {
      await deleteSession(session.id).unwrap();
      setStatus('Chat deleted.');
    } catch (cause) {
      setStatus(safeErrorMessage(cause));
    }
  };

  useInput(
    (input, key) => {
      if (mode === 'agent') {
        if (key.escape) setMode('list');
        else if (key.upArrow || input === 'k') setAgentCursor((value) => Math.max(0, value - 1));
        else if (key.downArrow || input === 'j')
          setAgentCursor((value) => Math.min(agentOptions.length - 1, value + 1));
        else if (key.return) void create();
        return;
      }
      if (mode === 'rename') {
        if (key.escape) setMode('list');
        else if (key.return) void rename();
        else if (key.backspace) setDraft((value) => value.slice(0, -1));
        else if (!key.ctrl && !key.meta && input) setDraft((value) => value + input);
        return;
      }
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setSearch('');
        } else if (key.return) setSearching(false);
        else if (key.backspace) setSearch((value) => value.slice(0, -1));
        else if (!key.ctrl && !key.meta && input) setSearch((value) => value + input);
        return;
      }
      if (key.upArrow || input === 'k') {
        setArmedDelete(null);
        setCursor((value) => Math.max(0, value - 1));
      } else if (key.downArrow || input === 'j') {
        setArmedDelete(null);
        setCursor((value) => Math.min(Math.max(0, visible.length - 1), value + 1));
      } else if (input === 'g') setCursor(0);
      else if (input === 'G') setCursor(Math.max(0, visible.length - 1));
      else if (input === '/') setSearching(true);
      else if (key.return) {
        const session = visible[cursor];
        if (session) onOpen(session.id);
      } else if (input === 'n') {
        setAgentCursor(0);
        setMode('agent');
        setStatus('');
      } else if (input === 'e') {
        const session = visible[cursor];
        if (session) {
          setDraft(session.title);
          setMode('rename');
        }
      } else if (input === 'x') void remove();
      else if (input === 'r') {
        query.refetch();
        agentsQuery.refetch();
      }
    },
    { isActive: active }
  );

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        Chats
      </Text>
      {mode === 'agent' ? (
        <>
          <Text color={TUI_THEME.dim}>Choose the Agent for this Chat:</Text>
          {agentOptions.map((agent, index) => (
            <Text
              color={agentCursor === index ? TUI_THEME.accent : undefined}
              key={agent.id ?? 'default'}
            >
              {agentCursor === index ? '› ' : '  '}
              {agent.name}
            </Text>
          ))}
          <Text color={TUI_THEME.dim}>↑↓/j/k choose · Enter create · Esc cancel</Text>
        </>
      ) : mode === 'rename' ? (
        <>
          <Text>Rename Chat</Text>
          <Text color={TUI_THEME.accent}>{draft}█</Text>
          <Text color={TUI_THEME.dim}>Enter save · Esc cancel</Text>
        </>
      ) : (
        <>
          {searching || search ? (
            <Text color={TUI_THEME.accent}>
              / {search}
              {searching ? '█' : ''}
            </Text>
          ) : null}
          {query.isLoading ? <Text color={TUI_THEME.dim}>Loading sessions…</Text> : null}
          {query.error ? <Text color={TUI_THEME.danger}>Unable to load sessions. Press r to retry.</Text> : null}
          {sessions.length === 0 && !query.isLoading ? (
            <Text color={TUI_THEME.dim}>No chats. Press n to create one.</Text>
          ) : null}
          {visible.map((session, index) => (
            <Text
              color={active && cursor === index ? TUI_THEME.accent : undefined}
              key={session.id}
            >
              {active && cursor === index ? '› ' : '  '}
              {session.title}{' '}
              <Text color={TUI_THEME.dim}>
                {chatAgentLabel(session.agentIds, agents)} · {session.state}
              </Text>
            </Text>
          ))}
          <Text color={TUI_THEME.dim}>↑↓/j/k move · Enter open · n new · e rename · x delete · / search</Text>
        </>
      )}
      {status ? <Text color={armedDelete ? TUI_THEME.warning : TUI_THEME.dim}>{status}</Text> : null}
    </Box>
  );
}
