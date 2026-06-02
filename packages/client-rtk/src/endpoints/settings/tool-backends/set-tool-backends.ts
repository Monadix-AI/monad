import type { SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getToolBackendsApi } from './get-tool-backends.ts';

const setToolBackendsApi = getToolBackendsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setToolBackends: builder.mutation<ToolBackendsResponse, SetToolBackendsRequest>({
      queryFn: (body: SetToolBackendsRequest, api: { extra: unknown }) => {
        const putToolBackends = clientOf(api).treaty.v1.settings['tool-backends'].put;
        return runTreaty(() => putToolBackends(body as Parameters<typeof putToolBackends>[0]));
      },
      invalidatesTags: ['ToolBackends']
    })
  })
});

export const { useSetToolBackendsMutation } = setToolBackendsApi;
