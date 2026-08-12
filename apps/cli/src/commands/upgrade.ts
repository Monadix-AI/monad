import type { CommandDef } from './types.ts';

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths } from '@monad/environment';
import { MONAD_VERSION } from '@monad/protocol';
import {
  parseReleaseChannel,
  type ReleaseFetch,
  type ResolvedRelease,
  releaseChannelOfVersion,
  resolveRelease,
  resolveReleaseTag,
  shouldInstallRelease
} from '@monad/utils/release-update';
import { prepareUpgradeAssets, upgradeWorkerLauncherCommand } from '@monad/utils/release-upgrade';

import { isDaemonReachable } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, yellow } from '../lib/output.ts';
import { usageError } from './types.ts';

declare const BUILD_DIST_TARGET: string | undefined;

interface UpgradeCommandDeps {
  arch?: NodeJS.Architecture;
  binaryPath?: string | (() => string);
  cacheDir?: string;
  distTarget?: string;
  fetch?: ReleaseFetch;
  isDaemonRunning?: () => Promise<boolean>;
  parentPid?: number;
  platform?: NodeJS.Platform;
  prepare?: typeof prepareUpgradeAssets;
  releaseApiBaseUrl?: string;
  releaseDownloadBaseUrl?: string;
  spawn?: typeof Bun.spawn;
}

export function createUpgradeCommand(commandDeps: UpgradeCommandDeps = {}): CommandDef {
  const binaryPathOption = commandDeps.binaryPath;
  const binaryPath =
    typeof binaryPathOption === 'function' ? binaryPathOption : () => binaryPathOption ?? process.execPath;
  const platform = commandDeps.platform ?? process.platform;
  const distTarget = commandDeps.distTarget ?? currentDistTarget(platform, commandDeps.arch ?? process.arch);
  const fetchImpl = commandDeps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const isDaemonRunning = commandDeps.isDaemonRunning ?? isDaemonReachable;
  const parentPid = commandDeps.parentPid ?? process.pid;
  const prepare = commandDeps.prepare ?? prepareUpgradeAssets;
  const spawn = commandDeps.spawn ?? Bun.spawn;

  return {
    local: true,
    name: 'update',
    aliases: ['upgrade'],
    group: 'daemon',
    synopsis: 'update [--check] [--channel <stable|beta|nightly>] [--tag <version>] [--force]',
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
        throw usageError('update accepts either --channel or --tag, not both');
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
      out(dim(t('cli.upgrade.applying')));
      const cacheDir = commandDeps.cacheDir ?? join(getPaths().cache, 'upgrade');
      const prepared = await prepare({
        directory: join(
          cacheDir,
          'staged',
          new Bun.CryptoHasher('sha256').update(release.tag).digest('hex').slice(0, 24)
        ),
        distTarget,
        fetch: fetchImpl,
        platform,
        release,
        onProgress: () => {}
      });
      const attemptPath = join(cacheDir, 'attempt.json');
      const resultPath = join(cacheDir, 'result.txt');
      const logPath = join(cacheDir, 'updater.log');
      await mkdir(cacheDir, { recursive: true });
      await rm(resultPath, { force: true });
      await Bun.write(
        attemptPath,
        `${JSON.stringify(
          {
            targetVersion: release.version,
            tag: release.tag,
            startedAt: new Date().toISOString(),
            completedAt: null,
            exitCode: null,
            logPath,
            state: 'installing'
          },
          null,
          2
        )}\n`
      );
      const proc = spawn(
        upgradeWorkerLauncherCommand({
          binaryPath: binaryPath(),
          downloadDirectory: prepared.downloadDirectory,
          installerPath: prepared.installerPath,
          logPath,
          parentPid,
          platform,
          restart: daemonWasRunning,
          resultPath
        }),
        {
          stdout: 'ignore',
          stderr: 'ignore',
          stdin: 'ignore'
        }
      );
      const code = await proc.exited;
      if (code == null || code !== 0) process.exit(code ?? 1);
    }
  };
}

function currentDistTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  if (typeof BUILD_DIST_TARGET === 'string') return BUILD_DIST_TARGET;
  const targetArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (!targetArch) throw new Error(`unsupported release architecture: ${arch}`);
  if (platform === 'darwin') return `${targetArch}-apple-darwin`;
  if (platform === 'linux') return `${targetArch}-unknown-linux-gnu`;
  if (platform === 'win32') return `${targetArch}-pc-windows-msvc`;
  throw new Error(`unsupported release platform: ${platform}`);
}

export const command: CommandDef = createUpgradeCommand();
