import type { OpenaiCompatSettings, SetOpenaiCompatRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getOpenaiCompatApi } from './get-openai-compat.ts';

const setOpenaiCompatApi = getOpenaiCompatApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setOpenaiCompat: builder.mutation<OpenaiCompatSettings, SetOpenaiCompatRequest>({
      queryFn: (body: SetOpenaiCompatRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['openai-compat'].put(body)),
      invalidatesTags: ['OpenaiCompat']
    })
  })
});

export const { useSetOpenaiCompatMutation } = setOpenaiCompatApi;
