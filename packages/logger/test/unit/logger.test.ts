import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reset module-level state between tests by manipulating env
const originalEnv = { ...Bun.env };
const ansiCodes = ['\x1B[0m', '\x1B[1m', '\x1B[2m', '\x1B[31m', '\x1B[32m', '\x1B[35m', '\x1B[36m'];
const stripAnsi = (value: string) => ansiCodes.reduce((out, code) => out.replaceAll(code, ''), value);

afterEach(async () => {
  process.env = { ...originalEnv };
  const { configureLogger } = await import('../../src/index.ts');
  configureLogger();
});

describe('createLogger', () => {
  test('returns a pino Logger instance', async () => {
    const { createLogger } = await import('../../src/index.ts');
    const log = createLogger('test');
    // pino loggers expose these methods
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  test('child logger carries parent bindings', async () => {
    const { createLogger } = await import('../../src/index.ts');
    const base = createLogger('parent');
    const child = base.child({ requestId: 'abc-123' });
    expect(typeof child.info).toBe('function');
  });

  test('createLogger accepts context bindings', async () => {
    const { createLogger } = await import('../../src/index.ts');
    const log = createLogger('svc', { env: 'test', version: '1.0' });
    expect(typeof log.info).toBe('function');
  });

  test('NODE_ENV=test defaults to silent', async () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "import { createLogger } from './src/index.ts'; console.log(createLogger('probe').level)"],
      cwd: join(import.meta.dir, '../..'),
      env: { ...Bun.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe'
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe('silent');
  });

  test('developer log subscribers receive structured records with session ids', async () => {
    const { createLogger, setLogLevel, subscribeDeveloperLogRecords } = await import('../../src/index.ts');
    const records: Record<string, unknown>[] = [];
    const dispose = subscribeDeveloperLogRecords((record) => records.push(record));
    setLogLevel('debug');
    const log = createLogger('subscriber-test');

    log.debug({ sessionId: 'ses_LOGTEST', event: 'test.event' }, 'subscriber event');
    await Bun.sleep(20);
    dispose();

    expect(records.some((record) => record.sessionId === 'ses_LOGTEST' && record.event === 'test.event')).toBe(true);
  });

  test('custom destinations receive records at their own level', async () => {
    const { configureLogger, createLogger } = await import('../../src/index.ts');
    const sentryRecords: Record<string, unknown>[] = [];
    const otelRecords: Record<string, unknown>[] = [];
    configureLogger({
      destinations: [
        {
          type: 'custom',
          name: 'otel',
          level: 'info',
          write: (record) => {
            otelRecords.push(record);
          }
        },
        {
          type: 'custom',
          name: 'sentry',
          level: 'error',
          write: (record) => {
            sentryRecords.push(record);
          }
        }
      ]
    });

    const log = createLogger('multi-dest', { service: 'logger-test' });
    log.debug({ ignored: true }, 'debug event');
    log.info({ requestId: 'req_1' }, 'info event');
    log.error({ requestId: 'req_2' }, 'error event');
    await Bun.sleep(20);

    expect(otelRecords.map((record) => record.msg)).toEqual(['info event', 'error event']);
    expect(sentryRecords.map((record) => record.msg)).toEqual(['error event']);
    expect(otelRecords[0]).toMatchObject({ name: 'multi-dest', service: 'logger-test', requestId: 'req_1' });
    expect(sentryRecords[0]).toMatchObject({ name: 'multi-dest', service: 'logger-test', requestId: 'req_2' });
  });

  test('configureLogger reconfigures already-created lazy loggers', async () => {
    const { configureLogger, createLogger } = await import('../../src/index.ts');
    const firstRecords: Record<string, unknown>[] = [];
    const secondRecords: Record<string, unknown>[] = [];
    const log = createLogger('reconfigured');

    configureLogger({
      destinations: [
        {
          type: 'custom',
          name: 'first',
          level: 'error',
          write: (record) => {
            firstRecords.push(record);
          }
        }
      ]
    });
    log.error('first error');
    await Bun.sleep(20);

    configureLogger({
      destinations: [
        {
          type: 'custom',
          name: 'second',
          level: 'error',
          write: (record) => {
            secondRecords.push(record);
          }
        }
      ]
    });
    log.error('second error');
    await Bun.sleep(20);

    expect(firstRecords.map((record) => record.msg)).toEqual(['first error']);
    expect(secondRecords.map((record) => record.msg)).toEqual(['second error']);
  });

  test('file destinations keep independent levels', async () => {
    const { configureLogger, createLogger } = await import('../../src/index.ts');
    const dir = mkdtempSync(join(tmpdir(), 'monad-logger-dest-'));
    const infoFile = join(dir, 'info.log');
    const errorFile = join(dir, 'error.log');
    try {
      configureLogger({
        destinations: [
          { type: 'file', path: infoFile, level: 'info', sync: true },
          { type: 'file', path: errorFile, level: 'error', sync: true }
        ]
      });

      const log = createLogger('file-dest');
      log.info('info event');
      log.error('error event');

      const infoLog = readFileSync(infoFile, 'utf8');
      const errorLog = readFileSync(errorFile, 'utf8');
      expect(infoLog).toContain('info event');
      expect(infoLog).toContain('error event');
      expect(errorLog).not.toContain('info event');
      expect(errorLog).toContain('error event');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatPrettyMessage', () => {
  test('formats HTTP transport calls as a single colored summary line', async () => {
    const { formatPrettyMessage } = await import('../../src/index.ts');
    const line = formatPrettyMessage({
      name: 'transport:http',
      msg: 'call',
      method: 'GET',
      path: '/health',
      status: 200,
      durationMs: 20
    });

    expect(stripAnsi(line)).toBe('[transport:http] GET 200 /health in 20ms');
    expect(line).toContain('\x1B[');
  });

  test('colors error HTTP status codes differently from success codes', async () => {
    const { formatPrettyMessage } = await import('../../src/index.ts');
    const success = formatPrettyMessage({ name: 'transport:http', msg: 'call', method: 'GET', path: '/', status: 200 });
    const serverError = formatPrettyMessage({
      name: 'transport:http',
      msg: 'call',
      method: 'GET',
      path: '/',
      status: 500
    });

    expect(success).toContain('\x1B[32m200\x1B[0m');
    expect(serverError).toContain('\x1B[31m500\x1B[0m');
  });

  test('formats non-HTTP transport calls with method, result, and duration', async () => {
    const { formatPrettyMessage } = await import('../../src/index.ts');

    const rpcLine = formatPrettyMessage({
      name: 'transport:jsonrpc',
      transport: 'stdio',
      msg: 'call',
      method: 'sessions.list',
      durationMs: 3
    });
    expect(stripAnsi(rpcLine)).toBe('[transport:stdio] sessions.list ok in 3ms');

    const acpLine = formatPrettyMessage({
      name: 'transport:acp',
      msg: 'call',
      method: 'prompt',
      err: true,
      durationMs: 9
    });
    expect(stripAnsi(acpLine)).toBe('[transport:acp] prompt error in 9ms');
  });

  test('keeps the regular logger prefix for non-transport logs', async () => {
    const { formatPrettyMessage } = await import('../../src/index.ts');

    expect(formatPrettyMessage({ name: 'monad', msg: 'ready' })).toBe('\x1B[2m[monad]\x1B[0m ready');
  });
});

describe('debugLogPath', () => {
  test('defaults to OS temp dir with today date', async () => {
    const { debugLogPath } = await import('../../src/log-files.ts');
    const today = new Date().toISOString().slice(0, 10);
    expect(debugLogPath).toContain('monad-debug-');
    expect(debugLogPath).toContain(today);
    expect(debugLogPath.startsWith(tmpdir())).toBe(true);
  });

  test('path includes the current date', async () => {
    const { debugLogPath } = await import('../../src/log-files.ts');
    const today = new Date().toISOString().slice(0, 10);
    expect(debugLogPath).toBe(join(tmpdir(), `monad-debug-${today}.log`));
  });
});

describe('default logger export', () => {
  test('logger is a pino Logger', async () => {
    const { logger } = await import('../../src/index.ts');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.child).toBe('function');
  });
});
