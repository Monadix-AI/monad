import type { SetSkillsSettingsRequest, SkillsSettingsResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getSkillsSettingsApi } from './get-skills-settings.ts';

type SkillsSettingsTreaty = {
  skills: {
    put: (
      body: SetSkillsSettingsRequest
    ) => Promise<{ data: SkillsSettingsResponse | null | undefined; error: unknown }>;
  };
};

const setSkillsSettingsApi = getSkillsSettingsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setSkillsSettings: builder.mutation<SkillsSettingsResponse, SetSkillsSettingsRequest>({
      queryFn: (body: SetSkillsSettingsRequest, api: { extra: unknown }) => {
        const settings = clientOf(api).treaty.v1.settings as unknown as SkillsSettingsTreaty;
        return runTreaty(() => settings.skills.put(body));
      },
      invalidatesTags: ['Skills'],
      async onQueryStarted(patch, { dispatch, queryFulfilled }) {
        const optimistic = dispatch(
          getSkillsSettingsApi.util.updateQueryData('getSkillsSettings', undefined, (draft) => {
            if (patch.autoload !== undefined) draft.autoload = patch.autoload;
            if (patch.disabled !== undefined) draft.disabled = patch.disabled;
            if (patch.autoloadDisabled !== undefined) draft.autoloadDisabled = patch.autoloadDisabled;
            if (patch.installReview !== undefined) draft.installReview = patch.installReview;
          })
        );
        try {
          const { data } = await queryFulfilled;
          dispatch(getSkillsSettingsApi.util.updateQueryData('getSkillsSettings', undefined, () => data));
        } catch {
          optimistic.undo();
        }
      }
    })
  })
});

export const { useSetSkillsSettingsMutation } = setSkillsSettingsApi;
