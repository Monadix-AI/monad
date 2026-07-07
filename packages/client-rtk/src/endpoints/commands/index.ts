import type { CommandsListQueryInput, CommandsListResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const commandsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listCommands: builder.query<CommandsListResponse, CommandsListQueryInput | undefined>({
      queryFn: (arg, api: { extra: unknown }) => {
        const query = arg?.filter ? { filter: arg.filter } : undefined;
        return runTreaty(() => clientOf(api).treaty.v1.commands.get({ query: query ?? {} }));
      },
      // The unified list folds in atom-pack commands and user-invocable skills.
      providesTags: ['SlashCommands']
    })
  })
});

export const { useLazyListCommandsQuery, useListCommandsQuery } = commandsApi;
