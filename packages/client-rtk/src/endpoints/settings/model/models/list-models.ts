import type { ModelInfo } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { setDefaultApi } from '../default/set-default.ts';

export const modelAdapter = createEntityAdapter<ModelInfo>();
export const modelSelectors = modelAdapter.getSelectors();

export const listModelsApi = setDefaultApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listModels: builder.query<EntityState<ModelInfo, string>, string>({
      queryFn: (providerId: string, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers({ id: providerId }).models.get(),
          (raw) => modelAdapter.setAll(modelAdapter.getInitialState(), raw.models)
        ),
      providesTags: (_r: unknown, _e: unknown, id: string) => [{ type: 'Models', id }],
      // listModels hits each provider's API; the Roles tab mounts one query per connected provider.
      // Keep results cached well past the default 60s so reopening settings (or switching tabs)
      // doesn't refetch every provider — the list is stable between explicit refreshes.
      keepUnusedDataFor: 600
    })
  })
});

export const { useLazyListModelsQuery, useListModelsQuery } = listModelsApi;
