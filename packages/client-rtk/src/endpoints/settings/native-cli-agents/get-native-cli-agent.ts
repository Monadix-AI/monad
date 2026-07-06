import type { GetNativeCliAgentResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listNativeCliAgentsApi } from './list-native-cli-agents.ts';

const getNativeCliAgentApi = listNativeCliAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliAgent: builder.query<GetNativeCliAgentResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['native-cli-agents']({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'NativeCliAgents', id: name }]
    })
  })
});

export const { useGetNativeCliAgentQuery } = getNativeCliAgentApi;
