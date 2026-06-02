import type { LogLevelOverride } from '@monad/logger';

import { setLogLevel, setLogStderr } from '@monad/logger';

export interface DaemonRuntimeFlags {
  stdioMode: boolean;
  stdoutRpc: boolean;
  useMock: boolean;
  devMode: boolean;
  devSilent: boolean;
}

export function configureDaemonLogging(): void {
  const stdoutDetachable =
    process.argv.includes('--stdio') || process.argv.includes('--acp') || process.argv.includes('--start-relay');

  if (stdoutDetachable) {
    setLogStderr(true);
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      throw err;
    });
    process.on('SIGPIPE', () => {});
  }

  const logIdx = process.argv.indexOf('--log');
  const logOverride = logIdx !== -1 ? (process.argv[logIdx + 1] as LogLevelOverride) : undefined;
  if (logOverride) setLogLevel(logOverride);
  else if (process.argv.includes('--debug')) setLogLevel('debug');
}

export function readDaemonRuntimeFlags(): DaemonRuntimeFlags {
  const stdioMode = process.argv.includes('--stdio');
  const acpMode = process.argv.includes('--acp');
  return {
    stdioMode,
    stdoutRpc: stdioMode || acpMode,
    useMock: Bun.env.NODE_ENV !== 'production' && process.argv.includes('--mock-model'),
    devMode: Bun.env.NODE_ENV !== 'production' && process.argv.includes('--dev'),
    devSilent: Bun.env.NODE_ENV === 'development'
  };
}
