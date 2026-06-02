import type { LocaleCatalogResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listLocalesApi } from './list-locales.ts';

/** The resolved message catalog (raw templates) for a locale. `undefined` → the daemon's active
 *  locale. Keyed by `locale` so switching invalidates + refetches the right catalog. */
export const getCatalogApi = listLocalesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getCatalog: builder.query<LocaleCatalogResponse, string | undefined>({
      queryFn: (locale: string | undefined, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.i18n.catalog.get({ query: locale ? { locale } : {} })),
      providesTags: ['Catalog']
    })
  })
});

export const { useGetCatalogQuery } = getCatalogApi;
