// Boot phase (terminal): build the HTTP transport and start listening — TCP (+ TLS when configured)
// and a permission-gated Unix socket, or stdio in --stdio mode — then print the ready banner, wire
// graceful-shutdown signals, and connect channels. No outputs: this is where startDaemon ends and
// the daemon begins serving.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { NetworkRuntimeStatus } from '@monad/protocol';
import type { TlsSetup } from '#/bootstrap/tls.ts';
import type { ChannelService } from '#/channels/channel.ts';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { ConfigBus } from '#/services/config-bus.ts';
import type { I18nService } from '#/services/i18n.ts';
import type { MutableRemoteAccessState } from '#/transports/http.ts';

import { chmod, unlink } from 'node:fs/promises';
import { resolveDaemonNetwork, validateDaemonNetworkSecurity } from '@monad/home';
import { logger } from '@monad/logger';
import { MONAD_VERSION } from '@monad/protocol';
import { Elysia } from 'elysia';

import { createMoModule } from '#/handlers/mo/handlers.ts';
import { printBanner, printGoodbye, printReadyInfo } from '#/infra/banner.ts';
import { shutdownBus } from '#/infra/shutdown-bus.ts';
import { MoService } from '#/services/mo.ts';
import { createMoController } from '#/transports/http/mo/controller.ts';
import { startStdioTransport } from '#/transports/stdio.ts';
import { createHttpTransport, createRemoteAccessState } from '../transports/http.ts';

// Cap buffered request bodies. The largest legitimate body is a sendMessage whose text is bounded
// by MESSAGE_TEXT_MAX (1 MiB) plus JSON envelope/escaping overhead; 4 MiB leaves headroom while
// preventing memory-exhaustion DoS from oversized POSTs (the body is buffered before any schema
// .max() can reject it).
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

interface DaemonTcpListenOptions {
  hostname: string;
  port: number;
  maxRequestBodySize: number;
  tls?: {
    key: Blob;
    cert: Blob;
  };
  http3?: true;
}

export function buildDaemonTcpListenOptions(args: {
  host: string;
  port: number;
  tlsCert?: { certPath: string; keyPath: string };
}): DaemonTcpListenOptions {
  return {
    hostname: args.host,
    port: args.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    ...(args.tlsCert
      ? {
          tls: { key: Bun.file(args.tlsCert.keyPath), cert: Bun.file(args.tlsCert.certPath) },
          http3: true as const
        }
      : {})
  };
}

export interface ServeDeps {
  handlers: ReturnType<typeof createDaemonHandlers>;
  paths: MonadPaths;
  host: string;
  port: number;
  https: MonadConfig['network']['https'];
  remoteAccess: MonadConfig['network']['remoteAccess'];
  localHttpFallback: MonadConfig['network']['localHttpFallback'];
  moBinaryPath?: string;
  /** Whether to auto-launch Mo on startup (config.json `mo.enabled`, default on). */
  moEnabled: boolean;
  /** Persist the Mo on/off choice so the start/stop toggle survives a daemon restart. */
  setMoEnabled: (enabled: boolean) => Promise<void>;
  tlsCert?: { certPath: string; keyPath: string };
  tlsFingerprint?: string;
  resolveTlsSetupForNetwork?: (https: MonadConfig['network']['https']) => Promise<TlsSetup>;
  developerMode: boolean | (() => boolean);
  i18n: I18nService;
  channelService: ChannelService;
  configBus?: ConfigBus;
  onNetworkRuntimeStatusReady?: (status: () => NetworkRuntimeStatus) => void;
  flags: { devMode: boolean; devSilent: boolean; stdoutRpc: boolean; stdioMode: boolean; useMock: boolean };
  beforeListen?: (app: ReturnType<typeof createHttpTransport>) => void;
  openaiCompatConfig?: () => Promise<{ enabled: boolean; token?: string }>;
}

export type TcpListenerPlan = { scheme: 'https' | 'http'; host: string; port: number };
type TcpServer = { stop(force?: boolean): void };

export interface DaemonTcpRuntimeConfig {
  host: string;
  https: MonadConfig['network']['https'];
  remoteAccess: MonadConfig['network']['remoteAccess'];
  port: number;
  localHttpFallback: MonadConfig['network']['localHttpFallback'];
  tlsCert?: { certPath: string; keyPath: string };
}

function hostForUrl(host: string): string {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  return displayHost.includes(':') && !displayHost.startsWith('[') ? `[${displayHost}]` : displayHost;
}

export function formatHttpsDisabledWarnings(opts: { remoteAccessEnabled: boolean }): string[] {
  const warnings = ['WARNING: HTTPS is disabled by network.https.enabled=false. Daemon TCP traffic is plain HTTP.'];
  if (opts.remoteAccessEnabled) {
    warnings.push(
      'WARNING: remote access is enabled while HTTPS is disabled. Remote daemon traffic is exposed over plain HTTP.'
    );
  }
  return warnings;
}

export function daemonLoopbackUrl(opts: { https: MonadConfig['network']['https']; port: number }): string {
  return resolveDaemonNetwork({ network: { https: opts.https, port: opts.port } }).localUrl;
}

export function daemonWebUiUrl(opts: {
  dev: boolean;
  host: string;
  https: MonadConfig['network']['https'];
  port: number;
  webPort?: string;
}): string {
  const scheme = opts.https.enabled ? 'https' : 'http';
  if (opts.dev && opts.webPort) return `${scheme}://localhost:${opts.webPort}`;
  return `${scheme}://${hostForUrl(opts.host)}:${opts.port}/`;
}

export function shouldEnableDeveloperDocs(opts: { developerMode: boolean; stdoutRpc: boolean }): boolean {
  return opts.developerMode && !opts.stdoutRpc;
}

function resolveDeveloperMode(value: boolean | (() => boolean)): boolean {
  return typeof value === 'function' ? value() : value;
}

export function resolveServeDeveloperMode(opts: {
  configured: boolean;
  devMode: boolean;
  devSilent: boolean;
}): boolean {
  return opts.configured || opts.devMode || opts.devSilent;
}

function isSupervisedDaemon(): boolean {
  const pid = Number.parseInt(Bun.env.MONAD_SUPERVISOR_PID ?? '', 10);
  return Number.isInteger(pid) && pid > 0;
}

export function planTcpListeners(opts: {
  host: string;
  https: MonadConfig['network']['https'];
  remoteAccess: MonadConfig['network']['remoteAccess'];
  port: number;
  localHttpFallback: MonadConfig['network']['localHttpFallback'];
}): TcpListenerPlan[] {
  validateDaemonNetworkSecurity({ host: opts.host, https: opts.https, remoteAccess: opts.remoteAccess });
  const primaryScheme = opts.https.enabled ? 'https' : 'http';
  const listeners: TcpListenerPlan[] = [{ scheme: primaryScheme, host: opts.host, port: opts.port }];
  if (opts.localHttpFallback.enabled) {
    listeners.push({ scheme: 'http', host: '127.0.0.1', port: opts.localHttpFallback.port });
  }
  return listeners;
}

function listenerKey(listener: TcpListenerPlan): string {
  return `${listener.scheme}:${listener.host}:${listener.port}`;
}

function sameListenerPlan(a: TcpListenerPlan[], b: TcpListenerPlan[]): boolean {
  return (
    a.length === b.length && a.every((listener, i) => listenerKey(listener) === listenerKey(b[i] as TcpListenerPlan))
  );
}

function stopTcpServers(servers: TcpServer[]): void {
  for (const server of servers) server.stop(true);
}

export function createDaemonTcpRuntime(opts: {
  app: ReturnType<typeof createHttpTransport>;
  initial: DaemonTcpRuntimeConfig;
  remoteAccessState?: MutableRemoteAccessState;
  listenHttps?: (
    app: ReturnType<typeof createHttpTransport>,
    listener: TcpListenerPlan,
    config: DaemonTcpRuntimeConfig
  ) => TcpServer;
  listenHttp?: (
    app: ReturnType<typeof createHttpTransport>,
    listener: TcpListenerPlan,
    config: DaemonTcpRuntimeConfig
  ) => TcpServer;
}) {
  const remoteAccessState = opts.remoteAccessState;
  const listenHttps =
    opts.listenHttps ??
    ((app, listener, config) => {
      if (!config.tlsCert) throw new Error('monad: internal error — HTTPS listener requires a TLS certificate');
      const live = app.listen(
        buildDaemonTcpListenOptions({
          host: listener.host,
          port: listener.port,
          tlsCert: config.tlsCert
        }) as Parameters<typeof app.listen>[0]
      ) as unknown as { server?: TcpServer };
      if (!live.server) throw new Error('monad: HTTPS listener did not expose a server handle');
      return live.server;
    });
  const listenHttp =
    opts.listenHttp ??
    ((app, listener) =>
      Bun.serve({
        ...buildDaemonTcpListenOptions({ host: listener.host, port: listener.port }),
        fetch: (req: Request) => app.handle(req)
      } as Parameters<typeof Bun.serve>[0]));

  let config = opts.initial;
  let listeners = planTcpListeners(config);
  let servers: TcpServer[] = [];
  let lastAppliedAt: string | undefined;
  let lastError: NetworkRuntimeStatus['lastError'];

  const status = (): NetworkRuntimeStatus => ({
    listeners,
    remoteAccess: {
      enabled: remoteAccessState?.current()?.enabled ?? config.remoteAccess.enabled,
      tokenRevision: remoteAccessState?.tokenRevision() ?? 0
    },
    ...(lastAppliedAt ? { lastAppliedAt } : {}),
    ...(lastError ? { lastError } : {})
  });

  const start = (next: DaemonTcpRuntimeConfig): { listeners: TcpListenerPlan[]; servers: TcpServer[] } => {
    const nextListeners = planTcpListeners(next);
    const nextServers: TcpServer[] = [];
    try {
      for (const listener of nextListeners) {
        nextServers.push(
          listener.scheme === 'https' ? listenHttps(opts.app, listener, next) : listenHttp(opts.app, listener, next)
        );
      }
      return { listeners: nextListeners, servers: nextServers };
    } catch (err) {
      stopTcpServers(nextServers);
      throw err;
    }
  };

  const initial = start(config);
  listeners = initial.listeners;
  servers = initial.servers;
  remoteAccessState?.set(config.remoteAccess);
  lastAppliedAt = new Date().toISOString();

  return {
    listeners: () => listeners,
    status,
    async apply(next: DaemonTcpRuntimeConfig): Promise<void> {
      const nextListeners = planTcpListeners(next);
      remoteAccessState?.set(next.remoteAccess);
      if (sameListenerPlan(listeners, nextListeners)) {
        config = next;
        listeners = nextListeners;
        lastAppliedAt = new Date().toISOString();
        lastError = undefined;
        return;
      }

      const previousConfig = config;
      const previousListeners = listeners;
      const previousServers = servers;
      stopTcpServers(previousServers);
      try {
        const started = start(next);
        config = next;
        listeners = started.listeners;
        servers = started.servers;
        lastAppliedAt = new Date().toISOString();
        lastError = undefined;
      } catch (err) {
        lastError = { at: new Date().toISOString(), message: err instanceof Error ? err.message : String(err) };
        remoteAccessState?.set(previousConfig.remoteAccess);
        const restored = start(previousConfig);
        config = previousConfig;
        listeners = previousListeners;
        servers = restored.servers;
        throw err;
      }
    },
    stop(): void {
      stopTcpServers(servers);
      servers = [];
      listeners = [];
    }
  };
}

export async function serveDaemon(deps: ServeDeps): Promise<void> {
  const {
    handlers,
    paths,
    host,
    port,
    https,
    remoteAccess,
    localHttpFallback,
    moBinaryPath,
    moEnabled,
    setMoEnabled,
    tlsCert,
    tlsFingerprint,
    developerMode,
    i18n,
    channelService,
    configBus,
    onNetworkRuntimeStatusReady,
    flags,
    openaiCompatConfig
  } = deps;
  const { devMode, devSilent, stdoutRpc, stdioMode, useMock } = flags;

  const liveDeveloperMode = () =>
    resolveServeDeveloperMode({ configured: resolveDeveloperMode(developerMode), devMode, devSilent });
  const activeDeveloperMode = liveDeveloperMode();
  const developerDocs = shouldEnableDeveloperDocs({ developerMode: activeDeveloperMode, stdoutRpc });

  const remoteAccessState = createRemoteAccessState(remoteAccess);
  const httpApp = createHttpTransport(handlers, {
    docs: developerDocs,
    developerMode: liveDeveloperMode,
    remoteAccess: remoteAccessState,
    openaiCompatConfig
  });

  // Mo (the desktop sprite) is launched/quit through the daemon and dies with it: the exit handler
  // runs on the same process.exit(0) that gracefulShutdown triggers for SIGINT/SIGTERM below.
  // Its routes are mounted on the app INSTANCE here (not inside createHttpTransport) so they never
  // enter its return type. This is deliberate on two counts, re-confirmed against the current
  // tsc-declarations baseline: (1) /v1/mo/{launch,quit,drop,status} are imperative daemon-control
  // RPCs from the settings panel, not data resources the web subscribes to — they belong outside
  // the typed Eden treaty and are called via plain fetch by design; (2) that treaty is inferred from
  // createHttpTransport's return type and sits near TS's instantiation ceiling, so folding one more
  // route group back in risks degrading every endpoint's types. Cast to bare Elysia so this .use
  // stays a runtime-only mutation (routes still serve on TCP + unix).
  // config.json `mo.binaryPath` overrides; otherwise auto-locate the bundled Mo. `||` (not `??`) so
  // an empty string in config doesn't suppress auto-location.
  const moService = new MoService(
    moBinaryPath?.trim() || MoService.bundledPath(),
    paths.sock,
    port,
    https.enabled ? 'https' : 'http'
  );
  process.on('exit', () => moService.stop());
  // Web UI URL Mo opens when clicked (also printed in the ready banner below): in dev, the separate
  // Next server on WEB_PORT; otherwise the daemon serves the SPA at its own origin.
  const isDev = devMode || devSilent;
  const webUiUrl = daemonWebUiUrl({ dev: isDev, host, https, port, webPort: Bun.env.WEB_PORT });
  (httpApp as unknown as Elysia).use(
    createMoController(createMoModule(handlers.session, moService, webUiUrl, setMoEnabled))
  );

  deps.beforeListen?.(httpApp);

  const sockPath = paths.sock;

  if (stdioMode) {
    process.stderr.write('monad daemon: stdio mode\n');
    await startStdioTransport(handlers);
    return;
  }

  const tcpRuntime = createDaemonTcpRuntime({
    app: httpApp,
    remoteAccessState,
    initial: { host, https, remoteAccess, port, localHttpFallback, tlsCert }
  });
  onNetworkRuntimeStatusReady?.(() => tcpRuntime.status());
  process.on('exit', () => {
    tcpRuntime.stop();
  });
  configBus?.subscribe(async ({ cfg }) => {
    const endpoint = resolveDaemonNetwork({ network: cfg.network, env: Bun.env });
    const nextTlsSetup = deps.resolveTlsSetupForNetwork
      ? await deps.resolveTlsSetupForNetwork(cfg.network.https)
      : { cert: tlsCert, warnings: [] };
    await tcpRuntime.apply({
      host: endpoint.bindHost,
      port: endpoint.port,
      https: cfg.network.https,
      remoteAccess: cfg.network.remoteAccess,
      localHttpFallback: {
        enabled: cfg.network.localHttpFallback.enabled,
        port: endpoint.localHttpFallback?.port ?? cfg.network.localHttpFallback.port
      },
      tlsCert: nextTlsSetup.cert
    });
  });

  // Same Elysia app, second listener on a Unix domain socket. Local clients (the CLI) reach the daemon
  // through it for lower latency than TCP loopback and filesystem-gated access — no port, no bearer
  // token. WS push (/v1/stream) stays TCP-only: Bun's WebSocket client can't dial a Unix socket.
  // Bun supports AF_UNIX on every platform monad targets — including Windows (native since Win10 1803).
  // Binding is best-effort: if it fails (an older OS/Bun, or a locked-down environment) the daemon
  // keeps serving on TCP and stays fully reachable — clients fall back to TCP at connect time.
  let unixBound = false;
  try {
    await unlink(sockPath).catch(() => {}); // remove stale socket from a previous run
    const unixServer = Bun.serve({
      unix: sockPath,
      fetch: (req: Request) => httpApp.handle(req),
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      // Elysia's own Bun adapter defaults idleTimeout to 30s for the TCP listener above; Bun.serve's
      // own default is 10s. Match it here so a slow-but-legitimate request (e.g. the 20s external agent
      // auth-status probe) doesn't get killed over the Unix socket while it succeeds over TCP.
      // bun-types omits `idleTimeout` from the unix-socket overload even though the runtime honors it
      // (verified: a 15s handler completes fine with this set) — cast around the type gap.
      idleTimeout: 30
    } as unknown as Parameters<typeof Bun.serve>[0]);
    // Register teardown and mark bound BEFORE anything else that could throw — a live listener must
    // never be left un-torn-down (and unadvertised) by a later failure.
    process.on('exit', () => {
      unixServer.stop(true);
    });
    unixBound = true;
    // The socket grants unauthenticated RPC to anyone who can connect() — its perms are its auth.
    // POSIX: chmod 0600 locks it to the owner. Windows: chmod is a no-op, so access is bounded by the
    // NTFS ACL of the per-user ~/.monad runtime dir; browsers can't reach AF_UNIX on any platform.
    await chmod(sockPath, 0o600).catch(() => {});
  } catch (err) {
    logger.info(
      `monad: Unix socket unavailable (${err instanceof Error ? err.message : String(err)}) — serving TCP only`
    );
  }

  // Mo enabled (default on, or the persisted toggle): launch the sprite now that the socket it
  // connects to is up. Best-effort — a missing binary (Mo not built / unsupported platform) just
  // logs; it never blocks daemon startup. isRunning() re-adopts a Mo that outlived a prior daemon.
  if (moEnabled) {
    void moService.launch().then((r) => {
      if (!r.ok) logger.info(`monad: Mo not launched — ${r.error}`);
    });
  }

  const mockTag = useMock ? ' (mock model)' : '';
  const primaryScheme = https.enabled ? 'https' : 'http';
  const daemonUrl = `${primaryScheme}://${hostForUrl(host)}:${port}`;
  const docsUrl = developerDocs ? `${daemonUrl}/docs` : undefined;
  const docsTag = developerDocs ? ` docs:${docsUrl}` : '';
  // Only advertise the Unix socket when it was actually bound — listing `unix:<path>` when the bind
  // was skipped/failed would be misleading (no listener exists at that path).
  const unixTag = unixBound ? ` unix:${sockPath}` : '';
  const fallbackTag = localHttpFallback.enabled ? ` local-http:http://127.0.0.1:${localHttpFallback.port}` : '';
  printBanner(MONAD_VERSION, useMock);
  if (!https.enabled) {
    const warnings = formatHttpsDisabledWarnings({ remoteAccessEnabled: remoteAccess.enabled });
    process.stdout.write(`\n${warnings.join('\n')}\n\n`);
    for (const warning of warnings) logger.warn(warning);
  }
  logger.debug(
    `monad daemon listening on ${primaryScheme}://${host}:${port}${fallbackTag}${unixTag}${mockTag}${docsTag}`
  );
  if (tlsFingerprint) {
    logger.debug(`monad: TLS cert SHA-256 fingerprint: ${tlsFingerprint}`);
  }

  // The success/environment summary is owned by the daemon (single source of truth) so `monad
  // start`, a manual `monad daemon`, and the installer all show identical info. `monad start`
  // launches us detached and relays this stdout to the user until we're reachable.
  printReadyInfo({
    webUrl: webUiUrl,
    daemonUrl,
    docsUrl,
    unixSocket: unixBound ? sockPath : undefined,
    tlsFingerprint,
    configPath: paths.config,
    t: i18n.t
  });

  // Graceful shutdown. process.exit(0) synchronously runs every process.on('exit') handler
  // registered above — that is what kills spawned MCP child processes (conn.close → proc.kill
  // fires synchronously), stops the unix servers, and disposes timers. Idempotent: a second
  // signal during teardown is ignored.
  let shuttingDown = false;
  const gracefulShutdown = (farewell: boolean): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (farewell) printGoodbye();
    process.exit(0);
  };
  // Expose graceful shutdown to the HTTP layer (used by POST /v1/daemon/stop on Windows, where
  // SIGTERM cannot be caught on a detached process). Must be registered before the signal handlers
  // below so the HTTP route is ready the instant the daemon starts accepting connections.
  shutdownBus.register(() => gracefulShutdown(false));

  // SIGINT (Ctrl-C in a terminal `monad daemon`, all platforms) prints the farewell banner.
  process.once('SIGINT', () => gracefulShutdown(true));
  // SIGTERM (`monad stop` on Unix) skips the banner — the CLI prints Goodbye on its TTY instead,
  // since the daemon runs detached without a TTY and its stdout has no reader. Per the Node docs
  // SIGTERM "is not supported on Windows" (never OS-generated; process.kill SIGTERM = hard kill),
  // so this handler only ever fires on Unix.
  process.once('SIGTERM', () => gracefulShutdown(false));
  // Windows-relevant console signals (Node docs): SIGBREAK fires on Ctrl+Break, SIGHUP when the
  // console window is closed. These only reach the daemon when it owns an attached console (a
  // foreground `monad daemon`), NOT the detached `monad start` background process — there is no
  // way to send a catchable signal to a detached process on Windows. SIGHUP also covers a closed
  // controlling terminal on Unix; when supervised, ignore it so the launcher shell closing does not
  // stop the background daemon.
  process.once('SIGBREAK', () => gracefulShutdown(false));
  if (!isSupervisedDaemon()) process.once('SIGHUP', () => gracefulShutdown(false));

  // Connect channels after the banner so startup noise doesn't precede the "ready" signal.
  // Non-fatal per-channel (start() already swallows individual errors); run detached so a slow IM
  // handshake never delays the daemon becoming usable.
  if (!useMock) {
    process.on('exit', () => void channelService.stop());
    // `bun --hot` re-evaluates this module on every source change WITHOUT exiting the process, so
    // process.on('exit') never fires and the previous evaluation's channel poll loops are never
    // aborted. For Telegram that means a second getUpdates long-poll on the same token → permanent
    // "Conflict: terminated by other getUpdates request". Abort the old channels before the module
    // is swapped so exactly one poll loop runs at a time. (No-op in prod: the production `start`
    // script runs without --hot, so import.meta.hot is undefined.)
    const hot = (import.meta as ImportMeta & { hot?: { dispose(cb: () => void): void } }).hot;
    hot?.dispose(() => void channelService.stop());
    void channelService.start();
  }
}
