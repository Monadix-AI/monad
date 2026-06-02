import type { AtomConflict, InstalledAtomPack } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const atomPackAdapter = createEntityAdapter<InstalledAtomPack, string>({ selectId: (p) => p.name });
export const atomPackSelectors = atomPackAdapter.getSelectors();

export interface ListAtomPacksResult {
  atomPacks: EntityState<InstalledAtomPack, string>;
  conflicts: AtomConflict[];
}

export const listAtomPacksApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAtomPacks: builder.query<ListAtomPacksResult, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.atoms.get(),
          (raw) => ({
            atomPacks: atomPackAdapter.setAll(atomPackAdapter.getInitialState(), raw.atomPacks),
            conflicts: raw.conflicts
          })
        ),
      providesTags: ['Atoms']
    })
  })
});

export const { useListAtomPacksQuery } = listAtomPacksApi;
