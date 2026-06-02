import type { MonadPaths } from '@monad/home';
import type { SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createToolBackendsModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getToolBackends(): Promise<ToolBackendsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('tool-backends: config.json missing');
    const { webSearch, email, codeExecBackend } = cfg.agent.tools;
    return {
      webSearch: {
        provider: webSearch.provider,
        braveApiKey: webSearch.brave?.apiKey
      },
      email: {
        backend: email.backend,
        from: email.from,
        resendApiKey: email.resend?.apiKey,
        smtp: email.smtp
          ? {
              host: email.smtp.host,
              port: email.smtp.port,
              user: email.smtp.user,
              pass: email.smtp.pass,
              secure: email.smtp.secure,
              clientName: email.smtp.clientName
            }
          : undefined
      },
      codeExec: {
        backend: codeExecBackend,
        availableBackends: ['local']
      }
    };
  }

  async function setToolBackends(req: SetToolBackendsRequest): Promise<ToolBackendsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('tool-backends: config.json missing');

    if (req.webSearch) {
      if (req.webSearch.provider !== undefined) cfg.agent.tools.webSearch.provider = req.webSearch.provider;
      if (req.webSearch.braveApiKey !== undefined) {
        cfg.agent.tools.webSearch.brave = req.webSearch.braveApiKey ? { apiKey: req.webSearch.braveApiKey } : undefined;
      }
    }

    if (req.email) {
      if (req.email.backend !== undefined) cfg.agent.tools.email.backend = req.email.backend;
      if (req.email.from !== undefined) cfg.agent.tools.email.from = req.email.from || undefined;
      if (req.email.resendApiKey !== undefined) {
        cfg.agent.tools.email.resend = req.email.resendApiKey ? { apiKey: req.email.resendApiKey } : undefined;
      }
      if (req.email.smtp !== undefined) {
        cfg.agent.tools.email.smtp = req.email.smtp ?? undefined;
      }
    }

    if (req.codeExec?.backend !== undefined) {
      cfg.agent.tools.codeExecBackend = req.codeExec.backend;
    }

    await saveProfile(paths.profile, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }

    return getToolBackends();
  }

  return { getToolBackends, setToolBackends };
}
