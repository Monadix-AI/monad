// Boot phase: OS-level confinement for spawned children (code_execute/shell_exec/process_start) plus
// the ephemeral per-session sandbox service. Reads cfg + paths, applies the process-wide sandbox
// policy as a side effect, and returns the three products the rest of startDaemon consumes.

import type { MonadAuth, MonadConfig, MonadPaths, SandboxMode } from '@monad/environment';
import type { ProtectedCredentialResolution } from '@monad/sandbox';
import type { Store } from '#/store/db/index.ts';
import type { SessionSandboxService } from '../../services/session-sandbox.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentCredentialVaultDenyRoots, emptyAuth } from '@monad/environment';
import { logger } from '@monad/logger';
import {
  caTrustEnv,
  configureNativeLauncherPath,
  configureSandboxProcessTracker,
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
  prepareSandboxHost,
  startEgressProxy
} from '@monad/sandbox';

import {
  configureHostExec,
  configureSandboxBackendOptions,
  configureSandboxExtraEnv,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxProxyEnv,
  configureSandboxReadDeny,
  noneLauncher,
  selectSandboxLauncher
} from '#/capabilities/tools';
import { resolveEffectiveSandboxMode } from '#/config/resolve.ts';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';
import { prepareSandboxCandidate } from '#/platform/sandbox/activation.ts';
import { createSessionSandboxService } from '../../services/session-sandbox.ts';

export interface SandboxSetup {
  effectiveSandboxMode: SandboxMode;
  sandboxRoots: string[] | undefined;
  sessionSandbox: SessionSandboxService;
}

export async function createSandbox(
  cfg: MonadConfig,
  paths: MonadPaths,
  store: Store,
  _auth: MonadAuth = emptyAuth()
): Promise<SandboxSetup> {
  const effectiveSandboxMode = resolveEffectiveSandboxMode(cfg.sandbox, cfg.agent.globalSandbox);
  const sandboxRoots = resolveSandboxRoots(effectiveSandboxMode, paths.workspace);

  // @monad/sandbox is daemon-agnostic; inject the daemon's process-tree reaper so confined children are
  // tracked for shutdown. Tree-kill by pid is the daemon's concern; the sandbox supplies a SIGTERM
  // fallback for the untracked/standalone case.
  configureSandboxProcessTracker({
    track: (pid, label, fallbackKill) =>
      daemonChildProcesses.track(pid, label, () => (pid ? killDaemonProcessTree(pid) : fallbackKill())),
    untrack: (pid) => daemonChildProcesses.untrack(pid)
  });

  // Backend options for a heavy launcher (docker/e2b), passed via the seam so the daemon never
  // imports the opt-in launcher package. The heavy launcher reads these at spawn time; the docker
  // runtime probe now runs via the SELECTED launcher's prepare() in finalizeSandboxLauncher().
  configureSandboxBackendOptions({ dockerImage: cfg.sandbox.dockerImage });

  // Prepare host-level sandbox resources before selection. Best-effort and unconditional so a
  // config change cannot strand resources from a prior confined run. Currently Windows reclaims
  // orphaned AppContainer profiles; other host platforms no-op.
  void prepareSandboxHost();
  const home = homedir();
  configureSandboxReadDeny([
    ...agentCredentialVaultDenyRoots(paths),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.config', 'gcloud')
  ]);

  if (cfg.sandbox.confine) {
    // The override path for the native Linux/Windows launcher binary (config.sandbox.launcherPath)
    // must reach the launcher atoms before selection probes their isAvailable(); push it now (the
    // launchers are static atom objects that read it lazily). The actual launcher is selected after
    // the atom packs load — see finalizeSandboxLauncher().
    configureNativeLauncherPath(cfg.sandbox.launcherPath);
    // Deny confined children read access to credential stores even under open egress, so a
    // prompt-injected snippet can't read-then-exfiltrate secrets. The profile is allow-read by
    // default (interpreters must start); only these roots are blocked.
    if (cfg.sandbox.net === 'filtered') {
      // Start the local filtering proxy and make it the child's only egress: the policy permits
      // just the proxy port and HTTP(S)_PROXY routes the child's curl/pip/npm/git through it.
      // When tlsTerminate is enabled, the proxy also decrypts HTTPS with an ephemeral (or supplied)
      // MITM CA; the child trusts it via the injected caTrustEnv, and the proxy→server leg keeps
      // real cert validation. Off → HTTPS stays an opaque CONNECT tunnel (unchanged behavior).
      let mitm: MitmCA | undefined;
      if (cfg.sandbox.tlsTerminate.enabled) {
        const ca = createMitmCA({
          caCertPath: cfg.sandbox.tlsTerminate.caCertPath,
          caKeyPath: cfg.sandbox.tlsTerminate.caKeyPath
        });
        mitm = ca;
        process.on('exit', () => void disposeMitmCA(ca));
      }

      const proxy = startEgressProxy({
        policy: {
          allowedDomains: cfg.sandbox.allowedDomains,
          deniedDomains: cfg.sandbox.deniedDomains
        },
        mitm,
        log: (m) => logger.info(`monad: ${m}`)
      });
      process.on('exit', () => proxy.stop());
      configureSandboxNet({ allowProxyPort: proxy.port });
      // SOCKS5 shares the SAME muxed proxy port; the child's non-HTTP TCP tools (ssh, git-ssh, db
      // clients) that honour ALL_PROXY route through the same egress filter. socks5h = the proxy
      // resolves DNS, so the child's hostname reaches our allowlist, not a pre-resolved IP.
      const socksUrl = `socks5h://127.0.0.1:${proxy.port}`;
      configureSandboxProxyEnv({
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url,
        ALL_PROXY: socksUrl,
        all_proxy: socksUrl,
        // Trust env applies to the CONFINED CHILD only (this map is injected into child spawns via
        // configureSandboxProxyEnv); the daemon/host trust store is never touched.
        ...(mitm ? caTrustEnv(mitm.caCertPath) : {})
      });
      logger.info(
        `monad: egress filtered via local proxy :${proxy.port} (allowedDomains=${cfg.sandbox.allowedDomains.length})` +
          (mitm ? ' — TLS termination on' : '')
      );
    } else {
      configureSandboxNet(cfg.sandbox.net);
      configureSandboxProxyEnv(undefined);
    }
  } else {
    configureSandboxLauncher(noneLauncher);
    configureSandboxProxyEnv(undefined);
  }
  configureHostExec(cfg.sandbox.hostExec);
  if (Object.keys(cfg.sandbox.env).length > 0) {
    configureSandboxExtraEnv(cfg.sandbox.env);
    logger.info(`monad: sandbox extra env: ${Object.keys(cfg.sandbox.env).join(', ')}`);
  }

  // Ephemeral sandbox mode: each session gets a fresh disposable root. Reclaim any left by a prior
  // crash before serving (sessions recreate theirs on demand).
  const sessionSandbox = createSessionSandboxService({
    enabled: effectiveSandboxMode === 'ephemeral',
    baseDir: join(paths.cache, 'sandboxes'),
    seedTemplate: cfg.sandbox.seedTemplate,
    initScript: cfg.sandbox.initScript,
    log: (m) => logger.info(`monad: ${m}`)
  });
  if (sessionSandbox.enabled) {
    await sessionSandbox.sweep([
      ...store.listSessions().map((s) => s.id),
      ...store.listWorkplaceProjects().map((p) => p.id)
    ]);
    logger.info('monad: ephemeral sandbox mode — each session runs in a disposable root');
  }

  return { effectiveSandboxMode, sandboxRoots, sessionSandbox };
}

function resolveGrantedCredentials(snapshot: { cfg: MonadConfig; auth: MonadAuth }, agentId: string) {
  const agent = snapshot.cfg.agent.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.credentialIds.length === 0) return Object.freeze([]);
  const credentials = agent.credentialIds.map((credentialId) => {
    const credential = snapshot.auth.credentials[credentialId];
    if (!credential?.secret) throw new Error('protected_execution_unavailable');
    return Object.freeze({
      environmentVariable: credential.environmentVariable,
      secret: credential.secret,
      allowedHosts: Object.freeze([...credential.allowedHosts])
    });
  });
  return Object.freeze(credentials);
}

export function resolveProtectedCredentialResolution(
  snapshot: { cfg: MonadConfig; auth: MonadAuth },
  agentId: string | undefined
): ProtectedCredentialResolution {
  return {
    credentials: agentId ? resolveGrantedCredentials(snapshot, agentId) : Object.freeze([]),
    credentialVaultContainsSecrets: Object.values(snapshot.auth.credentials).some((credential) =>
      Boolean(credential.secret)
    )
  };
}

/**
 * Select and wire the OS launcher AFTER the atom packs have registered their sandbox launchers into
 * the registry. Split from createSandbox because the built-in launchers (Seatbelt/Landlock/…) now
 * arrive as `sandbox` atoms through the atom-pack loader, which runs later than createSandbox — and
 * a discovered third-party/cloud launcher must be a candidate too. The launcher is consumed lazily
 * by sandboxedSpawn at tool-run time, so configuring it here (post atom-load, pre-serving) is in time.
 */
export async function finalizeSandboxLauncher(
  cfg: MonadConfig,
  platform: NodeJS.Platform = process.platform,
  paths?: MonadPaths,
  auth = emptyAuth()
): Promise<void> {
  if (!cfg.sandbox.confine) return; // createSandbox already set noneLauncher

  const requestedRef = cfg.sandbox.activeBackend;
  let launcher = selectSandboxLauncher(platform, requestedRef);
  if (requestedRef.source === 'builtin' && requestedRef.kind === 'vm' && launcher.kind === 'vm') {
    await configureVmBackendFromConfig(cfg, paths);
  }
  try {
    await prepareSandboxCandidate(requestedRef, launcher, { cfg, auth });
  } catch (error) {
    logger.warn(
      `monad: sandbox backend "${requestedRef.source}:${requestedRef.kind}" could not activate ` +
        `(${error instanceof Error ? error.message : String(error)}) — falling back to built-in auto.`
    );
    const fallbackRef = { source: 'builtin', kind: 'auto' } as const;
    launcher = selectSandboxLauncher(platform, fallbackRef);
    if (launcher.kind !== 'none') await prepareSandboxCandidate(fallbackRef, launcher, { cfg, auth });
  }
  configureSandboxLauncher(launcher);
  const net = cfg.sandbox.net;

  if (launcher.kind === 'none') {
    // Fail closed: running unconfined under confine=true is a silent privilege-escalation path —
    // tool approval gates "whether to run" but not "as whom". Refuse to start unless the operator
    // has explicitly acknowledged this by setting agent.sandbox.allowUnconfinedExec=true.
    if (!cfg.sandbox.allowUnconfinedExec) {
      throw new Error(
        `monad: agent.sandbox.confine=true but no sandbox launcher confines ${process.platform}.\n` +
          '  On Linux this usually means the native launcher binary is missing — install bubblewrap\n' +
          '  (bwrap) or point agent.sandbox.launcherPath at the monad-sandbox-launcher build.\n' +
          'If you intentionally want children to run unconfined on the host, set\n' +
          '  agent.sandbox.allowUnconfinedExec=true in config.json.'
      );
    }
    logger.warn(
      `monad: sandbox confinement enabled but no launcher available for ${process.platform} — ` +
        'children run UNCONFINED on the host (allowUnconfinedExec=true). ' +
        'Install bubblewrap or supply agent.sandbox.launcherPath to restore confinement.'
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

async function configureVmBackendFromConfig(cfg: MonadConfig, paths?: MonadPaths): Promise<void> {
  const vm = cfg.sandbox.vm;
  const { configureVmBackend, configureVmToolchain } = await import('@monad/sandbox-vm');
  configureVmToolchain({
    vmDir: paths ? join(paths.home, 'vm') : undefined,
    vfkitPath: vm?.vfkitPath,
    gvproxyPath: vm?.gvproxyPath,
    winvmHelperPath: vm?.winvmHelperPath
  });
  configureVmBackend({
    scope: vm?.scope ?? 'agent',
    idleTtlMs: vm?.idleTtlMs ?? 600_000,
    maxInstances: vm?.maxInstances ?? 8,
    cpus: vm?.cpus ?? 2,
    memoryMiB: vm?.memory ?? 2048,
    baseline: vm?.baseline ?? { enabled: false, maxInactiveArtifacts: 4, maxBytes: 32 * 1024 * 1024 * 1024 },
    imageConsent: async ({ url, sha256, dest }) => {
      logger.warn(
        `monad: the VM backend needs its guest image (first use of backend:"vm").\n` +
          `  source: ${url}\n  sha256: ${sha256}\n  dest:   ${dest}\n` +
          '  Downloading now — set agent.sandbox.backend back to "auto" to skip.'
      );
      return true;
    }
  });
}
