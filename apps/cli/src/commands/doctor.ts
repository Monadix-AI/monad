import type { CommandDef } from './types.ts';

import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { certExpiry, certFingerprint, getPaths, loadConfig, resolveClientConn } from '@monad/environment';
import { getHealthResponseSchema, MONAD_VERSION } from '@monad/protocol';
import { isUpgradeAvailable, releaseChannelOfVersion, resolveRelease } from '@monad/utils/release-update';

import { dim, green, json, out, red, yellow } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

interface Check {
  name: string;
  ok: boolean;
  warn?: boolean; // a soft failure: reported but does not change the exit code
  detail: string;
}

// Diagnose a monad install: config validity, daemon reachability, version skew, data-dir
// writability, and socket permissions. Exits non-zero on a hard failure, so it doubles as a
// scriptable health gate (`monad doctor && …`). Soft issues are flagged but don't fail the gate.
export const command: CommandDef = {
  name: 'doctor',
  group: 'daemon',
  synopsis: 'doctor [update]',
  subcommands: ['update'],
  description: 'diagnose configuration, connection, and version problems',
  descriptionKey: 'cli.cmd.doctor.desc',
  async run({ client, positionals }) {
    const paths = getPaths();
    if (positionals[0] === 'update') {
      await runUpdateDoctor(paths.cache);
      return;
    }
    const checks: Check[] = [];

    // config.json present and valid.
    let transport: string | undefined;
    try {
      const cfg = await loadConfig(paths);
      if (cfg) {
        transport = cfg.network.transport;
        checks.push({ name: 'config', ok: true, detail: paths.config });
      } else {
        checks.push({ name: 'config', ok: false, detail: `missing — run \`monad init\` (${paths.config})` });
      }
    } catch (err) {
      checks.push({
        name: 'config',
        ok: false,
        detail: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'invalid'
      });
    }

    // daemon reachable (+ capture its version for the skew check).
    const { baseUrl } = await resolveClientConn();
    let daemonVersion: string | undefined;
    let healthData: { version?: string; latestVersion?: string } | null = null;
    try {
      const { data } = await client.treaty.health.get();
      healthData = data === null ? null : getHealthResponseSchema.parse(data);
      daemonVersion = healthData?.version;
    } catch {
      /* unreachable */
    }
    const daemonOk = daemonVersion !== undefined;
    checks.push({
      name: 'daemon',
      ok: daemonOk,
      detail: daemonOk ? baseUrl : `unreachable at ${baseUrl} — run \`monad start\``
    });

    // version skew between this client and the running daemon (soft — restart or update resolves it).
    if (daemonOk && daemonVersion !== MONAD_VERSION) {
      checks.push({
        name: 'version',
        ok: false,
        warn: true,
        detail: `client ${MONAD_VERSION} ≠ daemon ${daemonVersion} — run \`monad update\` then restart`
      });
    } else {
      checks.push({ name: 'version', ok: true, detail: MONAD_VERSION });
    }

    // upstream version check (surfaced by daemon background poller, best-effort).
    const latestVersion = healthData?.latestVersion;
    if (daemonOk && latestVersion && daemonVersion && isUpgradeAvailable(daemonVersion, latestVersion)) {
      checks.push({
        name: 'update',
        ok: false,
        warn: true,
        detail: `new version available: ${latestVersion} (run \`monad update\`)`
      });
    }

    // Model + agent readiness: the two things that actually stop `monad chat` from answering, and
    // the reason most "it does nothing" reports get filed. Only meaningful with a live daemon.
    if (daemonOk) {
      try {
        const [profiles, defaultAgent] = await Promise.all([
          client.treaty.v1.settings.model.profiles.get().then((r) => r.data),
          client.treaty.v1.agents.default.get().then((r) => r.data)
        ]);
        const configured = profiles?.profiles?.length ?? 0;
        checks.push({
          name: 'model',
          ok: configured > 0,
          detail: configured > 0 ? `profiles=${configured}` : 'no model profile — run `monad init` or `monad model set`'
        });
        checks.push({
          name: 'agent',
          ok: Boolean(defaultAgent?.agentId),
          detail: defaultAgent?.agentId ?? 'no default agent — run `monad agent new <name>` then `monad agent use`'
        });
      } catch {
        checks.push({ name: 'model', ok: false, warn: true, detail: 'could not read model settings' });
      }
    }

    // data directory is writable.
    try {
      const probe = join(paths.home, '.doctor-probe');
      await Bun.write(probe, 'ok');
      await rm(probe, { force: true });
      checks.push({ name: 'disk', ok: true, detail: `writable: ${paths.home}` });
    } catch {
      checks.push({ name: 'disk', ok: false, detail: `not writable: ${paths.home}` });
    }

    // socket permissions (unix + uds transport): the socket must not be world-accessible.
    if (process.platform !== 'win32' && transport === 'uds') {
      try {
        const mode = (await stat(paths.sock)).mode & 0o077;
        checks.push({
          name: 'socket',
          ok: mode === 0,
          warn: mode !== 0,
          detail: mode === 0 ? `0600 ${paths.sock}` : `group/other-accessible (${paths.sock})`
        });
      } catch {
        /* no socket yet (daemon down or tcp) — nothing to check */
      }
    }

    // TLS certificate validity (only when the cert file exists).
    try {
      const certPath = join(paths.tls, 'cert.pem');
      await stat(certPath);
      try {
        const [expiry, fp] = await Promise.all([certExpiry(certPath), certFingerprint(certPath)]);
        const daysLeft = Math.floor((new Date(expiry).getTime() - Date.now()) / 86_400_000);
        const relativeExpiry = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'short' }).format(
          daysLeft,
          'day'
        );
        if (daysLeft < 0) {
          checks.push({
            name: 'tls',
            ok: false,
            detail: `certificate ${relativeExpiry} (${fp.slice(0, 16)}…)`
          });
        } else if (daysLeft < 30) {
          checks.push({
            name: 'tls',
            ok: false,
            warn: true,
            detail: `certificate expires ${relativeExpiry} — run \`monad remote tls renew\``
          });
        } else {
          checks.push({ name: 'tls', ok: true, detail: `valid ${daysLeft}d  ${fp.slice(0, 16)}…` });
        }
      } catch {
        checks.push({ name: 'tls', ok: false, warn: true, detail: 'could not read cert (openssl unavailable?)' });
      }
    } catch {
      /* no TLS cert — skip; only present when remote access is enabled */
    }

    renderChecks(checks);
  }
};

async function runUpdateDoctor(cacheRoot: string): Promise<void> {
  const upgradeCache = join(cacheRoot, 'upgrade');
  const attemptPath = join(upgradeCache, 'attempt.json');
  const resultPath = join(upgradeCache, 'result.txt');
  const logPath = join(upgradeCache, 'updater.log');
  const channel = releaseChannelOfVersion(MONAD_VERSION);
  const checks: Check[] = [];

  checks.push({ name: 'channel', ok: true, detail: `${channel} (${MONAD_VERSION})` });
  try {
    const release = await resolveRelease(channel, { userAgent: `monad-doctor/${MONAD_VERSION}` });
    checks.push({
      name: 'release',
      ok: release !== null,
      warn: release === null,
      detail: release ? `latest ${release.version} (${release.tag})` : `no ${channel} release resolved`
    });
  } catch (error) {
    checks.push({
      name: 'release',
      ok: false,
      warn: true,
      detail: `lookup failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  try {
    const attempt = JSON.parse(await readFile(attemptPath, 'utf8')) as { tag?: string; targetVersion?: string };
    let result = 'no completion result';
    try {
      const [exitCode, completedAt] = (await readFile(resultPath, 'utf8')).trim().split('\n');
      result = `exit=${exitCode ?? '?'} completed=${completedAt ?? '?'}`;
    } catch {
      /* The attempt may still be in progress or have been interrupted. */
    }
    checks.push({
      name: 'attempt',
      ok: true,
      detail: `${attempt.tag ?? attempt.targetVersion ?? 'unknown'}; ${result}; log=${logPath}`
    });
  } catch {
    checks.push({ name: 'attempt', ok: true, detail: `none recorded (${attemptPath})` });
  }

  renderChecks(checks);
}

function renderChecks(checks: Check[]): void {
  const hardFail = checks.some((check) => !check.ok && !check.warn);
  json({ ok: !hardFail, checks });

  for (const check of checks) {
    const mark = check.ok ? green('✓') : check.warn ? yellow('!') : red('✖');
    out(`${mark} ${check.name.padEnd(8)} ${dim(check.detail)}`);
  }
  if (hardFail) {
    const failed = checks
      .filter((check) => !check.ok && !check.warn)
      .map((check) => check.name)
      .join(', ');
    out(yellow(`✖ ${failed} check${failed.includes(',') ? 's' : ''} failed`));
    throw new CliError('', EXIT.CONFIG);
  }
  out(green('✓ all checks passed'));
}
