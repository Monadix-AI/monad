import type { OkResponse, SetRolesRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { getRolesApi } from './get-roles.ts';

export const setRolesApi = getRolesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setRoles: builder.mutation<OkResponse, SetRolesRequest>({
      queryFn: (args: SetRolesRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.roles.put(args)),
      async onQueryStarted({ roles }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          getRolesApi.util.updateQueryData('getRoles', undefined, (draft) => {
            Object.assign(draft, roles);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Roles', 'InitStatus']
    })
  })
});

export const { useSetRolesMutation } = setRolesApi;
