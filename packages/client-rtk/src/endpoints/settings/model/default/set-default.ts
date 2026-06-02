import type { OkResponse, SetDefaultProfileRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { getDefaultApi } from './get-default.ts';

export const setDefaultApi = getDefaultApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setDefault: builder.mutation<OkResponse, SetDefaultProfileRequest>({
      queryFn: (args: SetDefaultProfileRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.default.put(args)),
      async onQueryStarted({ alias }, { dispatch, queryFulfilled }) {
        const patch = dispatch(getDefaultApi.util.updateQueryData('getDefault', undefined, () => alias));
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Default', 'Profiles', 'InitStatus']
    })
  })
});

export const { useSetDefaultMutation } = setDefaultApi;
