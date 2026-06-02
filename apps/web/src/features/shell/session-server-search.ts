import type { ListSessionsQuery, Session } from '@monad/protocol';

import { sessionAdapter, sessionSelectors, skipToken, useListSessionsQuery } from '@monad/client-rtk';
import { useEffect, useMemo, useState } from 'react';

const SESSION_SEARCH_DEBOUNCE_MS = 200;

export function serverSessionSearchArgs(query: string, archived: boolean, limit: number): ListSessionsQuery | null {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return null;
  return { archived, limit, offset: 0, query: normalizedQuery };
}

export function scheduleDebouncedValue<T>(value: T, delay: number, commit: (value: T) => void): () => void {
  const timer = setTimeout(() => commit(value), delay);
  return () => clearTimeout(timer);
}

export function useServerSessionSearch({
  archived,
  limit,
  query
}: {
  archived: boolean;
  limit: number;
  query: string;
}): { error: boolean; searching: boolean; sessions: Session[] } {
  const normalizedQuery = query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    if (!normalizedQuery) {
      setDebouncedQuery('');
      return;
    }
    return scheduleDebouncedValue(normalizedQuery, SESSION_SEARCH_DEBOUNCE_MS, setDebouncedQuery);
  }, [normalizedQuery]);

  const args = serverSessionSearchArgs(debouncedQuery, archived, limit);
  const { currentData, isError, isFetching } = useListSessionsQuery(args ?? skipToken);
  const sessions = useMemo(
    () => sessionSelectors.selectAll(currentData?.sessions ?? sessionAdapter.getInitialState()),
    [currentData]
  );
  const querySettled = Boolean(normalizedQuery) && normalizedQuery === debouncedQuery;

  return {
    error: querySettled && isError,
    searching: Boolean(normalizedQuery) && (!querySettled || isFetching),
    sessions: querySettled ? sessions : []
  };
}
