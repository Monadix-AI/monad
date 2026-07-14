import type { ChannelId, ChannelInstanceView, ChannelStatus } from '@monad/protocol';

import {
  channelAdapter,
  channelSelectors,
  useChannelStatusQuery,
  useDeleteChannelMutation,
  useListChannelsQuery,
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
  setToken: (id: ChannelId, token: string) => Promise<void>;
  refetch: () => void;
}

export function useChannelSettings(): ChannelSettingsStore {
  const channelsQ = useListChannelsQuery(undefined);
  const statusQ = useChannelStatusQuery(undefined, { pollingInterval: 5000 });
  const [upsert] = useUpsertChannelMutation();
  const [del] = useDeleteChannelMutation();
  const [setCred] = useSetChannelCredentialMutation();

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
  const setToken = useCallback(
    async (id: ChannelId, token: string) => {
      await setCred({ id, token }).unwrap();
    },
    [setCred]
  );

  return {
    channels: channelSelectors.selectAll(channelsQ.data ?? channelAdapter.getInitialState()),
    statusById,
    loading: channelsQ.isLoading,
    error: channelsQ.error ? ((channelsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveChannel,
    removeChannel,
    setEnabled,
    setToken,
    refetch: () => {
      void channelsQ.refetch();
      void statusQ.refetch();
    }
  };
}
