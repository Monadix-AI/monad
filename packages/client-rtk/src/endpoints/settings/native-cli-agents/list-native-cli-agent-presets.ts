import type { NativeCliAgentPresetView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const listNativeCliAgentPresetsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listNativeCliAgentPresets: builder.query<NativeCliAgentPresetView[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['native-cli-agents'].presets.get(),
          (raw) => raw.presets
        ),
      providesTags: ['NativeCliAgents']
    })
  })
});

export const { useListNativeCliAgentPresetsQuery } = listNativeCliAgentPresetsApi;
