import type { OkResponse, PatchProviderRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProvidersApi, providerAdapter } from './list-providers.ts';
import { setProviderApi } from './set-provider.ts';

export type PatchProviderArg = { id: string } & PatchProviderRequest;

export const patchProviderApi = setProviderApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    patchProvider: builder.mutation<OkResponse, PatchProviderArg>({
      queryFn: ({ id, ...patch }: PatchProviderArg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.providers({ id }).patch(patch)),
      async onQueryStarted({ id, ...patch }, { dispatch, queryFulfilled }) {
        const patchResult = dispatch(
          listProvidersApi.util.updateQueryData('listProviders', undefined, (draft) => {
            providerAdapter.updateOne(draft, { id, changes: patch });
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patchResult.undo();
        }
      },
      invalidatesTags: (_r: unknown, _e: unknown, { id }: PatchProviderArg) => [{ type: 'Providers', id }]
    })
  })
});

export const { usePatchProviderMutation } = patchProviderApi;
