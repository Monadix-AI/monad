import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { prepareManagedProjectRuntime } from '#/services/mesh-agent/managed-project.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('managed project runtime recreates token files with owner-only permissions', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-unix-${process.pid}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace', 'prj_PROJECT00000', 'runtime', 'prj_PROJECT00000', 'codex');
  await mkdir(workspace, { recursive: true });
  const tokenFile = join(workspace, '.monad-agent-token');
  await writeFile(tokenFile, 'stale-token');
  await chmod(tokenFile, 0o644);
  try {
    const prepared = prepareManagedProjectRuntime({
      monadHome,
      serverUrl: 'http://127.0.0.1:1234',
      agentName: 'codex',
      projectId: 'prj_PROJECT00000',
      meshSessionId: 'mesh_first0000000',
      provider: 'codex'
    });

    expect({
      tokenFile: prepared.tokenFile,
      contentChanged: (await readFile(tokenFile, 'utf8')) !== 'stale-token',
      mode: (await stat(tokenFile)).mode & 0o777
    }).toEqual({ tokenFile, contentChanged: true, mode: 0o600 });
  } finally {
    await rm(monadHome, { recursive: true, force: true });
  }
});
