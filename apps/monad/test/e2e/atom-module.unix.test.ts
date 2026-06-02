import type { MonadPaths } from '@monad/environment';
import type { AgentId } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, saveAll } from '@monad/environment';

import { ConfigManager } from '#/config/manager.ts';
import { createAtomPacksModule } from '#/handlers/atom-pack/index.ts';
import { createTestConfigManager } from '../helpers.ts';

let base: string;
let atomsDir: string;
let mod: ReturnType<typeof createAtomPacksModule>;
let config: ConfigManager;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const privateAgentId = 'agt_100000000000' as AgentId;
const privateAgentDir = 'private-agent';

function paths(): MonadPaths {
  return {
    home: base,
    logs: join(base, 'logs'),
    runtime: base,
    configs: base,
    agentsConfig: join(base, 'agents.json'),
    mesh: join(base, 'mesh.json'),
    approvals: join(base, 'approvals.json'),
    config: join(base, 'config.json'),
    credentials: join(base, 'credentials'),
    auth: join(base, 'credentials', 'auth.json'),
    tls: join(base, 'credentials', 'tls'),
    workspace: base,
    providers: base,
    skills: base,
    skillsLock: join(base, 'skills.lock'),
    locales: '/dev/null',
    mcp: '/dev/null',
    atoms: atomsDir,
    packs: join(atomsDir, 'packs'),
    agents: base,
    memory: base,
    backup: base,
    cache: base,
    bin: join(base, 'bin'),
    dbDir: base,
    db: join(base, 'db'),
    sock: join(base, 'sock'),
    kvSock: join(base, 'kvsock'),
    pid: join(base, 'monad.pid')
  };
}

beforeEach(async () => {
  base = join(tmpdir(), `monad-amod-unix-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  atomsDir = join(base, 'atoms');
  await mkdir(atomsDir, { recursive: true });
  const initial = createDefaultConfig('Test User');
  initial.agent.agents.push({
    id: privateAgentId,
    name: 'Private Agent',
    dir: privateAgentDir,
    capabilities: [],
    credentialIds: [],
    declaredScopes: [],
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false }
  });
  await saveAll(paths(), initial);
  config = await createTestConfigManager(paths());
  mod = createAtomPacksModule({ paths: paths(), config });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  await rm(base, { recursive: true, force: true });
});

test('installSkill routes GitHub page URLs through the GitHub installer', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'monad-git-bin-'));
  const fakeGit = join(binDir, 'git');
  const sha = 'd'.repeat(40);
  await writeFile(
    fakeGit,
    `#!/bin/sh
set -eu
if [ "$1" = "clone" ]; then
  dest=""
  for arg in "$@"; do dest="$arg"; done
  mkdir -p "$dest/pixel2motion"
  cat > "$dest/pixel2motion/SKILL.md" <<'EOF'
---
name: pixel2motion
description: Pixel to motion.
---
Body.
EOF
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  echo "${sha}"
  exit 0
fi
exit 0
`
  );
  await chmod(fakeGit, 0o755);
  process.env.PATH = `${binDir}:${realPath ?? ''}`;
  globalThis.fetch = Object.assign(async () => new Response('not found', { status: 404 }), {
    preconnect: realFetch.preconnect
  });

  const source = 'https://github.com/acme/skills/blob/main/pixel2motion/SKILL.md';
  const res = await mod.installSkill({
    source,
    consent: true,
    overwrite: false,
    target: { kind: 'agent', agentId: privateAgentId }
  });

  expect(res).toEqual({
    skills: ['pixel2motion'],
    skillIds: [`agent:${privateAgentDir}:pixel2motion`],
    commit: sha,
    warnings: ['pinned to mutable ref "main" — content can change under you; pin to a commit SHA']
  });
  expect(await Bun.file(join(base, privateAgentDir, 'skills', 'pixel2motion', 'SKILL.md')).exists()).toBe(true);
  const record = JSON.parse(
    await Bun.file(join(base, privateAgentDir, 'skills', 'pixel2motion', '.install.json')).text()
  );
  expect(record).toMatchObject({
    source,
    sourceKind: 'github',
    sourceId: 'github:acme/skills/pixel2motion',
    ref: 'main',
    commit: sha
  });
  await rm(binDir, { recursive: true, force: true });
});
