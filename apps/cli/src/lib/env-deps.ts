// Detect and interactively install runtime tools (Node.js, uv) during `monad init`.
// Pattern mirrors browser-binary.ts: detect → prompt → call daemon API to install.
// The daemon does the actual download; the CLI just handles user interaction.

import type { MonadClient } from '@monad/client';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPaths } from '@monad/environment';

import { t } from './i18n.ts';
import { bold, dim, green, out, red, yellow } from './output.ts';

function nodeFound(): boolean {
  const bin = process.platform === 'win32' ? 'node.exe' : 'node';
  return Bun.which('node') !== null || existsSync(join(getPaths().bin, bin));
}

function uvFound(): boolean {
  const bin = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return Bun.which('uv') !== null || existsSync(join(getPaths().bin, bin));
}

async function installViaApi(
  client: MonadClient,
  opts: { installNode?: boolean; installUv?: boolean }
): Promise<{ node: string; uv: string; errors?: Record<string, string> }> {
  const result = await client.treaty.v1.init['env-deps'].post(opts);
  if (!result.data) throw new Error('daemon returned no data');
  return result.data as { node: string; uv: string; errors?: Record<string, string> };
}

export async function ensureEnvDeps(ask: (question: string) => Promise<string>, client: MonadClient): Promise<void> {
  out(`\n${bold(t('cli.envDeps.header'))}`);

  let installNode = false;
  let installUv = false;

  // Node.js
  if (nodeFound()) {
    out(green(t('cli.envDeps.nodeFound')));
  } else {
    out(yellow(t('cli.envDeps.nodeNotFound')));
    const ans = await ask(t('cli.envDeps.nodeInstallPrompt'));
    if (!/^n$/i.test(ans.trim())) installNode = true;
    else out(dim(t('cli.envDeps.skipped')));
  }

  // uv
  if (uvFound()) {
    out(green(t('cli.envDeps.uvFound')));
  } else {
    out(yellow(t('cli.envDeps.uvNotFound')));
    const ans = await ask(t('cli.envDeps.uvInstallPrompt'));
    if (!/^n$/i.test(ans.trim())) installUv = true;
    else out(dim(t('cli.envDeps.skipped')));
  }

  if (!installNode && !installUv) return;

  out(dim(t('cli.envDeps.installing')));
  try {
    const result = await installViaApi(client, { installNode, installUv });

    if (installNode) {
      if (result.node === 'installed' || result.node === 'found') {
        out(green(`Node.js — ${t('cli.envDeps.installed')}`));
        const binDir = getPaths().bin;
        const pathSep = process.platform === 'win32' ? ';' : ':';
        process.env.PATH = `${binDir}${pathSep}${process.env.PATH ?? ''}`;
      } else {
        out(red(`Node.js — ${t('cli.envDeps.installFailed')}`));
        if (result.errors?.node) out(dim(result.errors.node));
      }
    }

    if (installUv) {
      if (result.uv === 'installed' || result.uv === 'found') {
        out(green(`uv — ${t('cli.envDeps.installed')}`));
      } else {
        out(red(`uv — ${t('cli.envDeps.installFailed')}`));
        if (result.errors?.uv) out(dim(result.errors.uv));
      }
    }
  } catch (err) {
    out(red(t('cli.envDeps.installFailed')));
    if (err instanceof Error) out(dim(err.message));
  }
}
