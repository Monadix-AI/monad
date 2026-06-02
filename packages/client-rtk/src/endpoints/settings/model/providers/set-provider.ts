import type { ProviderView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProvidersApi, providerAdapter } from './list-providers.ts';

export const setProviderApi = listProvidersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setProvider: builder.mutation<null, ProviderView>({
      queryFn: (provider: ProviderView, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers({ id: provider.id }).put({ provider }),
          () => null
        ),
      async onQueryStarted(provider, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listProvidersApi.util.updateQueryData('listProviders', undefined, (draft) => {
            providerAdapter.upsertOne(draft, provider);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Providers']
    })
  })
});

export const { useSetProviderMutation } = setProviderApi;
