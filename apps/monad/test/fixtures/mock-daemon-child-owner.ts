import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { daemonChildProcesses, runDaemonChildSupervisorFromArgv } from '../../src/infra/daemon-child-processes.ts';

if (await runDaemonChildSupervisorFromArgv()) process.exit(0);

const registryPath = process.argv[2];
const pidFile = process.argv[3];
if (!registryPath || !pidFile) throw new Error('usage: mock-daemon-child-owner <registryPath> <pidFile>');

daemonChildProcesses.configure(registryPath, { supervisorEntryPath: import.meta.path });

const child = Bun.spawn(['sh', '-c', 'sleep 60'], {
  detached: true,
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore'
});
daemonChildProcesses.track(child.pid, 'fixture-child');

await mkdir(dirname(pidFile), { recursive: true });
await writeFile(pidFile, JSON.stringify({ ownerPid: process.pid, childPid: child.pid }));

setInterval(() => {}, 1000);
