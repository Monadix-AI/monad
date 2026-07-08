import type { MonadPaths } from '@monad/home';
import type { InitDockerResponse, SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';
import type { ConfigBus } from '#/services/config-bus.ts';

import { detectDockerRuntime, dockerRuntimeAvailable } from '@monad/atoms';
import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createToolBackendsModule(paths: MonadPaths, configBus?: ConfigBus) {
  // Probe docker availability once at module creation time (cached in dockerRuntimeAvailable()).
  void detectDockerRuntime();

  async function getToolBackends(): Promise<ToolBackendsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('tool-backends: config.json missing');
    const { webSearch, email, codeExecBackend, codeExecE2b, codeExecDocker } = cfg.agent.tools;

    const availableBackends: string[] = ['follow-system'];
    if (dockerRuntimeAvailable()) availableBackends.push('docker');
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

    if (req.codeExec) {
      if (req.codeExec.backend !== undefined) cfg.agent.tools.codeExecBackend = req.codeExec.backend;
      if (req.codeExec.e2bApiKey !== undefined) {
        cfg.agent.tools.codeExecE2b = req.codeExec.e2bApiKey ? { apiKey: req.codeExec.e2bApiKey } : undefined;
      }
      if (req.codeExec.dockerImage !== undefined) {
        cfg.agent.tools.codeExecDocker = req.codeExec.dockerImage ? { image: req.codeExec.dockerImage } : undefined;
      }
    }

    await saveProfile(paths.profile, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }

    return getToolBackends();
  }

  async function initDockerBackend(): Promise<InitDockerResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    const image = cfg?.agent.tools.codeExecDocker?.image ?? 'ubuntu:22.04';
    const runtime = await detectDockerRuntime();
    if (!runtime) return { ok: false, image, error: 'Docker/Podman not available' };
    try {
      const proc = Bun.spawn([runtime, 'pull', image], { stdout: 'ignore', stderr: 'pipe' });
      // Drain stderr concurrently with waiting for exit to avoid pipe-buffer deadlock.
      const [exitCode, errText] = await Promise.all([
        proc.exited,
        new Response(proc.stderr as ReadableStream<Uint8Array>).text()
      ]);
      if (exitCode === 0) return { ok: true, image };
      return { ok: false, image, error: errText.trim().slice(0, 400) };
    } catch (e) {
      return { ok: false, image, error: String(e) };
    }
  }

  return { getToolBackends, setToolBackends, initDockerBackend };
}
