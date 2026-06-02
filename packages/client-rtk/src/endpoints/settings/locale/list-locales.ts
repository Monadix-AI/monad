import type { LocaleInfo } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { setLocaleApi } from './set-locale.ts';

export const localeAdapter = createEntityAdapter<LocaleInfo, string>({ selectId: (l) => l.locale });
export const localeSelectors = localeAdapter.getSelectors();

export const listLocalesApi = setLocaleApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLocales: builder.query<EntityState<LocaleInfo, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.locales.get(),
          (raw) => localeAdapter.setAll(localeAdapter.getInitialState(), raw.locales)
        ),
      providesTags: ['Locale']
    })
  })
});

export const { useListLocalesQuery } = listLocalesApi;
