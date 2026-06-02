import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { deleteProfileApi } from '../profiles/delete-profile.ts';

export const getDefaultApi = deleteProfileApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getDefault: builder.query<string, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.model.default.get(),
          (raw) => raw.alias
        ),
      providesTags: ['Default']
    })
  })
});

export const { useGetDefaultQuery } = getDefaultApi;
