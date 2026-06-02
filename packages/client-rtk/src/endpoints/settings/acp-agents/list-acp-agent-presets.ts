import type { AcpAgentPresetView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

// Turnkey invite presets (Codex / Claude Code) with same-machine detection. Read-only; a plain array
// (no entity adapter) since the UI just lists them and prefills an upsert from the chosen preset.
const listAcpAgentPresetsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAcpAgentPresets: builder.query<AcpAgentPresetView[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['acp-agents'].presets.get(),
          (raw) => raw.presets
        ),
      providesTags: ['AcpAgents']
    })
  })
});

export const { useListAcpAgentPresetsQuery } = listAcpAgentPresetsApi;
