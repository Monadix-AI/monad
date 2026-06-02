import type { NativeCliAgentView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const nativeCliAgentAdapter = createEntityAdapter<NativeCliAgentView, string>({ selectId: (a) => a.name });
export const nativeCliAgentSelectors = nativeCliAgentAdapter.getSelectors();

export const listNativeCliAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliAgents: builder.query<EntityState<NativeCliAgentView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['native-cli-agents'].get(),
          (raw) => nativeCliAgentAdapter.setAll(nativeCliAgentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['NativeCliAgents']
    })
  })
});

export const { useListNativeCliAgentsQuery } = listNativeCliAgentsApi;
