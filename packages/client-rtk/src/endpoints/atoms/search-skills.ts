import type { SearchSkillsResponse, SkillDetail, SkillMarketplaceSource, SkillSortMode } from '@monad/protocol';

import { searchSkillsResponseSchema, skillDetailSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const searchSkillsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    browseSkills: builder.query<SearchSkillsResponse, { sort: SkillSortMode; source: SkillMarketplaceSource }>({
      queryFn: ({ sort, source }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.skills.browse.get({ query: { sort, source } }),
          searchSkillsResponseSchema.parse
        )
    }),
    searchSkills: builder.query<
      SearchSkillsResponse,
      { q: string; sort?: SkillSortMode; source: SkillMarketplaceSource }
    >({
      queryFn: ({ q, sort, source }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.skills.search.get({ query: { q, sort, source } }),
          searchSkillsResponseSchema.parse
        )
    }),
    fetchSkillDetail: builder.query<SkillDetail, { slug: string; source: SkillMarketplaceSource }>({
      queryFn: ({ slug, source }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.skills({ slug }).get({ query: { source } }), skillDetailSchema.parse)
    })
  })
});

export const {
  useBrowseSkillsQuery,
  useLazyBrowseSkillsQuery,
  useSearchSkillsQuery,
  useLazySearchSkillsQuery,
  useLazyFetchSkillDetailQuery,
  useFetchSkillDetailQuery
} = searchSkillsApi;
