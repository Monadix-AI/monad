import type { ChannelInstanceConfig } from '@monad/home';
import type { ListChannelPairingsResponse, OkResponse } from '@monad/protocol';
import type { ChannelSettingsContext } from '@/handlers/settings/channel/context.ts';

export function createPairingHandlers(ctx: ChannelSettingsContext) {
  return {
    /** Live pairing requests awaiting operator approval for a channel (dmPolicy: 'pairing'). */
    async listChannelPairings({ id }: { id: string }): Promise<ListChannelPairingsResponse> {
      return { pairings: ctx.service.listPendingPairings(id) };
    },

    /** Approve a pairing code: append the awaiting sender to the channel's allowlist, then reload. */
    async approveChannelPairing({ id, code }: { id: string; code: string }): Promise<OkResponse> {
      const userId = ctx.service.consumePairing(id, code);
      if (!userId) throw new Error('pairing code is invalid or has expired');

      const { cfg } = await ctx.read();
      const target = cfg.channels.find((c) => c.id === id);
      if (!target) throw new Error(`unknown channel: ${id}`);
      if (target.allowlist.allowedUsers.includes(userId)) return { ok: true };

      const channels = cfg.channels.map(
        (c): ChannelInstanceConfig =>
          c.id === id ? { ...c, allowlist: { ...c.allowlist, allowedUsers: [...c.allowlist.allowedUsers, userId] } } : c
      );
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    }
  };
}
