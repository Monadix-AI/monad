import type { SystemUpgradeStatus } from '@monad/protocol';

import { systemUpgradeStatusSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, toError } from '../../endpoint-helpers.ts';

const startSystemUpgradeApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startSystemUpgrade: builder.mutation<SystemUpgradeStatus, void>({
      queryFn: async (_arg, api: { extra: unknown }) => {
        try {
          const response = await clientOf(api).fetch('/v1/system/upgrade', { method: 'POST' });
          if (!response.ok)
            return { error: toError({ status: response.status, value: await response.json().catch(() => ({})) }) };
          return { data: systemUpgradeStatusSchema.parse(await response.json()) };
        } catch (err) {
          return { error: toError(err) };
        }
      },
      invalidatesTags: ['SystemUpgrade', 'Health']
    })
  })
});

export const { useStartSystemUpgradeMutation } = startSystemUpgradeApi;
