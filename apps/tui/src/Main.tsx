#!/usr/bin/env bun

// Exported as startTui() so the unified binary (apps/cli/src/bin.ts) can dispatch into it.

import { checkDaemonVersion } from '@monad/client';
import { createMonadTreatyClient } from '@monad/client-rtk';
import { resolveClientConn } from '@monad/home';
import { render } from 'ink';
import { Provider } from 'react-redux';

import { App } from './App.tsx';
import { initTuiI18n, t } from './lib/i18n.ts';
import { createAppStore } from './store/index.ts';

const ENTER_FULLSCREEN = '\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l';
const EXIT_FULLSCREEN = '\u001B[?25h\u001B[?1049l';

function enableFullscreenTui() {
  process.stdout.write(ENTER_FULLSCREEN);
}

function disableFullscreenTui() {
  process.stdout.write(EXIT_FULLSCREEN);
}

export async function startTui(): Promise<void> {
  await initTuiI18n();

  if (!process.stdout.isTTY) {
    process.stderr.write(`${t('cli.tui.requiresTty')}\n`);
    process.exit(1);
  }

  enableFullscreenTui();

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

  try {
    const { waitUntilExit } = render(
      <Provider store={store}>
        <App />
      </Provider>
    );

    await waitUntilExit();
  } finally {
    disableFullscreenTui();
  }
}

if (import.meta.main) {
  startTui().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
