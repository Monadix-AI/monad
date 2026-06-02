import type { ProviderView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { sessionsApi } from '../../../sessions/index.ts';

export const providerAdapter = createEntityAdapter<ProviderView>();
export const providerSelectors = providerAdapter.getSelectors();

export const listProvidersApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listProviders: builder.query<EntityState<ProviderView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers.get(),
          (raw) => providerAdapter.setAll(providerAdapter.getInitialState(), raw.providers)
        ),
      providesTags: ['Providers']
    })
  })
});

export const { useListProvidersQuery } = listProvidersApi;
