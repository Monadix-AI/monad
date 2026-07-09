'use client';

import type { MonadClient } from '@monad/client';
import type { ReactNode } from 'react';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Provider } from 'react-redux';

import {
  activateLocalDaemonConnection,
  activateRemoteDaemonConnection,
  type RemoteDaemonConnection
} from '#/lib/daemon-connections';
import { createMonadRuntime, resolveConnection } from '#/lib/monad-store';

type DaemonSwitchRequest = { type: 'local' } | { type: 'remote'; connection: Pick<RemoteDaemonConnection, 'url'> };

interface MonadRuntimeContextValue {
  baseUrl: string;
  client: MonadClient;
  switchDaemonConnection: (request: DaemonSwitchRequest) => void;
}

const MonadRuntimeContext = createContext<MonadRuntimeContextValue | null>(null);
const SERVER_PRERENDER_CONNECTION = { baseUrl: 'https://127.0.0.1:0' };

function initialRuntime() {
  return createMonadRuntime(typeof window === 'undefined' ? SERVER_PRERENDER_CONNECTION : resolveConnection());
}

export function MonadStoreProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState(initialRuntime);

  const switchDaemonConnection = useCallback((request: DaemonSwitchRequest) => {
    if (request.type === 'local') activateLocalDaemonConnection();
    else activateRemoteDaemonConnection(request.connection);

    setRuntime((previousRuntime) => {
      previousRuntime.client.dispose();
      return createMonadRuntime(resolveConnection());
    });
  }, []);

  useEffect(() => {
    return () => runtime.client.dispose();
  }, [runtime.client]);

  const value = useMemo(
    () => ({
      baseUrl: runtime.baseUrl,
      client: runtime.client,
      switchDaemonConnection
    }),
    [runtime.baseUrl, runtime.client, switchDaemonConnection]
  );

  return (
    <MonadRuntimeContext.Provider value={value}>
      <Provider store={runtime.store}>{children}</Provider>
    </MonadRuntimeContext.Provider>
  );
}

export function useMonadRuntime() {
  const context = useContext(MonadRuntimeContext);
  if (!context) throw new Error('useMonadRuntime must be used inside MonadStoreProvider');
  return context;
}
