import type { ModelRoles } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { setDefaultApi } from '../default/set-default.ts';

// Non-chat model-role assignments (vision/image/speech/embedding). chat = the default profile.
export const getRolesApi = setDefaultApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getRoles: builder.query<ModelRoles, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.roles.get(),
          (raw) => raw.roles
        ),
      providesTags: ['Roles']
    })
  })
});

export const { useGetRolesQuery } = getRolesApi;
