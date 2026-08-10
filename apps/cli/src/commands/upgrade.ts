import type { CommandDef } from './types.ts';

import { access } from 'node:fs/promises';
import { MONAD_VERSION } from '@monad/protocol';
import {
  monadUpdaterPath,
  parseReleaseChannel,
  type ResolvedRelease,
  releaseChannelOfVersion,
  resolveRelease,
  resolveReleaseTag,
  shouldInstallRelease
} from '@monad/utils/release-update';

import { isDaemonReachable } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, yellow } from '../lib/output.ts';
import { restartDaemon } from './restart.ts';
import { usageError } from './types.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface UpgradeCommandDeps {
  access?: (path: string) => Promise<void>;
  binaryPath?: string | (() => string);
  fetch?: FetchFn;
  isDaemonRunning?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  releaseApiBaseUrl?: string;
  releaseDownloadBaseUrl?: string;
  restart?: () => Promise<void>;
  spawn?: typeof Bun.spawn;
  updaterPath?: string | (() => string);
}

export function createUpgradeCommand(commandDeps: UpgradeCommandDeps = {}): CommandDef {
  const binaryPathOption = commandDeps.binaryPath;
  const binaryPath =
    typeof binaryPathOption === 'function' ? binaryPathOption : () => binaryPathOption ?? process.execPath;
  const platform = commandDeps.platform ?? process.platform;
  const updaterPathOption = commandDeps.updaterPath;
  const updaterPath =
    typeof updaterPathOption === 'function'
      ? updaterPathOption
      : () => updaterPathOption ?? monadUpdaterPath(binaryPath(), platform);
  const fetchImpl = commandDeps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const isDaemonRunning = commandDeps.isDaemonRunning ?? isDaemonReachable;
  const spawn = commandDeps.spawn ?? Bun.spawn;
  const checkAccess = commandDeps.access ?? access;
  const restart = commandDeps.restart ?? restartDaemon;

  return {
    local: true,
    name: 'upgrade',
    group: 'daemon',
    synopsis: 'upgrade [--check] [--channel <stable|beta|nightly>] [--tag <version>] [--force]',
    description: 'check for and apply Monad updates',
    descriptionKey: 'cli.cmd.upgrade.desc',
    flags: {
      check: {
        type: 'boolean',
        description: 'check for updates without applying them',
        descriptionKey: 'cli.cmd.upgrade.checkFlag'
      },
      channel: {
        type: 'string',
        description: 'release channel; defaults to the current build channel',
        descriptionKey: 'cli.cmd.upgrade.channelFlag'
      },
      notes: {
        type: 'boolean',
        description: 'show release notes alongside version info',
        descriptionKey: 'cli.cmd.upgrade.notesFlag'
      },
      tag: {
        type: 'string',
        description: 'install an exact release tag, for example v0.1.3'
      },
      force: {
        type: 'boolean',
        description: 'reinstall the selected release even when already current'
      }
    },
    async run({ flags, globals }) {
      if (flags.channel !== undefined && flags.tag !== undefined) {
        throw usageError('upgrade accepts either --channel or --tag, not both');
      }
      const exactTag = typeof flags.tag === 'string' ? flags.tag : undefined;
      const force = flags.force === true;
      const explicitChannelSwitch = flags.channel !== undefined || exactTag !== undefined;
      let channel = parseReleaseChannel(flags.channel ?? releaseChannelOfVersion(MONAD_VERSION));
      const checkOnly = flags.check === true;

      out(t('cli.upgrade.checking'));

      let release: ResolvedRelease | null;
      try {
        const options = {
          apiBaseUrl: commandDeps.releaseApiBaseUrl ?? Bun.env.MONAD_RELEASE_API_BASE_URL,
          downloadBaseUrl: commandDeps.releaseDownloadBaseUrl ?? Bun.env.MONAD_RELEASE_DOWNLOAD_BASE_URL,
          fetch: fetchImpl,
          userAgent: 'monad-cli'
        };
        release = exactTag ? await resolveReleaseTag(exactTag, options) : await resolveRelease(channel, options);
      } catch {
        release = null;
      }
      if (!release) {
        out(yellow(t('cli.upgrade.fetchFailed')));
        process.exit(1);
      }

      const current = MONAD_VERSION;
      const latest = release.version;
      if (exactTag) channel = releaseChannelOfVersion(latest);
      const upToDate =
        !force && exactTag === undefined && !shouldInstallRelease(current, latest, channel, explicitChannelSwitch);

      if (globals.json) {
        json({ current, latest, upToDate, channel, tag: release.tag });
        return;
      }

      if (upToDate) {
        out(`${green('✓')} ${t('cli.upgrade.upToDate', { version: bold(current) })}`);
        return;
      }

      out(t('cli.upgrade.available', { current: bold(current), latest: bold(latest) }));

      if (flags.notes === true && release.notes) {
        out('');
        const lines = release.notes.split('\n').slice(0, 20);
        for (const line of lines) out(dim(line));
        if (release.notes.split('\n').length > 20) out(dim('…'));
        out('');
      }

      if (checkOnly) return;

      const daemonWasRunning = await isDaemonRunning();

      const updater = updaterPath();
      try {
        await checkAccess(updater);
      } catch {
        out(yellow(`✖ monad-update is missing at ${updater}; reinstall Monad with the current installer.`));
        process.exit(1);
      }

      out(dim(t('cli.upgrade.applying')));
      const proc = spawn([updater, '--tag', release.tag], {
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit'
      });
      const code = await proc.exited;
      if (code == null || code !== 0) process.exit(code ?? 1);
      if (daemonWasRunning) await restart();
    }
  };
}

export const command: CommandDef = createUpgradeCommand();
