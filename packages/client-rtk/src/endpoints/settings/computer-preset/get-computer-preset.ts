import type { ComputerPresetResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getComputerPresetApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getComputerPreset: builder.query<ComputerPresetResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['computer-preset'].get()),
      providesTags: ['ComputerPreset']
    })
  })
});

export const { useGetComputerPresetQuery } = getComputerPresetApi;
