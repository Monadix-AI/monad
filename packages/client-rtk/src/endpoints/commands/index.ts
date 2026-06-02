import type { CommandsListResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const commandsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listCommands: builder.query<CommandsListResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.commands.get()),
      // The unified list folds in user-invocable skills, so invalidate it whenever skills change.
      providesTags: ['Skills']
    })
  })
});

export const { useListCommandsQuery } = commandsApi;
