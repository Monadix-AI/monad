import type { ChannelInstanceConfig } from '@monad/home';
import type { ChannelInstanceView, ListChannelsResponse, OkResponse, UpsertChannelRequest } from '@monad/protocol';
import type { ChannelSettingsContext } from '@/handlers/settings/channel/context.ts';

function toView(c: ChannelInstanceConfig): ChannelInstanceView {
  // tokenRef is intentionally dropped — secret material never crosses the wire.
  return {
    id: c.id as ChannelInstanceView['id'],
    type: c.type,
    label: c.label,
    enabled: c.enabled,
    agentId: c.agentId,
    options: c.options,
    allowlist: c.allowlist,
    groupPolicy: c.groupPolicy,
    agentHint: c.agentHint,
    mapping: c.mapping,
    rateLimitPerMin: c.rateLimitPerMin
  };
}

export function createInstancesHandlers(ctx: ChannelSettingsContext) {
  return {
    async listChannels(): Promise<ListChannelsResponse> {
      const { cfg } = await ctx.read();
      return { channels: cfg.channels.map(toView) };
    },

    async upsertChannel({ channel }: UpsertChannelRequest): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const existing = cfg.channels.find((c) => c.id === channel.id);
      const next: ChannelInstanceConfig = {
        ...channel,
        // Preserve the existing token reference; default new channels to the auth.json-backed scheme.
        tokenRef: existing?.tokenRef ?? `\${secret:channel/${channel.id}/token}`,
        // ownerUsers is config-only (like tokenRef) — it never crosses the wire, so preserve it across
        // a web upsert rather than letting the view round-trip wipe it.
        ownerUsers: existing?.ownerUsers ?? []
      };
      const channels = existing ? cfg.channels.map((c) => (c.id === channel.id ? next : c)) : [...cfg.channels, next];
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    },

    async setChannelEnabled({ id, enabled }: { id: string; enabled: boolean }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const channels = cfg.channels.map((c) => (c.id === id ? { ...c, enabled } : c));
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    },

    async removeChannel({ id }: { id: string }): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
      const channels = cfg.channels.filter((c) => c.id !== id);
      if (auth.channelCredentials?.[id]) {
        delete auth.channelCredentials[id];
        await ctx.commit({ ...cfg, channels }, auth);
      } else {
        await ctx.commit({ ...cfg, channels });
      }
      return { ok: true };
    }
  };
}
