import type { ChannelId, ChannelInstanceView, ChannelStatus } from '@monad/protocol';

import {
  channelAdapter,
  channelSelectors,
  useChannelStatusQuery,
  useDeleteChannelMutation,
  useListChannelsQuery,
  usePairChannelMutation,
  useSetChannelCredentialMutation,
  useUpsertChannelMutation
} from '@monad/client-rtk';
import { useCallback, useMemo } from 'react';

export interface ChannelSettingsStore {
  channels: ChannelInstanceView[];
  statusById: Map<string, ChannelStatus>;
  loading: boolean;
  error?: string;
  saveChannel: (c: ChannelInstanceView) => Promise<void>;
  removeChannel: (id: string) => Promise<void>;
  setEnabled: (c: ChannelInstanceView, enabled: boolean) => Promise<void>;
  setCredential: (id: ChannelId, value: { token: string; extra?: Record<string, string> }) => Promise<void>;
  pairChannel: (id: ChannelId) => Promise<void>;
  refetch: () => void;
}

export function useChannelSettings(): ChannelSettingsStore {
  const channelsQ = useListChannelsQuery(undefined);
  // Pairing adapters publish their QR asynchronously after the pair mutation has already returned.
  // Keep this settings surface live so a transient `connecting` snapshot advances to `pairing`
  // without making the operator close/reopen the dialog.
  const statusQ = useChannelStatusQuery(undefined, { pollingInterval: 1000, skipPollingIfUnfocused: true });
  const [upsert] = useUpsertChannelMutation();
  const [del] = useDeleteChannelMutation();
  const [setCred] = useSetChannelCredentialMutation();
  const [pair] = usePairChannelMutation();

  const statusById = useMemo(() => {
    const m = new Map<string, ChannelStatus>();
    for (const s of statusQ.data ?? []) m.set(s.id, s);
    return m;
  }, [statusQ.data]);

  const saveChannel = useCallback(
    async (c: ChannelInstanceView) => {
      await upsert(c).unwrap();
    },
    [upsert]
  );
  const removeChannel = useCallback(
    async (id: string) => {
      await del(id).unwrap();
    },
    [del]
  );
  const setEnabled = useCallback(
    async (c: ChannelInstanceView, enabled: boolean) => {
      await upsert({ ...c, enabled }).unwrap();
    },
    [upsert]
  );
  const setCredential = useCallback(
    async (id: ChannelId, value: { token: string; extra?: Record<string, string> }) => {
      await setCred({ id, action: 'replace', value }).unwrap();
    },
    [setCred]
  );
  const pairChannel = useCallback(
    async (id: ChannelId) => {
      await pair(id).unwrap();
    },
    [pair]
  );

  return {
    channels: channelSelectors.selectAll(channelsQ.data ?? channelAdapter.getInitialState()),
    statusById,
    loading: channelsQ.isLoading,
    error: channelsQ.error ? ((channelsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveChannel,
    removeChannel,
    setEnabled,
    setCredential,
    pairChannel,
    refetch: () => {
      void channelsQ.refetch();
      void statusQ.refetch();
    }
  };
}
