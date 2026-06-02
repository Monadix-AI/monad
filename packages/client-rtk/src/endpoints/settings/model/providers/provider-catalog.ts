import type { ModelProviderDescriptor } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { sessionsApi } from '../../../sessions/index.ts';

// The provider catalog (labels, default base URLs, key hints, extra fields) assembled by the
// daemon from every registered provider's self-describing descriptor — first- and third-party.
// The UI reads this instead of a hardcoded protocol constant.
const providerCatalogApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    providerCatalog: builder.query<ModelProviderDescriptor[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.providers.catalog.get(),
          (raw) => raw.providers
        )
    })
  })
});

export const { useProviderCatalogQuery } = providerCatalogApi;
