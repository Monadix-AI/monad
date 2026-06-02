import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { channelsApi } from '../channels/index.ts';

export const getLocaleApi = channelsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getLocale: builder.query<string, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.locale.get(),
          (raw) => raw.locale
        ),
      providesTags: ['Locale']
    })
  })
});

export const { useGetLocaleQuery } = getLocaleApi;
