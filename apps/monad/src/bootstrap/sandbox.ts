// Boot phase: OS-level confinement for spawned children (code_execute/shell_exec/process_start) plus
// the ephemeral per-session sandbox service. Reads cfg + paths, applies the process-wide sandbox
// policy as a side effect, and returns the three products the rest of startDaemon consumes.

import type { MonadAuth, MonadConfig, MonadPaths, SandboxMode } from '@monad/home';
import type { Store } from '@/store/db/index.ts';
import type { SessionSandboxService } from '../services/session-sandbox.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  configureDockerImage,
  configureNativeLauncherPath,
  detectDockerRuntime,
  sweepOrphanAppContainerProfiles
} from '@monad/atoms';
import { logger } from '@monad/logger';
import { configureSandboxCredential } from '@monad/sdk-atom';

import {
  configureHostExec,
  configureSandboxExtraEnv,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxProxyEnv,
  configureSandboxReadDeny,
  noneLauncher,
  selectSandboxLauncher
} from '@/capabilities/tools';
import { resolveEffectiveSandboxMode } from '@/config/resolve.ts';
import { resolveSecretRef } from '@/config/secrets.ts';
import { startEgressProxy } from '../services/egress-proxy.ts';
import { createSessionSandboxService } from '../services/session-sandbox.ts';

export interface SandboxSetup {
  effectiveSandboxMode: SandboxMode;
  sandboxRoots: string[] | undefined;
  sessionSandbox: SessionSandboxService;
}

export async function createSandbox(
  cfg: MonadConfig,
  paths: MonadPaths,
  store: Store,
  auth?: MonadAuth
): Promise<SandboxSetup> {
  const effectiveSandboxMode = resolveEffectiveSandboxMode(cfg.agent.sandbox, cfg.agent.globalSandbox);
  const sandboxRoots = resolveSandboxRoots(effectiveSandboxMode, paths.workspace);

  // A cloud (remote) launcher's credential — resolved from a secret ref so the key never lives in
  // config.json. Set unconditionally; only a selected remote launcher reads it.
  configureSandboxCredential(
    cfg.agent.sandbox.credential ? resolveSecretRef(cfg.agent.sandbox.credential, auth) : undefined
  );

  // Docker runtime detection: async probe, cached for the process lifetime. Must run before
  // finalizeSandboxLauncher() so dockerLauncher.isAvailable() returns correctly at selection time.
  await detectDockerRuntime();
  if (cfg.agent.sandbox.dockerImage) configureDockerImage(cfg.agent.sandbox.dockerImage);

  if (cfg.agent.sandbox.confine) {
    // The override path for the native Linux/Windows launcher binary (config.agent.sandbox.launcherPath)
    // must reach the launcher atoms before selection probes their isAvailable(); push it now (the
    // launchers are static atom objects that read it lazily). The actual launcher is selected after
    // the atom packs load — see finalizeSandboxLauncher().
    configureNativeLauncherPath(cfg.agent.sandbox.launcherPath);
    // Reclaim AppContainer profiles orphaned by a prior crash on Windows. Best-effort.
    void sweepOrphanAppContainerProfiles();
    // Deny confined children read access to credential stores even under open egress, so a
    // prompt-injected snippet can't read-then-exfiltrate secrets. The profile is allow-read by
    // default (interpreters must start); only these roots are blocked.
    const home = homedir();
    configureSandboxReadDeny([
      paths.credentials,
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.gnupg'),
      join(home, '.config', 'gcloud')
    ]);
    if (cfg.agent.sandbox.net === 'filtered') {
      // Start the local filtering proxy and make it the child's only egress: the policy permits
      // just the proxy port and HTTP(S)_PROXY routes the child's curl/pip/npm/git through it.
      const proxy = startEgressProxy({
        policy: { allowedDomains: cfg.agent.sandbox.allowedDomains },
        log: (m) => logger.info(`monad: ${m}`)
      });
      process.on('exit', () => proxy.stop());
      configureSandboxNet({ allowProxyPort: proxy.port });
      configureSandboxProxyEnv({
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url
      });
      logger.info(
        `monad: egress filtered via local proxy :${proxy.port} (${cfg.agent.sandbox.allowedDomains.length} domain(s) allowed)`
      );
    } else {
      configureSandboxNet(cfg.agent.sandbox.net);
      configureSandboxProxyEnv(undefined);
    }
  } else {
    configureSandboxLauncher(noneLauncher);
    configureSandboxProxyEnv(undefined);
  }
  configureHostExec(cfg.agent.sandbox.hostExec);
  if (Object.keys(cfg.agent.sandbox.env).length > 0) {
    configureSandboxExtraEnv(cfg.agent.sandbox.env);
    logger.info(`monad: sandbox extra env: ${Object.keys(cfg.agent.sandbox.env).join(', ')}`);
  }

  // Ephemeral sandbox mode: each session gets a fresh disposable root. Reclaim any left by a prior
  // crash before serving (sessions recreate theirs on demand).
  const sessionSandbox = createSessionSandboxService({
    enabled: effectiveSandboxMode === 'ephemeral',
    baseDir: join(paths.cache, 'sandboxes'),
    seedTemplate: cfg.agent.sandbox.seedTemplate,
    initScript: cfg.agent.sandbox.initScript,
    log: (m) => logger.info(`monad: ${m}`)
  });
  if (sessionSandbox.enabled) {
    await sessionSandbox.sweep(store.listSessions().map((s) => s.id));
    logger.info('monad: ephemeral sandbox mode — each session runs in a disposable root');
  }

  return { effectiveSandboxMode, sandboxRoots, sessionSandbox };
}

/**
 * Select and wire the OS launcher AFTER the atom packs have registered their sandbox launchers into
 * the registry. Split from createSandbox because the built-in launchers (Seatbelt/Landlock/…) now
 * arrive as `sandbox` atoms through the atom-pack loader, which runs later than createSandbox — and
 * a discovered third-party/cloud launcher must be a candidate too. The launcher is consumed lazily
 * by sandboxedSpawn at tool-run time, so configuring it here (post atom-load, pre-serving) is in time.
 */
export function finalizeSandboxLauncher(cfg: MonadConfig): void {
  if (!cfg.agent.sandbox.confine) return; // createSandbox already set noneLauncher

  const launcher = selectSandboxLauncher();
  configureSandboxLauncher(launcher);
  const net = cfg.agent.sandbox.net;

  if (launcher.kind === 'none') {
    // Fail closed: running unconfined under confine=true is a silent privilege-escalation path —
    // tool approval gates "whether to run" but not "as whom". Refuse to start unless the operator
    // has explicitly acknowledged this by setting agent.sandbox.allowUnconfinedExec=true.
    if (!cfg.agent.sandbox.allowUnconfinedExec) {
      throw new Error(
        `monad: agent.sandbox.confine=true but no sandbox launcher is available for ${process.platform}.\n` +
          'Install a sandbox launcher atom (e.g. monad-sandbox-seatbelt on macOS) or set\n' +
          '  agent.sandbox.launcherPath in config.json to point at a custom launcher.\n' +
          'If you intentionally want children to run unconfined on the host, set\n' +
          '  agent.sandbox.allowUnconfinedExec=true in config.json.'
      );
    }
    logger.warn(
      `monad: sandbox confinement enabled but no launcher available for ${process.platform} — ` +
        'children run UNCONFINED on the host (allowUnconfinedExec=true). ' +
        'Install a launcher atom to restore confinement.'
    );
    return;
  }

  logger.info(`monad: sandbox confinement on (${launcher.kind}, net=${net})`);
  // Be honest about per-launcher enforcement gaps, derived from the launcher's DECLARED enforcement
  // (launcher.enforces) rather than hardcoded kinds — a new launcher describes its own containment,
  // so this warns correctly without a code change. Only Seatbelt (macOS) enforces credential
  // read-deny and every net mode today.
  const enforces = launcher.enforces ?? {};
  if (!enforces.readDeny) {
    logger.warn(
      `monad: ${launcher.kind} sandbox restricts writes but does NOT block reads of credential dirs (~/.ssh, ~/.aws, …).${netAdvisory(net, enforces.net ?? [])}`
    );
  }
}

// Whether/how the launcher enforces the configured net mode at its OWN layer, for the boot-time
// honesty warning: '' when nothing extra needs saying, otherwise the gap (advisory-only, or
// proxy-bypassable). enforcedNets is the launcher's declared enforces.net.
function netAdvisory(net: 'none' | 'filtered' | 'unrestricted', enforcedNets: readonly string[]): string {
  if (net === 'unrestricted') return '';
  if (enforcedNets.includes(net)) return net === 'none' ? ' egress is blocked in-kernel (net:none).' : '';
  if (net === 'filtered') return ' net:filtered relies on the egress proxy — a raw socket from the child bypasses it.';
  return ` net:${net} is advisory — the launcher does not enforce it.`;
}

function resolveSandboxRoots(mode: SandboxMode, workspacePath: string): string[] | undefined {
  if (mode === 'workspace') return [workspacePath];
  if (mode === 'home') return [homedir()];
  // ephemeral resolves to a per-session root injected at run time; the workspace is the safe
  // global fallback for anything not run inside a session.
  if (mode === 'ephemeral') return [workspacePath];
  return undefined; // unrestricted
}
