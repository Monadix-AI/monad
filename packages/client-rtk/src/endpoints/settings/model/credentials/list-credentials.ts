import type { CredentialView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listModelsApi } from '../models/list-models.ts';

export const credentialAdapter = createEntityAdapter<CredentialView>();
export const credentialSelectors = credentialAdapter.getSelectors();

export const listCredentialsApi = listModelsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listCredentials: builder.query<EntityState<CredentialView, string>, string>({
      queryFn: (providerId: string, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers({ id: providerId }).credentials.get(),
          (raw) => credentialAdapter.setAll(credentialAdapter.getInitialState(), raw.credentials)
        ),
      providesTags: (_r: unknown, _e: unknown, id: string) => [{ type: 'Credentials', id }]
    })
  })
});

export const { useListCredentialsQuery } = listCredentialsApi;
