import type { InitDockerResponse, SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import { initializeDockerCodeExec, prepareCodeExecBackend } from '#/capabilities/tools';

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
        availableBackends,
        e2bApiKey: codeExecE2b?.apiKey,
        dockerImage: codeExecDocker?.image
      }
    };
  }

  async function setToolBackends(req: SetToolBackendsRequest): Promise<ToolBackendsResponse> {
    await config.updateConfig((cfg) => {
      if (req.webSearch) {
        if (req.webSearch.provider !== undefined) cfg.agent.tools.webSearch.provider = req.webSearch.provider;
        if (req.webSearch.braveApiKey !== undefined) {
          cfg.agent.tools.webSearch.brave = req.webSearch.braveApiKey
            ? { apiKey: req.webSearch.braveApiKey }
            : undefined;
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

      if (req.codeExec) {
        if (req.codeExec.backend !== undefined) cfg.agent.tools.codeExecBackend = req.codeExec.backend;
        if (req.codeExec.e2bApiKey !== undefined) {
          cfg.agent.tools.codeExecE2b = req.codeExec.e2bApiKey ? { apiKey: req.codeExec.e2bApiKey } : undefined;
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
