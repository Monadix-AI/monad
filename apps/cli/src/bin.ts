#!/usr/bin/env bun

import { setLogLevel } from '@monad/logger';
import { MONAD_VERSION } from '@monad/protocol';

import { resolveEntrypointSubcommand } from './lib/entrypoint-role.ts';

// Silence pino output for the CLI's own commands — they render their own human output and must not
// leak log lines. The `daemon` subcommand is the exception: it IS the log producer, so it keeps the
// default level (info) and manages routing itself in configureDaemonLogging(). The hidden supervisor
// keeps the CLI level silent and writes explicit lifecycle records to daemon.log. Must run before any
// logger is created — all subsystem imports below are dynamic, so nothing has materialised yet.
const subcommand = resolveEntrypointSubcommand(process.argv, process.execPath);
if (subcommand !== 'daemon') {
  setLogLevel(process.argv.includes('--debug') ? 'debug' : 'silent');
}

async function dispatch(): Promise<void> {
  const sub = subcommand;

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
    // Ensure the daemon is up, relaying the ready banner, then open the browser so first-run setup
    // happens there. Installers refresh a reachable daemon around upgrades: Unix restarts a stale
    // version after replacement, while Windows stops it first so the executable can be replaced.
    const { initCliI18n } = await import('./lib/i18n.ts');
    await initCliI18n();
    const { runUp } = await import('./lib/up.ts');
    await runUp({
      noOpen: Bun.env.MONAD_NO_OPEN === '1',
      nodeEnv: Bun.env.NODE_ENV,
      webPort: Bun.env.WEB_PORT
    });
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
