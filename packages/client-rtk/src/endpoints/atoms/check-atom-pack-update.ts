import type { AtomPackUpdateCheck } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { discoverAtomKindsApi } from './discover-atom-kinds.ts';

export const checkAtomPackUpdateApi = discoverAtomKindsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    checkAtomPackUpdate: builder.query<AtomPackUpdateCheck, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms({ name }).update.get())
    })
  })
});

export const { useLazyCheckAtomPackUpdateQuery } = checkAtomPackUpdateApi;
