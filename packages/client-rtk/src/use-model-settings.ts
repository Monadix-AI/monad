import type { ModelInfo, ProfileView, ProviderView, TestConnectionResponse } from '@monad/protocol';
import type { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';

import { useCallback } from 'react';
import { useDispatch } from 'react-redux';

import {
  modelAdapter,
  monadApi,
  profileSelectors,
  providerAdapter,
  providerSelectors,
  useAddCredentialMutation,
  useDeleteProfileMutation,
  useDeleteProviderMutation,
  useListProfilesQuery,
  useListProvidersQuery,
  useRenameProfileMutation,
  useSetDefaultMutation,
  useSetProfileMutation,
  useSetProviderMutation,
  useTestConnectionMutation
} from './api.ts';

export const DEFAULT_PROFILE = 'default';

type ApiDispatch = ThunkDispatch<
  { [K in typeof monadApi.reducerPath]: ReturnType<typeof monadApi.reducer> },
  unknown,
  UnknownAction
>;

export interface ModelSettingsStore {
  providers: ProviderView[];
  profiles: ProfileView[];
  defaultAlias: string;
  testConnection: (provider: ProviderView, accessToken: string) => Promise<TestConnectionResponse>;
  addProvider: (
    provider: ProviderView,
    firstKey: { label: string; accessToken: string },
    opts?: { models?: ModelInfo[] }
  ) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setProfile: (profile: ProfileView) => Promise<void>;
  renameProfile: (alias: string, nextAlias: string) => Promise<void>;
  deleteProfile: (alias: string) => Promise<void>;
  setDefaultProfile: (alias: string) => Promise<void>;
}

export interface ModelSettingsQueryState {
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useModelSettings(): ModelSettingsStore {
  const providersQ = useListProvidersQuery(undefined);
  const profilesQ = useListProfilesQuery(undefined);

  const [setProviderMut] = useSetProviderMutation();
  const [deleteProviderMut] = useDeleteProviderMutation();
  const [addCredentialMut] = useAddCredentialMutation();
  const [setProfileMut] = useSetProfileMutation();
  const [renameProfileMut] = useRenameProfileMutation();
  const [deleteProfileMut] = useDeleteProfileMutation();
  const [setDefaultMut] = useSetDefaultMutation();
  const [testConnectionMut] = useTestConnectionMutation();
  const dispatch = useDispatch<ApiDispatch>();

  const providers = providerSelectors.selectAll(providersQ.data ?? providerAdapter.getInitialState());
  const profiles = profilesQ.data ? profileSelectors.selectAll(profilesQ.data.profiles) : [];
  const defaultAlias = profilesQ.data?.defaultAlias ?? '';

  const testConnection = useCallback(
    (provider: ProviderView, accessToken: string) => testConnectionMut({ provider, accessToken }).unwrap(),
    [testConnectionMut]
  );

  const addProvider = useCallback(
    async (
      provider: ProviderView,
      firstKey: { label: string; accessToken: string },
      opts?: { models?: ModelInfo[] }
    ) => {
      await setProviderMut(provider).unwrap();
      await addCredentialMut({
        providerId: provider.id,
        label: firstKey.label,
        authType: 'api_key',
        accessToken: firstKey.accessToken
      }).unwrap();
      if (opts?.models?.length) {
        dispatch(
          monadApi.util.upsertQueryData(
            'listModels',
            provider.id,
            modelAdapter.setAll(modelAdapter.getInitialState(), opts.models)
          )
        );
      }
    },
    [setProviderMut, addCredentialMut, dispatch]
  );

  return {
    providers,
    profiles,
    defaultAlias,
    testConnection,
    addProvider,
    deleteProvider: useCallback(
      async (id: string) => {
        await deleteProviderMut(id).unwrap();
      },
      [deleteProviderMut]
    ),
    setProfile: useCallback(
      async (profile: ProfileView) => {
        await setProfileMut(profile).unwrap();
      },
      [setProfileMut]
    ),
    renameProfile: useCallback(
      async (alias: string, nextAlias: string) => {
        await renameProfileMut({ alias, nextAlias }).unwrap();
      },
      [renameProfileMut]
    ),
    deleteProfile: useCallback(
      async (alias: string) => {
        await deleteProfileMut(alias).unwrap();
      },
      [deleteProfileMut]
    ),
    setDefaultProfile: useCallback(
      async (alias: string) => {
        await setDefaultMut({ alias }).unwrap();
      },
      [setDefaultMut]
    )
  };
}

export function useModelSettingsQueryState(): ModelSettingsQueryState {
  const providersQ = useListProvidersQuery(undefined);
  const profilesQ = useListProfilesQuery(undefined);
  return {
    isLoading: providersQ.isLoading || profilesQ.isLoading,
    error: providersQ.error ?? profilesQ.error ?? null,
    refetch: () => {
      void providersQ.refetch();
      void profilesQ.refetch();
    }
  };
}
