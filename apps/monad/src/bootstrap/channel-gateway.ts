import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { CommandBundle } from '@/handlers/commands/index.ts';
import type { EventBus } from '@/services/event-bus.ts';
import type { I18nService } from '@/services/i18n.ts';
import type { Store } from '@/store/db/index.ts';

import { emptyAuth, loadAuth } from '@monad/home';

import { ChannelService, type ChannelServiceDeps, type SessionGateway } from '@/channels/channel.ts';

// Channel gateway: external IM platforms (Telegram, …) as an inbound transport. It CALLS the
// session handlers (createForPrincipal + sendInline), wired via the late-bound sessionGateway ref
// (declared with the early atom pack discovery). The atom pack contract is narrow by design —
// adapters never see a sessionId; the core owns conversation→session.
export async function createChannelGateway(deps: {
  sessionGateway: () => SessionGateway | null;
  store: Store;
  registry: ChannelServiceDeps['registry'];
  bus: EventBus;
  i18n: I18nService;
  commands: CommandBundle;
  logger: Logger;
  cfg: MonadConfig;
  paths: MonadPaths;
}): Promise<ChannelService> {
  const { sessionGateway, store, registry, bus, i18n, commands, logger, cfg, paths } = deps;
  return new ChannelService(
    {
      session: {
        // Guard-narrows sessionGateway to non-null (it is wired before start() runs). A throw
        // also resists a linter "fix" that would rewrite a `!` assertion into an unsafe `?.`.
        createForPrincipal: (a) => {
          const gw = sessionGateway();
          if (!gw) throw new Error('channel gateway used before session wiring');
          return gw.createForPrincipal(a);
        },
        sendInline: (a, sink) => {
          const gw = sessionGateway();
          if (!gw) throw new Error('channel gateway used before session wiring');
          return gw.sendInline(a, sink);
        },
        reset: (a) => {
          const gw = sessionGateway();
          if (!gw?.reset) throw new Error('channel gateway used before session wiring');
          return gw.reset(a);
        },
        setWorkspace: (a) => {
          const gw = sessionGateway();
          if (!gw?.setWorkspace) throw new Error('channel gateway used before session wiring');
          return gw.setWorkspace(a);
        }
      },
      store,
      registry,
      bus,
      t: i18n.t,
      commands,
      log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m) => logger.error(m) }
    },
    cfg,
    (await loadAuth(paths.auth)) ?? emptyAuth()
  );
}
