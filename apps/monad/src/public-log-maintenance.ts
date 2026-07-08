export {
  DAEMON_LOG_KEEP,
  DAEMON_LOG_MAX_BYTES,
  rotateDaemonLog,
  rotateLogFile,
  STALE_LOG_MAX_AGE_MS,
  sweepStaleLogs
} from './services/log-maintenance.ts';
