import type { MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { LogCleanupPreview, LogCleanupResult } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { unwatchFile, watchFile } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig, monadSystemConfigSchema } from '@monad/environment';
import { configureLogger, createLogger, setDeveloperLogTransport } from '@monad/logger';
import { debugLogPath } from '@monad/logger/log-files';
import { httpErrorSchema } from '@monad/protocol';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { LogMaintenanceService } from '#/services/log-maintenance.ts';
import { meshFixtureCaptureDirectory } from '#/services/mesh-agent/fixture-paths.ts';
import { createHttpTransport, createRemoteAccessState } from '#/transports/http.ts';
import {
  buildHandlers,
  createTestConfigManager,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

const NOW = Date.UTC(2026, 6, 21, 12);
const DAY_MS = 24 * 60 * 60 * 1_000;
const REMOTE_TOKEN = 'log-settings-e2e-token';

type SeededLogs = {
  activeDebug: string;
  captureDir: string;
  captureSentinel: string;
  daemonHandle: Awaited<ReturnType<typeof open>>;
  daemonLog: string;
  developerLog: string;
  expectedPreview: LogCleanupPreview;
  expectedResult: LogCleanupResult;
  recentDebug: string;
  sentinel: string;
  startupLog: string;
};

type TestDaemon = {
  configManager: Awaited<ReturnType<typeof createTestConfigManager>>;
  paths: MonadPaths;
  remoteAccess: ReturnType<typeof createRemoteAccessState>;
  service: LogMaintenanceService;
  transport: TransportHandle;
};

const cleanupDirs = new Set<string>();

afterEach(async () => {
  setDeveloperLogTransport({ enabled: false, dir: tmpdir() });
  configureLogger(undefined);
  await Promise.all([...cleanupDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

async function canonicalError(response: Response) {
  const body = httpErrorSchema.parse(await response.json());
  if (!body.requestId) throw new Error('canonical HTTP error omitted requestId');
  expect(response.headers.get('x-monad-request-id')).toBe(body.requestId);
  return { ...body, requestId: '<request-id>' };
}

async function startTestDaemon(kind: (typeof TRANSPORTS)[number]): Promise<TestDaemon> {
  const dir = join(tmpdir(), `monad-log-settings-${kind}-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  cleanupDirs.add(dir);
  const paths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const configManager = await createTestConfigManager(paths);
  const captureDir = meshFixtureCaptureDirectory(paths);
  const logMaintenance = new LogMaintenanceService({
    logsDir: paths.logs,
    captureDir,
    debugDir: join(dir, 'debug'),
    debugPath: join(dir, 'debug', basename(debugLogPath)),
    now: () => NOW
  });
  const remoteAccess = createRemoteAccessState({ enabled: false, token: REMOTE_TOKEN });
  const app = createHttpTransport(
    buildHandlers(mockModel(), { paths, modelService }, { configManager, logMaintenance }),
    { remoteAccess }
  );
  return { configManager, paths, remoteAccess, service: logMaintenance, transport: serveTransport(kind, app) };
}

async function parsePersistedConfig(paths: MonadPaths) {
  return monadSystemConfigSchema.parse(JSON.parse(await Bun.file(paths.config).text()));
}

async function writeDated(path: string, content: string, ageMs: number): Promise<number> {
  await writeFile(path, content);
  const modified = new Date(NOW - ageMs);
  await utimes(path, modified, modified);
  return Buffer.byteLength(content);
}

async function seedManagedLogs(dir: string, paths: MonadPaths): Promise<SeededLogs> {
  const captureDir = meshFixtureCaptureDirectory(paths);
  const debugDir = join(dir, 'debug');
  await Promise.all([mkdir(paths.logs, { recursive: true }), mkdir(captureDir, { recursive: true }), mkdir(debugDir)]);

  const daemonLog = join(paths.logs, 'daemon.log');
  const startupLog = join(paths.logs, 'startup.log');
  const rotationLog = join(paths.logs, 'daemon.log.1');
  const developerLog = join(paths.logs, 'session-log_transport_e2e.jsonl');
  const channelLog = join(paths.logs, 'channel-log_transport_e2e.jsonl');
  const sentinel = join(paths.logs, 'unknown-sentinel.keep');
  const captureFinal = join(captureDir, 'codex-mesh_ABCDEFGHIJKL-oep_MNOPQRSTUVWX.jsonl');
  const captureTemp = join(
    captureDir,
    '.codex-mesh_ABCDEFGHIJKL-oep_MNOPQRSTUVWX.jsonl.12345678-1234-4123-8123-123456789abc.tmp'
  );
  const captureSentinel = join(captureDir, 'unknown-capture.keep');
  const activeDebug = join(debugDir, basename(debugLogPath));
  const oldDebug = join(debugDir, 'monad-debug-2000-01-01.log');
  const recentDebug = join(debugDir, 'monad-debug-2000-01-02.log');
  const oldAge = 3 * DAY_MS;

  const daemonHandle = await open(daemonLog, 'a');
  const contents = {
    daemon: 'daemon-before\n',
    startup: 'startup-before\n',
    rotation: 'rotation-before\n',
    developer: '{"event":"developer-before"}\n',
    channel: '{"event":"channel-before"}\n',
    captureFinal: '{"event":"capture-final"}\n',
    captureTemp: '{"event":"capture-temp"}\n',
    activeDebug: 'active-debug-before\n',
    oldDebug: 'old-debug-before\n',
    recentDebug: 'recent-debug-before\n'
  } as const;
  await daemonHandle.writeFile(contents.daemon);
  const old = new Date(NOW - oldAge);
  await utimes(daemonLog, old, old);

  const sizes = {
    daemon: Buffer.byteLength(contents.daemon),
    startup: await writeDated(startupLog, contents.startup, oldAge),
    rotation: await writeDated(rotationLog, contents.rotation, oldAge),
    developer: await writeDated(developerLog, contents.developer, oldAge),
    channel: await writeDated(channelLog, contents.channel, oldAge),
    captureFinal: await writeDated(captureFinal, contents.captureFinal, oldAge),
    captureTemp: await writeDated(captureTemp, contents.captureTemp, oldAge),
    activeDebug: await writeDated(activeDebug, contents.activeDebug, oldAge),
    oldDebug: await writeDated(oldDebug, contents.oldDebug, oldAge),
    recentDebug: await writeDated(recentDebug, contents.recentDebug, 60_000)
  };
  await Promise.all([writeFile(sentinel, 'preserve-log-sentinel\n'), writeFile(captureSentinel, 'preserve-capture\n')]);

  const expectedPreview = {
    files: 8,
    bytes:
      sizes.daemon +
      sizes.startup +
      sizes.developer +
      sizes.channel +
      sizes.captureFinal +
      sizes.captureTemp +
      sizes.activeDebug +
      sizes.oldDebug
  };
  const deletedOnEveryPlatform =
    sizes.rotation + sizes.developer + sizes.channel + sizes.captureFinal + sizes.captureTemp + sizes.oldDebug;
  const expectedResult =
    process.platform === 'win32'
      ? { filesCleared: 6, filesFailed: 4, bytesFreed: deletedOnEveryPlatform }
      : {
          filesCleared: 10,
          filesFailed: 0,
          bytesFreed: deletedOnEveryPlatform + sizes.daemon + sizes.startup + sizes.activeDebug + sizes.recentDebug
        };

  return {
    activeDebug,
    captureDir,
    captureSentinel,
    daemonHandle,
    daemonLog,
    developerLog,
    expectedPreview,
    expectedResult,
    recentDebug,
    sentinel,
    startupLog
  };
}

async function logAndWaitForRecreation(logger: Logger, path: string): Promise<string> {
  let timeout: ReturnType<typeof setTimeout>;
  const written = new Promise<string>((resolve, reject) => {
    const onChange = async () => {
      const content = await readFile(path, 'utf8').catch(() => '');
      if (!content.includes('developer.recreated')) return;
      clearTimeout(timeout);
      unwatchFile(path, onChange);
      resolve(content);
    };
    watchFile(path, { interval: 20 }, onChange);
    timeout = setTimeout(() => {
      unwatchFile(path, onChange);
      reject(new Error('developer log watcher ended before recreation'));
    }, 2_000);
  });
  logger.debug({ event: 'developer.recreated', sessionId: 'log_transport_e2e' }, 'developer log recreated');
  return written;
}

for (const kind of TRANSPORTS) {
  describe(`developer log settings over ${kind}`, () => {
    test('enforces listener security and persists the accepted policy', async () => {
      const daemon = await startTestDaemon(kind);
      try {
        const validAuth = { authorization: `Bearer ${REMOTE_TOKEN}` };
        const badHost = await daemon.transport.fetch('/v1/settings/developer', {
          headers: { ...validAuth, host: 'rebind.example' }
        });
        const badOrigin = await daemon.transport.fetch('/v1/settings/developer', {
          headers: { ...validAuth, origin: 'https://attacker.example' }
        });
        expect({
          badHost: { body: await canonicalError(badHost), status: badHost.status },
          badOrigin: {
            body: await canonicalError(badOrigin),
            status: badOrigin.status
          }
        }).toEqual({
          badHost: {
            body: { error: 'forbidden', code: 'FORBIDDEN', retryable: false, requestId: '<request-id>' },
            status: 403
          },
          badOrigin: {
            body: { error: 'forbidden', code: 'FORBIDDEN', retryable: false, requestId: '<request-id>' },
            status: 403
          }
        });

        daemon.remoteAccess.set({ enabled: true, token: REMOTE_TOKEN });
        // Local TCP peers and filesystem-gated Unix sockets intentionally bypass remote bearer auth.
        const local = await daemon.transport.fetch('/v1/settings/developer', {
          headers: { authorization: 'Bearer wrong-local-token', origin: 'http://localhost' }
        });
        expect({ body: await local.json(), status: local.status }).toEqual({
          body: {
            developerMode: false,
            logsDir: daemon.paths.logs,
            logs: { autoCleanup: { enabled: true, retentionDays: 14 } }
          },
          status: 200
        });

        const rejected = await daemon.transport.fetch(
          '/v1/settings/developer',
          jsonInit('PUT', { logs: { autoCleanup: { enabled: true, retentionDays: 0 } } })
        );
        expect({ body: await rejected.json(), status: rejected.status }).toEqual({
          body: expect.objectContaining({ code: 'VALIDATION' }),
          status: 400
        });
        expect((await parsePersistedConfig(daemon.paths)).logs.autoCleanup).toEqual({
          enabled: true,
          retentionDays: 14
        });

        const acceptedPolicies: Array<{ enabled: boolean; retentionDays: number }> = [];
        const unsubscribe = daemon.configManager.subscribe(
          (snapshot) => snapshot.cfg.logs.autoCleanup,
          (policy) => acceptedPolicies.push(policy)
        );
        const accepted = await daemon.transport.fetch(
          '/v1/settings/developer',
          jsonInit('PUT', { logs: { autoCleanup: { enabled: false, retentionDays: 30 } } })
        );
        expect({ body: await accepted.json(), status: accepted.status }).toEqual({
          body: {
            developerMode: false,
            logsDir: daemon.paths.logs,
            logs: { autoCleanup: { enabled: false, retentionDays: 30 } }
          },
          status: 200
        });
        expect({
          acceptedPolicies,
          manager: daemon.configManager.get().cfg.logs.autoCleanup,
          persisted: (await parsePersistedConfig(daemon.paths)).logs.autoCleanup,
          status: daemon.configManager.status()
        }).toEqual({
          acceptedPolicies: [{ enabled: false, retentionDays: 30 }],
          manager: { enabled: false, retentionDays: 30 },
          persisted: { enabled: false, retentionDays: 30 },
          status: { state: 'ready' }
        });
        unsubscribe();
      } finally {
        daemon.service.stop();
        await daemon.transport.stop();
        await daemon.configManager.stop();
      }
    });

    test('previews and clears every managed category with exact accounting', async () => {
      const dir = join(tmpdir(), `monad-log-seed-${kind}-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
      cleanupDirs.add(dir);
      const paths = makeTestPaths(dir);
      await initMonadHome(paths);
      const seeded = await seedManagedLogs(dir, paths);
      let service: LogMaintenanceService | undefined;
      let configManager: Awaited<ReturnType<typeof createTestConfigManager>> | undefined;
      let transport: TransportHandle | undefined;
      try {
        service = new LogMaintenanceService({
          logsDir: paths.logs,
          captureDir: seeded.captureDir,
          debugDir: dirname(seeded.activeDebug),
          debugPath: seeded.activeDebug,
          now: () => NOW
        });
        const cfg = await loadConfig(paths);
        if (!cfg) throw new Error('config missing after init');
        const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
        configManager = await createTestConfigManager(paths);
        const remoteAccess = createRemoteAccessState({ enabled: false, token: REMOTE_TOKEN });
        transport = serveTransport(
          kind,
          createHttpTransport(
            buildHandlers(mockModel(), { paths, modelService }, { configManager, logMaintenance: service }),
            { remoteAccess }
          )
        );

        configureLogger({ destinations: [{ type: 'developer', level: 'debug' }] });
        setDeveloperLogTransport({ enabled: true, dir: paths.logs });
        const developerLogger = createLogger(`log-transport-e2e-${kind}`);
        expect({ debugEnabled: developerLogger.isLevelEnabled('debug'), level: developerLogger.level }).toEqual({
          debugEnabled: true,
          level: 'debug'
        });

        const gated = await transport.fetch('/v1/settings/developer/logs', jsonInit('DELETE'));
        expect({ body: await canonicalError(gated), status: gated.status }).toEqual({
          body: {
            error: 'Developer Mode must be enabled to clear logs',
            code: 'FORBIDDEN',
            retryable: false,
            requestId: '<request-id>'
          },
          status: 403
        });

        const disabledPreview = await transport.fetch(
          '/v1/settings/developer/logs/preview',
          jsonInit('POST', { enabled: false, retentionDays: 30 })
        );
        expect({ body: await disabledPreview.json(), status: disabledPreview.status }).toEqual({
          body: { files: 0, bytes: 0 },
          status: 200
        });

        const preview = await transport.fetch(
          '/v1/settings/developer/logs/preview',
          jsonInit('POST', { enabled: true, retentionDays: 1 })
        );
        const cached = await transport.fetch(
          '/v1/settings/developer/logs/preview',
          jsonInit('POST', { enabled: true, retentionDays: 1 })
        );
        const rateLimited = await transport.fetch(
          '/v1/settings/developer/logs/preview',
          jsonInit('POST', { enabled: true, retentionDays: 2 })
        );
        expect({
          cached: { body: await cached.json(), status: cached.status },
          preview: { body: await preview.json(), status: preview.status },
          rateLimited: {
            body: await rateLimited.json(),
            retryAfter: rateLimited.headers.get('retry-after'),
            status: rateLimited.status
          }
        }).toEqual({
          cached: { body: seeded.expectedPreview, status: 200 },
          preview: { body: seeded.expectedPreview, status: 200 },
          rateLimited: {
            body: { error: 'Log cleanup preview is temporarily unavailable', code: 'RATE_LIMITED' },
            retryAfter: '2',
            status: 429
          }
        });

        const enabled = await transport.fetch(
          '/v1/settings/developer',
          jsonInit('PUT', {
            developerMode: true,
            logs: { autoCleanup: { enabled: true, retentionDays: 1 } }
          })
        );
        expect({ body: await enabled.json(), status: enabled.status }).toEqual({
          body: {
            developerMode: true,
            logsDir: paths.logs,
            logs: { autoCleanup: { enabled: true, retentionDays: 1 } }
          },
          status: 200
        });
        expect({
          manager: configManager.get().cfg.logs.autoCleanup,
          persisted: (await parsePersistedConfig(paths)).logs.autoCleanup
        }).toEqual({
          manager: { enabled: true, retentionDays: 1 },
          persisted: { enabled: true, retentionDays: 1 }
        });

        const cleared = await transport.fetch('/v1/settings/developer/logs', jsonInit('DELETE'));
        expect({ body: await cleared.json(), status: cleared.status }).toEqual({
          body: seeded.expectedResult,
          status: 200
        });

        await seeded.daemonHandle.writeFile('daemon-after\n');
        await seeded.daemonHandle.close();
        const recreated = await logAndWaitForRecreation(developerLogger, seeded.developerLog);
        const recreatedRecords = recreated
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .map(({ event, msg, sessionId }) => ({ event, msg, sessionId }));
        expect(recreatedRecords).toEqual([
          {
            event: 'developer.recreated',
            msg: 'developer log recreated',
            sessionId: 'log_transport_e2e'
          }
        ]);

        const failedTruncateContent = process.platform === 'win32' ? '-before\n' : '';
        expect({
          activeDebug: await readFile(seeded.activeDebug, 'utf8'),
          captureEntries: (await readdir(seeded.captureDir)).sort(),
          captureSentinel: await readFile(seeded.captureSentinel, 'utf8'),
          daemon: await readFile(seeded.daemonLog, 'utf8'),
          debugEntries: (await readdir(dirname(seeded.activeDebug))).sort(),
          logEntries: (await readdir(paths.logs)).sort(),
          recentDebug: await readFile(seeded.recentDebug, 'utf8'),
          sentinel: await readFile(seeded.sentinel, 'utf8'),
          startup: await readFile(seeded.startupLog, 'utf8')
        }).toEqual({
          activeDebug: process.platform === 'win32' ? `active-debug${failedTruncateContent}` : '',
          captureEntries: ['unknown-capture.keep'],
          captureSentinel: 'preserve-capture\n',
          daemon: process.platform === 'win32' ? `daemon${failedTruncateContent}daemon-after\n` : 'daemon-after\n',
          debugEntries: [basename(seeded.activeDebug), basename(seeded.recentDebug)].sort(),
          logEntries: [
            'daemon.log',
            'mesh-agent-fixture-capture',
            'session-log_transport_e2e.jsonl',
            'startup.log',
            'unknown-sentinel.keep'
          ].sort(),
          recentDebug: process.platform === 'win32' ? `recent-debug${failedTruncateContent}` : '',
          sentinel: 'preserve-log-sentinel\n',
          startup: process.platform === 'win32' ? `startup${failedTruncateContent}` : ''
        });
      } finally {
        await seeded.daemonHandle.close().catch(() => undefined);
        service?.stop();
        await transport?.stop();
        await configManager?.stop();
      }
    });
  });
}
