import type { OkResponse, SetChannelCredentialRequest } from '@monad/protocol';
import type { ChannelSettingsContext } from '@/handlers/settings/channel/context.ts';

export function createCredentialsHandlers(ctx: ChannelSettingsContext) {
  return {
    // Token lands in auth.json (owner-only, atomic write); config.json keeps only the
    // `${secret:channel/<id>/token}` reference. Never echoed back by list()/status().
    async setChannelCredential({
      id,
      token,
      extra
    }: { id: string } & SetChannelCredentialRequest): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
      const channelCredentials = { ...(auth.channelCredentials ?? {}), [id]: { token, extra } };
      await ctx.commitAuth(cfg, { ...auth, channelCredentials });
      return { ok: true };
    },

    async clearChannelCredential({ id }: { id: string }): Promise<OkResponse> {
      const { cfg, auth } = await ctx.read();
      if (auth.channelCredentials?.[id]) {
        const channelCredentials = { ...auth.channelCredentials };
        delete channelCredentials[id];
        await ctx.commitAuth(cfg, { ...auth, channelCredentials });
      }
      return { ok: true };
    }
  };
}
