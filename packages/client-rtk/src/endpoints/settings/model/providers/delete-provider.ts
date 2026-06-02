import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProvidersApi, providerAdapter } from './list-providers.ts';
import { setProviderApi } from './set-provider.ts';

export const deleteProviderApi = setProviderApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteProvider: builder.mutation<OkResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.providers({ id }).delete()),
      async onQueryStarted(id, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listProvidersApi.util.updateQueryData('listProviders', undefined, (draft) => {
            providerAdapter.removeOne(draft, id);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_r: unknown, _e: unknown, id: string) => [
        'Providers',
        { type: 'Credentials', id },
        { type: 'Models', id }
      ]
    })
  })
});

export const { useDeleteProviderMutation } = deleteProviderApi;
