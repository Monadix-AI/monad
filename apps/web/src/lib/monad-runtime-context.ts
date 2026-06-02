import type { MonadClient } from '@monad/client';
import type { Context } from 'react';

import { createContext, useContext } from 'react';

export type DaemonSwitchRequest = { type: 'local' } | { type: 'remote'; connection: { url: string } };

export interface MonadRuntimeContextValue {
  baseUrl: string;
  client: MonadClient;
  switchDaemonConnection: (request: DaemonSwitchRequest) => void;
}

type MonadRuntimeContextGlobal = typeof globalThis & {
  __monadRuntimeContext?: Context<MonadRuntimeContextValue | null>;
};

const contextGlobal = globalThis as MonadRuntimeContextGlobal;

if (!contextGlobal.__monadRuntimeContext) {
  contextGlobal.__monadRuntimeContext = createContext<MonadRuntimeContextValue | null>(null);
}

export const MonadRuntimeContext = contextGlobal.__monadRuntimeContext;

export function useMonadRuntime(): MonadRuntimeContextValue {
  const context = useContext(MonadRuntimeContext);
  if (!context) throw new Error('useMonadRuntime must be used inside MonadStoreProvider');
  return context;
}
