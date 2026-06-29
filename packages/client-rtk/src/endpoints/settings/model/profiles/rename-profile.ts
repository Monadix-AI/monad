import type { OkResponse, ProfileView } from '@monad/protocol';

import { clientOf, toError } from '../../../../endpoint-helpers.ts';
import { deleteProfileApi } from './delete-profile.ts';
import { listProfilesApi, profileAdapter } from './list-profiles.ts';

interface RenameProfileArg {
  alias: string;
  nextAlias: string;
}

const renameProfileApi = deleteProfileApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    renameProfile: builder.mutation<OkResponse, RenameProfileArg>({
      queryFn: async ({ alias, nextAlias }, api: { extra: unknown }) => {
        try {
          const res = await clientOf(api).fetch(`/v1/settings/model/profiles/${encodeURIComponent(alias)}/alias`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: nextAlias })
          });
          if (!res.ok)
            return { error: toError({ status: res.status, value: await res.json().catch(() => undefined) }) };
          return { data: (await res.json()) as OkResponse };
        } catch (error) {
          return { error: toError(error) };
        }
      },
      async onQueryStarted({ alias, nextAlias }, { dispatch, queryFulfilled }) {
        const trimmed = nextAlias.trim();
        const patch = dispatch(
          listProfilesApi.util.updateQueryData('listProfiles', undefined, (draft) => {
            const profile = draft.profiles.entities[alias] as ProfileView | undefined;
            if (!profile) return;
            profileAdapter.removeOne(draft.profiles, alias);
            profileAdapter.upsertOne(draft.profiles, { ...profile, alias: trimmed });
            if (draft.defaultAlias === alias) draft.defaultAlias = trimmed;
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Profiles', 'Default', 'Agents', 'InitStatus']
    })
  })
});

export const { useRenameProfileMutation } = renameProfileApi;
