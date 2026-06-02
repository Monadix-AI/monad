import type { ComputerPresetResponse, SetComputerPresetRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getComputerPresetApi } from './get-computer-preset.ts';

const setComputerPresetApi = getComputerPresetApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setComputerPreset: builder.mutation<ComputerPresetResponse, SetComputerPresetRequest>({
      queryFn: (body: SetComputerPresetRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['computer-preset'].put(body)),
      invalidatesTags: ['ComputerPreset']
    })
  })
});

export const { useSetComputerPresetMutation } = setComputerPresetApi;
