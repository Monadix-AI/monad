import type { CheckSkillUpdatesResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { removeSkillApi } from './remove-skill.ts';

// A query, but it hits github per skill — drive it lazily from a "check for updates" button rather
// than auto-running on mount. Not tagged, so it never refetches implicitly.
const checkSkillUpdatesApi = removeSkillApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    checkSkillUpdates: builder.query<CheckSkillUpdatesResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.atoms.skills.updates.get())
    })
  })
});

export const { useCheckSkillUpdatesQuery, useLazyCheckSkillUpdatesQuery } = checkSkillUpdatesApi;
