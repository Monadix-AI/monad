import type { ChannelStatusResponse } from '@monad/protocol';
import type { ChannelSettingsContext } from '#/handlers/settings/channel/context.ts';

export function createStatusHandlers(ctx: ChannelSettingsContext) {
  return {
    async channelStatus(): Promise<ChannelStatusResponse> {
      return { statuses: ctx.service.statusSnapshot() };
    }
  };
}
