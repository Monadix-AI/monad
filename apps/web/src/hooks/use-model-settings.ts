import type { CredentialView, ModelInfo, TestCredentialResponse } from '@monad/protocol';

import {
  credentialAdapter,
  credentialSelectors,
  modelAdapter,
  modelSelectors,
  useAddCredentialMutation,
  useDeleteCredentialMutation,
  useListCredentialsQuery,
  useListModelsQuery,
  useTestCredentialMutation
} from '@monad/client-rtk';
import { useCallback } from 'react';

export { useModelSettings, useModelSettingsQueryState } from '@monad/client-rtk';

export interface ProviderDetail {
  credentials: CredentialView[];
  models: ModelInfo[];
  isLoadingCredentials: boolean;
  isLoadingModels: boolean;
  refreshModels: () => void;
  addCredential: (label: string, accessToken: string) => Promise<void>;
  deleteCredential: (credentialId: string) => Promise<void>;
  testCredential: (credentialId: string) => Promise<TestCredentialResponse>;
}

export function useProviderDetail(providerId: string): ProviderDetail {
  const credentialsQ = useListCredentialsQuery(providerId, { skip: !providerId });
  const modelsQ = useListModelsQuery(providerId, { skip: !providerId });
  const [addCredentialMut] = useAddCredentialMutation();
  const [deleteCredentialMut] = useDeleteCredentialMutation();
  const [testCredentialMut] = useTestCredentialMutation();

  return {
    credentials: credentialSelectors.selectAll(credentialsQ.data ?? credentialAdapter.getInitialState()),
    models: modelSelectors.selectAll(modelsQ.data ?? modelAdapter.getInitialState()),
    isLoadingCredentials: credentialsQ.isLoading,
    isLoadingModels: modelsQ.isFetching,
    refreshModels: () => void modelsQ.refetch(),
    addCredential: useCallback(
      async (label: string, accessToken: string) => {
        await addCredentialMut({ providerId, label, authType: 'api_key', accessToken }).unwrap();
      },
      [addCredentialMut, providerId]
    ),
    deleteCredential: useCallback(
      async (credentialId: string) => {
        await deleteCredentialMut({ providerId, credentialId }).unwrap();
      },
      [deleteCredentialMut, providerId]
    ),
    testCredential: useCallback(
      (credentialId: string) => testCredentialMut({ providerId, credentialId }).unwrap(),
      [testCredentialMut, providerId]
    )
  };
}
