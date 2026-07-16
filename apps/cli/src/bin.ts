#!/usr/bin/env bun

import { openUrl, resolveClientConn } from '@monad/environment';
import { setLogLevel } from '@monad/logger';
import { MONAD_VERSION } from '@monad/protocol';

import { resolveUpWebUrl } from './lib/web-url.ts';

// Silence pino output for the CLI's own commands — they render their own human output and must not
// leak log lines. The `daemon` subcommand is the exception: it IS the log producer, so it keeps the
// default level (info) and manages routing itself in configureDaemonLogging(). The hidden supervisor
// keeps the CLI level silent and writes explicit lifecycle records to daemon.log. Must run before any
// logger is created — all subsystem imports below are dynamic, so nothing has materialised yet.
if (process.argv[2] !== 'daemon') {
  setLogLevel(process.argv.includes('--debug') ? 'debug' : 'silent');
}

async function dispatch(): Promise<void> {
  const sub = process.argv[2];

  if (sub === '-V' || sub === '--version') {
    process.stdout.write(`${MONAD_VERSION}\n`);
    return;
  }

  if (sub === '--daemon-child-supervisor') {
    await (await import('@monad/monad/start')).runDaemonChildSupervisorFromArgv();
    return;
  }

  if (sub === 'daemon') {
    const { attachWebRoutes } = await import('@monad/web/server');
    await (await import('@monad/monad/start')).startDaemon({ beforeListen: attachWebRoutes });
    return;
  }
  if (sub === 'daemon-supervisor') {
    await (await import('./lib/daemon.ts')).runDaemonSupervisor();
    return;
  }
  if (sub === 'web') {
    (await import('@monad/web/server')).startWeb();
    return; // Bun.serve keeps the process alive
  }
  if (sub === 'up' || sub === undefined) {
    const { baseUrl } = await resolveClientConn();
    const daemonUrl = baseUrl.replace(/\/$/, '');
    // WEB_PORT is a dev-only override (the Vite dev server runs separately). In a release build the
    // web UI is served by the daemon itself, so ignore a WEB_PORT that leaked in from a dev shell
    // (e.g. direnv in the repo). NODE_ENV is pinned to "production" at build time, so this whole
    // branch is dead-code-eliminated in the compiled binary.
    const webUrl = resolveUpWebUrl({
      daemonUrl,
      nodeEnv: Bun.env.NODE_ENV,
      webPort: Bun.env.WEB_PORT
    });

    // Ensure the daemon is up and current: startDaemon starts it when stopped and replaces a
    // stale build after an upgrade, relaying the ready banner. This is the installer's entrypoint
    // (it runs bare `monad`), so the whole start/upgrade/launch flow stays owned by monad — not
    // duplicated in install.sh. Then open the browser so first-run setup happens there.
    const { initCliI18n } = await import('./lib/i18n.ts');
    await initCliI18n();
    const { startDaemon } = await import('./lib/daemon.ts');
    await startDaemon();

    process.stdout.write(`Monad — ${webUrl}\n`);
    if (Bun.env.MONAD_NO_OPEN !== '1') openUrl(webUrl);
    // Exit naturally — do NOT process.exit(). Bun terminates a spawned child whose stdout is piped
    // to us when we hard-exit, which would kill the detached daemon we just launched; letting the
    // event loop drain releases the pipe cleanly and leaves the daemon running in the background.
    return;
  }

  await (await import('./main.ts')).main();
}

dispatch().catch(async (err: unknown) => {
  const { exitCodeFor } = await import('./commands/types.ts');
  const message = err instanceof Error ? err.message : String(err);
  if (message) process.stderr.write(`${message}\n`);
  process.exit(exitCodeFor(err));
});
