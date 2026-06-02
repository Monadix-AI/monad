import type { CredentialView, TestCredentialResponse } from '@monad/protocol';
import type { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';

import {
  credentialAdapter,
  credentialSelectors,
  monadApi,
  useAddCredentialMutation,
  useDeleteCredentialMutation,
  useTestCredentialMutation
} from '@monad/client-rtk';
import { useEffect, useMemo } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';

export { useModelSettings, useModelSettingsQueryState } from '@monad/client-rtk';

type ApiDispatch = ThunkDispatch<
  { [K in typeof monadApi.reducerPath]: ReturnType<typeof monadApi.reducer> },
  unknown,
  UnknownAction
>;

export interface CredentialActions {
  addCredential: (providerId: string, label: string, accessToken: string) => Promise<void>;
  deleteCredential: (providerId: string, credentialId: string) => Promise<void>;
  testCredential: (providerId: string, credentialId: string) => Promise<TestCredentialResponse>;
}

export function useCredentialActions(): CredentialActions {
  const [addCredentialMut] = useAddCredentialMutation();
  const [deleteCredentialMut] = useDeleteCredentialMutation();
  const [testCredentialMut] = useTestCredentialMutation();

  return useMemo(
    () => ({
      addCredential: async (providerId: string, label: string, accessToken: string) => {
        await addCredentialMut({ providerId, label, authType: 'api_key', accessToken }).unwrap();
      },
      deleteCredential: async (providerId: string, credentialId: string) => {
        await deleteCredentialMut({ providerId, credentialId }).unwrap();
      },
      testCredential: (providerId: string, credentialId: string) =>
        testCredentialMut({ providerId, credentialId }).unwrap()
    }),
    [addCredentialMut, deleteCredentialMut, testCredentialMut]
  );
}

export function useCredentialsMap(providerIds: string[]): Record<string, CredentialView[]> {
  const dispatch = useDispatch<ApiDispatch>();
  const key = providerIds.join(' ');

  useEffect(() => {
    const ids = key === '' ? [] : key.split(' ');
    const subs = ids.map((id) => dispatch(monadApi.endpoints.listCredentials.initiate(id)));
    return () => {
      for (const sub of subs) sub.unsubscribe();
    };
  }, [dispatch, key]);

  const ids = useMemo(() => (key === '' ? [] : key.split(' ')), [key]);
  return useSelector(
    (state: unknown) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          credentialSelectors.selectAll(
            monadApi.endpoints.listCredentials.select(id)(state as never).data ?? credentialAdapter.getInitialState()
          )
        ])
      ),
    shallowEqual
  );
}
