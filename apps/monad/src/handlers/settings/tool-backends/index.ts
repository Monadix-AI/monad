import type { InitDockerResponse, SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import { initializeDockerCodeExec, prepareCodeExecBackend } from '#/capabilities/tools';

type SecretUpdate = { action: 'replace'; value: string } | { action: 'remove' };

function configured(value: string | undefined) {
  return { configured: value !== undefined && value.length > 0 };
}

function applySecret(current: string | undefined, update: SecretUpdate | undefined): string | undefined {
  if (!update) return current;
  return update.action === 'replace' ? update.value : undefined;
}

export function createToolBackendsModule(config: ConfigAccess) {
  async function getToolBackends(): Promise<ToolBackendsResponse> {
    const cfg = config.get().cfg;
    const { webSearch, email, codeExecBackend, codeExecE2b, codeExecDocker } = cfg.agent.tools;

    const availableBackends: string[] = ['follow-system'];
    if (await prepareCodeExecBackend('docker')) availableBackends.push('docker');
    if (codeExecE2b?.apiKey) availableBackends.push('e2b');

    return {
      webSearch: {
        provider: webSearch.provider,
        braveApiKey: configured(webSearch.brave?.apiKey)
      },
      email: {
        backend: email.backend,
        from: email.from,
        resendApiKey: configured(email.resend?.apiKey),
        smtp: email.smtp
          ? {
              host: email.smtp.host,
              port: email.smtp.port,
              user: email.smtp.user,
              pass: configured(email.smtp.pass),
              secure: email.smtp.secure,
              clientName: email.smtp.clientName
            }
          : undefined
      },
      codeExec: {
        backend: codeExecBackend,
        availableBackends,
        e2bApiKey: configured(codeExecE2b?.apiKey),
        dockerImage: codeExecDocker?.image
      }
    };
  }

  async function setToolBackends(req: SetToolBackendsRequest): Promise<ToolBackendsResponse> {
    await config.updateConfig((cfg) => {
      if (req.webSearch) {
        if (req.webSearch.provider !== undefined) cfg.agent.tools.webSearch.provider = req.webSearch.provider;
        if (req.webSearch.braveApiKey !== undefined) {
          const apiKey = applySecret(cfg.agent.tools.webSearch.brave?.apiKey, req.webSearch.braveApiKey);
          cfg.agent.tools.webSearch.brave = apiKey ? { apiKey } : undefined;
        }
      }

      if (req.email) {
        if (req.email.backend !== undefined) cfg.agent.tools.email.backend = req.email.backend;
        if (req.email.from !== undefined) cfg.agent.tools.email.from = req.email.from || undefined;
        if (req.email.resendApiKey !== undefined) {
          const apiKey = applySecret(cfg.agent.tools.email.resend?.apiKey, req.email.resendApiKey);
          cfg.agent.tools.email.resend = apiKey ? { apiKey } : undefined;
        }
        if (req.email.smtp !== undefined) {
          if (req.email.smtp.action === 'remove') {
            cfg.agent.tools.email.smtp = undefined;
          } else {
            const current = cfg.agent.tools.email.smtp;
            cfg.agent.tools.email.smtp = {
              ...req.email.smtp.value,
              pass: applySecret(current?.pass, req.email.smtp.value.pass)
            };
          }
        }
      }

      if (req.codeExec) {
        if (req.codeExec.backend !== undefined) cfg.agent.tools.codeExecBackend = req.codeExec.backend;
        if (req.codeExec.e2bApiKey !== undefined) {
          const apiKey = applySecret(cfg.agent.tools.codeExecE2b?.apiKey, req.codeExec.e2bApiKey);
          cfg.agent.tools.codeExecE2b = apiKey ? { apiKey } : undefined;
        }
        if (req.codeExec.dockerImage !== undefined) {
          cfg.agent.tools.codeExecDocker = req.codeExec.dockerImage ? { image: req.codeExec.dockerImage } : undefined;
        }
      }
    });

    return getToolBackends();
  }

  async function initDockerBackend(): Promise<InitDockerResponse> {
    const image = config.get().cfg.agent.tools.codeExecDocker?.image ?? 'ubuntu:22.04';
    try {
      const result = await initializeDockerCodeExec(image);
      if (result.exitCode === 0) return { ok: true, image };
      return { ok: false, image, error: result.stderr.trim().slice(0, 400) };
    } catch (e) {
      return { ok: false, image, error: String(e) };
    }
  }

  return { getToolBackends, setToolBackends, initDockerBackend };
}
