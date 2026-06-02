import type { OkResponse, SetAtomPinRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setAtomPackEnabledApi } from './set-atom-pack-enabled.ts';

const setAtomPinApi = setAtomPackEnabledApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setAtomPin: builder.mutation<OkResponse, SetAtomPinRequest>({
      queryFn: (body: SetAtomPinRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms.pin.post(body)),
      // The pin changes which pack wins a bare id → re-resolution updates the conflicts list.
      invalidatesTags: ['Atoms', 'SlashCommands']
    })
  })
});

export const { useSetAtomPinMutation } = setAtomPinApi;
