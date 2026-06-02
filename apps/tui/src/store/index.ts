import type { MonadClient } from '@monad/client';

import { monadApi } from '@monad/client-rtk';
import { configureStore } from '@reduxjs/toolkit';

import { serverSlice } from './server.ts';

export function createAppStore(client: MonadClient) {
  return configureStore({
    reducer: {
      [monadApi.reducerPath]: monadApi.reducer,
      server: serverSlice.reducer
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ thunk: { extraArgument: { client } } }).concat(monadApi.middleware)
  });
}

type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

export * from './server.ts';
