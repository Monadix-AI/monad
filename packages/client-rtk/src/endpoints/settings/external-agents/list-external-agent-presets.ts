import { type ExternalAgentPresetView, listExternalAgentPresetsResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

const listExternalAgentPresetsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listExternalAgentPresets: builder.query<ExternalAgentPresetView[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['external-agents'].presets.get(),
          (raw) => listExternalAgentPresetsResponseSchema.parse(raw).presets
        ),
      providesTags: ['ExternalAgents']
    })
  })
});

export const { useListExternalAgentPresetsQuery } = listExternalAgentPresetsApi;
