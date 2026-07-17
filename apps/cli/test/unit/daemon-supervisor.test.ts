import { expect, test } from 'bun:test';
import { DAEMON_RESTART_EXIT_CODE } from '@monad/protocol';

import {
  daemonSupervisorChildStdout,
  nextDaemonSupervisorAction,
  releaseDaemonSupervisorSpawnOptions
} from '../../src/lib/daemon.ts';

test('release daemon supervisor starts detached from the launcher process group', () => {
  expect(releaseDaemonSupervisorSpawnOptions('/opt/monad/bin/monad', '/tmp/daemon.log')).toEqual({
    argv: ['/opt/monad/bin/monad', 'daemon-supervisor', '/tmp/daemon.log'],
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe'
  });
});

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
