import { expect, test } from 'bun:test';
import { DAEMON_RESTART_EXIT_CODE } from '@monad/protocol';

import {
  daemonSupervisorChildStdout,
  nextDaemonSupervisorAction,
  readDaemonSupervisorPid,
  releaseDaemonSupervisorLauncherArgv
} from '../../src/lib/daemon.ts';

test('release daemon supervisor launches outside the short-lived CLI process', () => {
  expect(
    releaseDaemonSupervisorLauncherArgv(
      'linux',
      '/opt/monad/bin/monad',
      '/tmp/daemon.log',
      '/tmp/startup.log',
      '/tmp/supervisor-stderr.log'
    )
  ).toEqual([
    'sh',
    '-c',
    'nohup "$1" daemon-supervisor "$2" >"$3" 2>/dev/null < /dev/null & printf "%s" "$!"',
    'monad-supervisor-launch',
    '/opt/monad/bin/monad',
    '/tmp/daemon.log',
    '/tmp/startup.log'
  ]);

  const windows = releaseDaemonSupervisorLauncherArgv(
    'win32',
    "C:\\Monad O'Brien\\monad.exe",
    "C:\\Monad O'Brien\\daemon.log",
    "C:\\Monad O'Brien\\startup.log",
    "C:\\Monad O'Brien\\supervisor-stderr.log"
  );
  expect(windows.slice(0, 5)).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  expect(windows).toHaveLength(6);
  expect(Buffer.from(windows[5] ?? '', 'base64').toString('utf16le')).toBe(
    "$proc = Start-Process -FilePath 'C:\\Monad O''Brien\\monad.exe' " +
      "-ArgumentList @('daemon-supervisor', '\"C:\\Monad O''Brien\\daemon.log\"') " +
      "-RedirectStandardOutput 'C:\\Monad O''Brien\\startup.log' " +
      "-RedirectStandardError 'C:\\Monad O''Brien\\supervisor-stderr.log' -WindowStyle Hidden -PassThru; " +
      '[Console]::Out.WriteLine($proc.Id)'
  );
});

test('release launcher reads the supervisor PID without waiting for inherited stdout to close', async () => {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12860\n'));
      // The detached supervisor can inherit this handle and keep it open indefinitely.
    }
  });

  expect(await readDaemonSupervisorPid(stdout)).toBe(12860);
}, 1000);

test('daemon supervisor relays only the first child startup output', () => {
  expect([daemonSupervisorChildStdout(false), daemonSupervisorChildStdout(true)]).toEqual(['pipe', 'ignore']);
});

test('daemon supervisor exits instead of restarting when the first daemon startup crashes before health is ready', () => {
  expect(nextDaemonSupervisorAction({ started: false, readyOnce: false, exitCode: 1 })).toEqual({
    type: 'exit',
    code: 1
  });
});

test('daemon supervisor restarts only after the daemon has been healthy once', () => {
  expect(nextDaemonSupervisorAction({ started: true, readyOnce: false, exitCode: 1 })).toEqual({
    requested: false,
    type: 'restart'
  });
  expect(nextDaemonSupervisorAction({ started: false, readyOnce: true, exitCode: 1 })).toEqual({
    requested: false,
    type: 'restart'
  });
});

test('daemon supervisor distinguishes requested restarts from crashes', () => {
  expect(nextDaemonSupervisorAction({ started: true, readyOnce: true, exitCode: DAEMON_RESTART_EXIT_CODE })).toEqual({
    requested: true,
    type: 'restart'
  });
});

test('daemon supervisor exits on graceful daemon shutdown', () => {
  expect(nextDaemonSupervisorAction({ started: true, readyOnce: true, exitCode: 0 })).toEqual({
    type: 'exit',
    code: 0
  });
});
