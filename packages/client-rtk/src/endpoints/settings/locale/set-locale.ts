import type { SetLocaleRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getLocaleApi } from './get-locale.ts';

export const setLocaleApi = getLocaleApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setLocale: builder.mutation<null, SetLocaleRequest>({
      queryFn: (args: SetLocaleRequest, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.locale.put(args),
          () => null
        ),
      async onQueryStarted({ locale }, { dispatch, queryFulfilled }) {
        const patch = dispatch(getLocaleApi.util.updateQueryData('getLocale', undefined, () => locale));
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      // Re-fetch the active locale AND the message catalog so the UI re-renders in the new language.
      invalidatesTags: ['Locale', 'Catalog']
    })
  })
});

export const { useSetLocaleMutation } = setLocaleApi;
