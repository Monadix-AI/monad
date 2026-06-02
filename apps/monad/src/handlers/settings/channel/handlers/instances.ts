import type { ChannelInstanceConfig } from '@monad/environment';
import type {
  ChannelInstanceView,
  GetChannelResponse,
  ListChannelsResponse,
  OkResponse,
  UpsertChannelRequest
} from '@monad/protocol';
import type { ChannelSettingsContext } from '#/handlers/settings/channel/context.ts';

import { HandlerError } from '#/handlers/handler-error.ts';

function toView(c: ChannelInstanceConfig): ChannelInstanceView {
  return {
    id: c.id as ChannelInstanceView['id'],
    type: c.type,
    label: c.label,
    enabled: c.enabled,
    agentId: c.agentId,
    groupPolicy: c.groupPolicy,
    agentHint: c.agentHint,
    credentialConfigured: c.credential !== undefined,
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

    async getChannel({ id }: { id: string }): Promise<GetChannelResponse> {
      const { cfg } = await ctx.read();
      const found = cfg.channels.find((c) => c.id === id);
      if (!found) throw new HandlerError('not_found', `channel not found: ${id}`);
      return { channel: toView(found) };
    },

    async upsertChannel({ channel }: UpsertChannelRequest): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const existing = cfg.channels.find((c) => c.id === channel.id);
      const next: ChannelInstanceConfig = {
        ...channel,
        credential: existing?.credential
      };
      const channels = existing ? cfg.channels.map((c) => (c.id === channel.id ? next : c)) : [...cfg.channels, next];
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    },

    async setChannelEnabled({ id, enabled }: { id: string; enabled: boolean }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      if (!cfg.channels.some((c) => c.id === id)) throw new HandlerError('not_found', `channel not found: ${id}`);
      const channels = cfg.channels.map((c) => (c.id === id ? { ...c, enabled } : c));
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    },

    async loginChannel({ id }: { id: string }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const found = cfg.channels.find((channel) => channel.id === id);
      if (!found) throw new HandlerError('not_found', `channel not found: ${id}`);
      if (!found.enabled) {
        await ctx.commit({
          ...cfg,
          channels: cfg.channels.map((channel) => (channel.id === id ? { ...channel, enabled: true } : channel))
        });
      }
      try {
        await ctx.service.beginPairing(id as ChannelInstanceView['id']);
      } catch (error) {
        throw new HandlerError('invalid', error instanceof Error ? error.message : 'channel pairing failed');
      }
      return { ok: true };
    },

    async removeChannel({ id }: { id: string }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      if (!cfg.channels.some((c) => c.id === id)) throw new HandlerError('not_found', `channel not found: ${id}`);
      await ctx.service.logoutChannel(id as ChannelInstanceView['id']);
      const channels = cfg.channels.filter((c) => c.id !== id);
      await ctx.commit({ ...cfg, channels });
      await ctx.service.removeState(id as ChannelInstanceView['id']);
      return { ok: true };
    }
  };
}
