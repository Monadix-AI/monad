import type { MonadClient } from '@monad/client';
import type { ReducersMapObject } from '@reduxjs/toolkit';
import type { MonadExtra } from './endpoint-helpers.ts';

import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query/react';

import { monadApi } from './api.ts';
import { type ApiErrorSink, apiErrorMiddleware } from './global-error.ts';

export interface CreateMonadStoreOptions {
  /** The transport every endpoint delegates to. */
  client: MonadClient;
  /** Extra app-specific reducers to merge alongside monadApi. */
  reducer?: ReducersMapObject;
  /** Optional sink for cross-cutting error handling (global toasts, re-auth on 401, …). */
  onApiError?: ApiErrorSink;
}

export function createMonadStore(opts: CreateMonadStoreOptions) {
  const extra: MonadExtra = { client: opts.client };
  const store = configureStore({
    reducer: { [monadApi.reducerPath]: monadApi.reducer, ...opts.reducer },
    middleware: (getDefaultMiddleware) => {
      const chain = getDefaultMiddleware({ thunk: { extraArgument: extra } }).concat(monadApi.middleware);
      return opts.onApiError ? chain.concat(apiErrorMiddleware(opts.onApiError)) : chain;
    }
  });
  setupListeners(store.dispatch);
  return store;
}

export type MonadStore = ReturnType<typeof createMonadStore>;
