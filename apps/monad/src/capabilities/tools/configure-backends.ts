// Boot phase: apply config to the process-wide tool backends (shell, code-exec, web search, email).
// Pure side effects keyed off cfg — no outputs the rest of startDaemon consumes — so it lifts out of
// the runtime assembly cleanly. Secret refs are resolved here, at the edge, before reaching a backend.

import type { MonadAuth, MonadConfig } from '@monad/home';

import { configureCodeExec, configureEmail, configureShell, configureWebSearch } from '#/capabilities/tools';
import { resolveSecretRef } from '#/config/secrets.ts';

export async function configureToolBackends(cfg: MonadConfig, auth?: MonadAuth): Promise<void> {
  configureShell({ shellPath: cfg.agent.tools.shellPath, gitBashPath: cfg.agent.tools.gitBashPath });
  configureCodeExec({
    backend: cfg.agent.tools.codeExecBackend,
    e2bApiKey:
      cfg.agent.tools.codeExecE2b?.apiKey !== undefined
        ? resolveSecretRef(cfg.agent.tools.codeExecE2b.apiKey, auth)
        : undefined,
    dockerImage: cfg.agent.tools.codeExecDocker?.image
  });

  const wsCfg = cfg.agent.tools.webSearch;
  configureWebSearch({
    provider: wsCfg.provider,
    braveApiKey: wsCfg.brave?.apiKey !== undefined ? resolveSecretRef(wsCfg.brave.apiKey, auth) : undefined
  });

  const emailCfg = cfg.agent.tools.email;
  configureEmail({
    backend: emailCfg.backend,
    from: emailCfg.from,
    resendApiKey: emailCfg.resend?.apiKey !== undefined ? resolveSecretRef(emailCfg.resend.apiKey, auth) : undefined,
    smtp: emailCfg.smtp
      ? {
          host: emailCfg.smtp.host,
          port: emailCfg.smtp.port ?? (emailCfg.smtp.secure !== false ? 465 : 587),
          user: emailCfg.smtp.user,
          pass: emailCfg.smtp.pass !== undefined ? resolveSecretRef(emailCfg.smtp.pass, auth) : undefined,
          secure: emailCfg.smtp.secure ?? emailCfg.smtp.port !== 587,
          clientName: emailCfg.smtp.clientName ?? 'monad'
        }
      : undefined
  });
}
