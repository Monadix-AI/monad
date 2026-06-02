import type { SystemUpgradeStatus } from '@monad/protocol';

import { systemUpgradeStatusSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';

const getSystemUpgradeApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getSystemUpgrade: builder.query<SystemUpgradeStatus, void>({
      queryFn: async (_arg, api: { extra: unknown }) => {
        try {
          const response = await clientOf(api).fetch('/v1/system/upgrade');
          if (!response.ok)
            return { error: toError({ status: response.status, value: await response.json().catch(() => ({})) }) };
          return { data: systemUpgradeStatusSchema.parse(await response.json()) };
        } catch (err) {
          return { error: toError(err) };
        }
      },
      providesTags: ['SystemUpgrade']
    })
  })
});

export const { useGetSystemUpgradeQuery } = getSystemUpgradeApi;
