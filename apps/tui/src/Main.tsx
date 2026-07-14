#!/usr/bin/env bun

// Exported as startTui() so the unified binary (apps/cli/src/bin.ts) can dispatch into it.

import type { TerminalCapabilities } from './input/types.ts';

import { checkDaemonVersion } from '@monad/client';
import { createMonadTreatyClient } from '@monad/client-rtk';
import { resolveClientConn } from '@monad/home';
import { render } from 'ink';
import { Provider } from 'react-redux';

import { App } from './App.tsx';
import { TerminalInputBridge, TerminalLifecycle } from './input/terminal-input.ts';
import { initTuiI18n, t } from './lib/i18n.ts';
import { createAppStore } from './store/index.ts';

function terminalCapabilities(): TerminalCapabilities {
  return {
    colorDepth: process.stdout.getColorDepth(),
    columns: process.stdout.columns,
    kittyKeyboard: process.stdin.isTTY,
    rows: process.stdout.rows,
    sgrMouse: process.stdin.isTTY
  };
}

export async function startTui(): Promise<void> {
  await initTuiI18n();

  if (!process.stdout.isTTY) {
    process.stderr.write(`${t('cli.tui.requiresTty')}\n`);
    process.exit(1);
  }

  const { baseUrl, token } = await resolveClientConn();

  const client = createMonadTreatyClient({ baseUrl, token: token ?? undefined });

  const versionResult = await checkDaemonVersion(baseUrl, token ?? undefined);
  if (!versionResult.compatible) {
    if (versionResult.daemonVersion === 'unknown') {
      process.stderr.write(`${t('cli.tui.daemonUnreachable')}\n`);
    } else {
      process.stderr.write(
        `${t('cli.tui.versionMismatch', {
          daemon: versionResult.daemonVersion,
          client: versionResult.clientVersion
        })}\n`
      );
    }
    process.exit(1);
  }

  const store = createAppStore(client);
  const terminal = terminalCapabilities();
  const input = new TerminalInputBridge(process.stdin);
  const lifecycle = new TerminalLifecycle(input, (value) => process.stdout.write(value));
  let unmount: (() => void) | undefined;
  let userRequestedExit = false;
  const stopForSignal = (signal: NodeJS.Signals) => {
    process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    unmount?.();
    lifecycle.restore();
  };
  const onSigint = () => stopForSignal('SIGINT');
  const onSigterm = () => stopForSignal('SIGTERM');
  const onSighup = () => stopForSignal('SIGHUP');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);

  try {
    if (terminal.sgrMouse) lifecycle.start();
    const app = render(
      <Provider store={store}>
        <App
          baseUrl={baseUrl}
          client={client}
          input={input}
          onExitRequested={() => {
            userRequestedExit = true;
          }}
        />
      </Provider>,
      {
        alternateScreen: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: 'auto' },
        stdin: input as unknown as NodeJS.ReadStream
      }
    );
    unmount = app.unmount;
    await app.waitUntilExit();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
    lifecycle.restore();
  }
  if (userRequestedExit) process.exit(0);
}

if (import.meta.main) {
  startTui().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
