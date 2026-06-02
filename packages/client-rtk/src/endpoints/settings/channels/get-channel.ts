import type { GetChannelResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listChannelsApi } from './list-channels.ts';

const getChannelApi = listChannelsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getChannel: builder.query<GetChannelResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).get()),
      providesTags: (_res, _err, id) => [{ type: 'Channels', id }]
    })
  })
});

export const { useGetChannelQuery } = getChannelApi;
