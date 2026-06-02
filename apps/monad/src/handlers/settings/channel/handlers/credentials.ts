import type { OkResponse, SetChannelCredentialRequest } from '@monad/protocol';
import type { ChannelSettingsContext } from '#/handlers/settings/channel/context.ts';

import { HandlerError } from '#/handlers/handler-error.ts';

export function createCredentialsHandlers(ctx: ChannelSettingsContext) {
  return {
    async setChannelCredential({ id, ...request }: { id: string } & SetChannelCredentialRequest): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      if (!cfg.channels.some((c) => c.id === id)) throw new HandlerError('not_found', `channel not found: ${id}`);
      const channels = cfg.channels.map((channel) =>
        channel.id === id
          ? { ...channel, credential: request.action === 'replace' ? request.value : undefined }
          : channel
      );
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    },

    async clearChannelCredential({ id }: { id: string }): Promise<OkResponse> {
      const { cfg } = await ctx.read();
      const channels = cfg.channels.map((channel) =>
        channel.id === id ? { ...channel, credential: undefined } : channel
      );
      await ctx.commit({ ...cfg, channels });
      return { ok: true };
    }
  };
}
