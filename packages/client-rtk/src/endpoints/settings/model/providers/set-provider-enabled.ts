import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProvidersApi, providerAdapter } from './list-providers.ts';
import { patchProviderApi } from './patch-provider.ts';

type SetProviderEnabledArg = { id: string; enabled: boolean };

const setProviderEnabledApi = patchProviderApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setProviderEnabled: builder.mutation<OkResponse, SetProviderEnabledArg>({
      queryFn: ({ id, enabled }: SetProviderEnabledArg, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.settings.model.providers({ id })[enabled ? 'enable' : 'disable'].post()
        ),
      async onQueryStarted({ id, enabled }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listProvidersApi.util.updateQueryData('listProviders', undefined, (draft) => {
            providerAdapter.updateOne(draft, { id, changes: { enabled } });
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_r: unknown, _e: unknown, { id }: SetProviderEnabledArg) => [{ type: 'Providers', id }]
    })
  })
});

export const { useSetProviderEnabledMutation } = setProviderEnabledApi;
