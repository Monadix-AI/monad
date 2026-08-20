import type { MonadAuth, MonadPaths, PersistedConfigSnapshot } from '../../src/index.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, open, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { removeConfigTransactionSemaphoreForTests } from '../../src/config/config-transaction-lock.ts';
import {
  type ConfigSnapshotTransactionStep,
  emptyAuth,
  initMonadHome,
  loadAuth,
  loadSnapshot,
  recoverConfigSnapshot,
  saveAll,
  saveAuth,
  saveSnapshot
} from '../../src/index.ts';

const AGENT_A = 'agt_000000000001' as const;
const AGENT_B = 'agt_000000000002' as const;
const CREDENTIAL_ID = 'cred_00000000001';
const roots: string[] = [];
const REQUIRED_STEPS: ConfigSnapshotTransactionStep[] = [
  'stage:agents:created-secure',
  'stage:agents:written',
  'stage:agents:synced',
  'stage:agents:directory-synced',
  'stage:auth:created-secure',
  'stage:auth:written',
  'stage:auth:synced',
  'stage:auth:directory-synced',
  'rollback:agents:created-secure',
  'rollback:agents:written',
  'rollback:agents:synced',
  'rollback:agents:directory-synced',
  'rollback:auth:created-secure',
  'rollback:auth:written',
  'rollback:auth:synced',
  'rollback:auth:directory-synced',
  'check:agents:final',
  'check:auth:final',
  'manifest:prepared:created-secure',
  'manifest:prepared:written',
  'manifest:prepared:synced',
  'manifest:prepared:temp-directory-synced',
  'manifest:prepared:installed',
  'manifest:prepared:directory-synced',
  'claim:agents:renamed',
  'claim:agents:directory-synced',
  'check:agents:claimed',
  'claim:auth:renamed',
  'claim:auth:directory-synced',
  'check:auth:claimed',
  'check:agents:retained',
  'check:auth:retained',
  'install:agents:linked',
  'install:agents:stage-removed',
  'install:agents:directory-synced',
  'install:auth:linked',
  'install:auth:stage-removed',
  'install:auth:directory-synced',
  'check:agents:precommit',
  'check:auth:precommit',
  'manifest:committed:created-secure',
  'manifest:committed:written',
  'manifest:committed:synced',
  'manifest:committed:temp-directory-synced',
  'manifest:committed:installed',
  'manifest:committed:directory-synced',
  'cleanup:agents:removed',
  'cleanup:agents:directory-synced',
  'cleanup:auth:removed',
  'cleanup:auth:directory-synced',
  'cleanup:manifest:prepared-removed',
  'cleanup:manifest:prepared-directory-synced',
  'cleanup:manifest:committed-removed',
  'cleanup:manifest:committed-directory-synced'
];
const PREPARED_RECOVERY_STEPS: ConfigSnapshotTransactionStep[] = [
  'recovery:agents:target-directory-synced',
  'recovery:auth:target-directory-synced',
  'recovery:agents:stage-removed',
  'recovery:agents:stage-directory-synced',
  'recovery:agents:backup-removed',
  'recovery:agents:backup-directory-synced',
  'recovery:auth:stage-removed',
  'recovery:auth:stage-directory-synced',
  'recovery:auth:backup-removed',
  'recovery:auth:backup-directory-synced',
  'recovery:manifest:prepared-temp-directory-synced',
  'recovery:manifest:committed-temp-directory-synced',
  'recovery:manifest:prepared-removed',
  'recovery:manifest:prepared-directory-synced',
  'recovery:manifest:committed-directory-synced'
];
const COMMITTED_RECOVERY_STEPS: ConfigSnapshotTransactionStep[] = [
  'recovery:agents:stage-directory-synced',
  'recovery:agents:backup-removed',
  'recovery:agents:backup-directory-synced',
  'recovery:auth:stage-directory-synced',
  'recovery:auth:backup-removed',
  'recovery:auth:backup-directory-synced',
  'recovery:manifest:prepared-temp-directory-synced',
  'recovery:manifest:committed-temp-directory-synced',
  'recovery:manifest:prepared-removed',
  'recovery:manifest:prepared-directory-synced',
  'recovery:manifest:committed-removed',
  'recovery:manifest:committed-directory-synced'
];
const COMMITTED_TEMP_RECOVERY_STEPS: ConfigSnapshotTransactionStep[] = [
  'recovery:agents:target-restored',
  'recovery:agents:target-directory-synced',
  'recovery:auth:target-restored',
  'recovery:auth:target-directory-synced',
  'recovery:agents:stage-directory-synced',
  'recovery:agents:backup-removed',
  'recovery:agents:backup-directory-synced',
  'recovery:auth:stage-directory-synced',
  'recovery:auth:backup-removed',
  'recovery:auth:backup-directory-synced',
  'recovery:manifest:prepared-temp-directory-synced',
  'recovery:manifest:committed-temp-removed',
  'recovery:manifest:committed-temp-directory-synced',
  'recovery:manifest:prepared-removed',
  'recovery:manifest:prepared-directory-synced',
  'recovery:manifest:committed-directory-synced'
];
const ORPHAN_RECOVERY_STEPS: ConfigSnapshotTransactionStep[] = [
  'recovery:config:stage-directory-synced',
  'recovery:config:backup-directory-synced',
  'recovery:agents:stage-removed',
  'recovery:agents:stage-directory-synced',
  'recovery:agents:backup-removed',
  'recovery:agents:backup-directory-synced',
  'recovery:mesh:stage-directory-synced',
  'recovery:mesh:backup-directory-synced',
  'recovery:auth:stage-removed',
  'recovery:auth:stage-directory-synced',
  'recovery:auth:backup-removed',
  'recovery:auth:backup-directory-synced',
  'recovery:manifest:prepared-temp-removed',
  'recovery:manifest:prepared-temp-directory-synced',
  'recovery:manifest:committed-temp-directory-synced',
  'recovery:manifest:prepared-directory-synced',
  'recovery:manifest:committed-directory-synced'
];
const NO_PREVIOUS_RECOVERY_STEPS: ConfigSnapshotTransactionStep[] = [
  'recovery:auth:target-removed',
  'recovery:auth:target-directory-synced',
  'recovery:auth:stage-directory-synced',
  'recovery:auth:backup-directory-synced',
  'recovery:manifest:prepared-temp-directory-synced',
  'recovery:manifest:committed-temp-directory-synced',
  'recovery:manifest:prepared-removed',
  'recovery:manifest:prepared-directory-synced',
  'recovery:manifest:committed-directory-synced'
];
const CONFLICT_EVIDENCE_STEPS: ConfigSnapshotTransactionStep[] = [
  'conflict:created-secure',
  'conflict:written',
  'conflict:synced',
  'conflict:temp-directory-synced',
  'conflict:installed',
  'conflict:directory-synced'
];

function makePaths(root: string): MonadPaths {
  return {
    home: root,
    runtime: root,
    configs: root,
    config: join(root, 'config.json'),
    agentsConfig: join(root, 'agents.json'),
    mesh: join(root, 'mesh.json'),
    approvals: join(root, 'approvals.json'),
    credentials: join(root, 'credentials'),
    auth: join(root, 'credentials', 'auth.json'),
    tls: join(root, 'credentials', 'tls'),
    workspace: join(root, 'workspace'),
    providers: join(root, 'providers'),
    skills: join(root, 'skills'),
    skillsLock: join(root, 'skills.lock'),
    locales: join(root, 'locales'),
    mcp: join(root, 'mcp'),
    atoms: join(root, 'atoms'),
    packs: join(root, 'atoms', 'packs'),
    agents: join(root, 'agents'),
    memory: join(root, 'memory'),
    backup: join(root, 'backup'),
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    bin: join(root, 'bin'),
    dbDir: root,
    db: join(root, 'monad.sqlite'),
    sock: join(root, 'monad.sock'),
    kvSock: join(root, 'kv.sock'),
    pid: join(root, 'monad.pid')
  };
}

function credentialAuth(): MonadAuth {
  const now = '2026-07-29T00:00:00.000Z';
  return {
    ...emptyAuth(),
    credentials: {
      [CREDENTIAL_ID]: {
        label: 'Token',
        environmentVariable: 'TOKEN',
        secret: 'secret-canary',
        allowedHosts: ['example.com'],
        createdAt: now,
        updatedAt: now
      }
    }
  };
}

async function snapshots() {
  const root = await mkdtemp(join(tmpdir(), 'monad-config-snapshot-'));
  roots.push(root);
  const paths = makePaths(root);
  await initMonadHome(paths);
  const loaded = await loadSnapshot(paths);
  if (!loaded) throw new Error('missing initialized snapshot');
  loaded.cfg.agent.agents = [
    {
      id: AGENT_A,
      name: 'A',
      capabilities: [],
      credentialIds: [CREDENTIAL_ID],
      declaredScopes: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    },
    {
      id: AGENT_B,
      name: 'B',
      capabilities: [],
      credentialIds: [CREDENTIAL_ID],
      declaredScopes: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    }
  ];
  loaded.auth = credentialAuth();
  await Promise.all([saveAll(paths, loaded.cfg), saveAuth(paths.auth, loaded.auth)]);

  const next = structuredClone(loaded);
  delete next.auth?.credentials[CREDENTIAL_ID];
  for (const agent of next.cfg.agent.agents) agent.credentialIds = [];
  return { paths, previous: loaded, next };
}

function shape(snapshot: Awaited<ReturnType<typeof loadSnapshot>>) {
  return {
    credential: snapshot?.auth?.credentials[CREDENTIAL_ID]?.secret ?? null,
    grants: snapshot?.cfg.agent.agents.map((agent) => agent.credentialIds) ?? []
  };
}

/** Resolve on a child's next stdout line, or reject at EOF — a handshake, never a poll. */
async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const newline = buffered.indexOf('\n');
    if (newline !== -1) return buffered.slice(0, newline);
  }
  throw new Error(`child closed stdout before sending a line (got ${JSON.stringify(buffered)})`);
}

async function rawSnapshotShape(paths: MonadPaths) {
  const agents = (await Bun.file(paths.agentsConfig).json()) as {
    agent: { agents: Array<{ credentialIds: string[] }> };
  };
  return {
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret ?? null,
    grants: agents.agent.agents.map((agent) => agent.credentialIds)
  };
}

function transactionArtifacts(paths: MonadPaths): string[] {
  return [
    `${paths.agentsConfig}.snapshot-next`,
    `${paths.agentsConfig}.snapshot-previous`,
    `${paths.auth}.snapshot-next`,
    `${paths.auth}.snapshot-previous`,
    `${paths.auth}.snapshot-transaction.json`,
    `${paths.auth}.snapshot-transaction.json.tmp`,
    `${paths.auth}.snapshot-transaction.json.committed`,
    `${paths.auth}.snapshot-transaction.json.committed.tmp`
  ];
}

interface RecoveryFixture {
  paths: MonadPaths;
  expected: ReturnType<typeof shape>;
  expectedAuthMode: number | null;
}

async function preparedRecoveryFixture(): Promise<RecoveryFixture> {
  const { paths, previous, next } = await snapshots();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        if (step === 'manifest:prepared:directory-synced') throw new Error('simulated crash');
      }
    })
  ).rejects.toThrow('simulated crash');
  return {
    paths,
    expected: { credential: 'secret-canary', grants: [[CREDENTIAL_ID], [CREDENTIAL_ID]] },
    expectedAuthMode: 0o600
  };
}

async function committedRecoveryFixture(): Promise<RecoveryFixture> {
  const { paths, previous, next } = await snapshots();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        if (step === 'manifest:committed:directory-synced') throw new Error('simulated crash');
      }
    })
  ).rejects.toThrow('simulated crash');
  return { paths, expected: { credential: null, grants: [[], []] }, expectedAuthMode: 0o600 };
}

async function committedTempRecoveryFixture(): Promise<RecoveryFixture> {
  const { paths, previous, next } = await snapshots();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        if (step === 'manifest:committed:temp-directory-synced') throw new Error('simulated crash');
      }
    })
  ).rejects.toThrow('simulated crash');
  expect(await mode(`${paths.auth}.snapshot-transaction.json.committed.tmp`)).toBe(0o600);
  return {
    paths,
    expected: { credential: 'secret-canary', grants: [[CREDENTIAL_ID], [CREDENTIAL_ID]] },
    expectedAuthMode: 0o600
  };
}

async function orphanRecoveryFixture(): Promise<RecoveryFixture> {
  const { paths, previous, next } = await snapshots();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        if (step === 'manifest:prepared:temp-directory-synced') throw new Error('simulated crash');
      }
    })
  ).rejects.toThrow('simulated crash');
  return {
    paths,
    expected: { credential: 'secret-canary', grants: [[CREDENTIAL_ID], [CREDENTIAL_ID]] },
    expectedAuthMode: 0o600
  };
}

async function noPreviousRecoveryFixture(): Promise<RecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'monad-config-snapshot-'));
  roots.push(root);
  const paths = makePaths(root);
  await initMonadHome(paths);
  const previous = await loadSnapshot(paths);
  if (!previous) throw new Error('missing initialized snapshot');
  await unlink(paths.auth);
  previous.auth = null;
  const next = structuredClone(previous);
  next.auth = credentialAuth();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        if (step === 'install:auth:directory-synced') throw new Error('simulated crash');
      }
    })
  ).rejects.toThrow('simulated crash');
  return { paths, expected: { credential: null, grants: [] }, expectedAuthMode: null };
}

async function deletedBeforeClaimConflictFixture() {
  const { paths, previous, next } = await snapshots();
  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: async (step) => {
        if (step === 'manifest:prepared:directory-synced') await unlink(paths.agentsConfig);
      }
    })
  ).rejects.toThrow('snapshot transaction conflict: agents');
  const manifestPath = `${paths.auth}.snapshot-transaction.json`;
  const manifest = (await Bun.file(manifestPath).json()) as {
    transactionId: string;
  };
  return { paths, manifestPath, transactionId: manifest.transactionId };
}

async function mode(path: string): Promise<number | null> {
  try {
    const value = await stat(path);
    return process.platform === 'win32' ? 0o600 : value.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeExternalAgentName(path: string, name: string): Promise<void> {
  const external = (await Bun.file(path).json()) as {
    agent: { agents: Array<{ name: string }> };
  };
  const externalAgent = external.agent.agents[0];
  if (!externalAgent) throw new Error('missing external agent fixture');
  externalAgent.name = name;
  await Bun.write(path, `${JSON.stringify(external, null, 2)}\n`);
}

async function retainedPaths(target: string, kind: 'claim' | 'rollback'): Promise<string[]> {
  const prefix = `${basename(target)}.snapshot-${kind}-`;
  return (await readdir(dirname(target)))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(dirname(target), entry));
}

async function conflictEvidencePaths(manifestPath: string): Promise<string[]> {
  const prefix = `${basename(manifestPath)}.conflicted-`;
  return (await readdir(dirname(manifestPath)))
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith('.tmp'))
    .map((entry) => join(dirname(manifestPath), entry));
}

async function committedEvidencePaths(manifestPath: string): Promise<string[]> {
  const prefix = `${basename(manifestPath)}.committed-`;
  return (await readdir(dirname(manifestPath)))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(dirname(manifestPath), entry));
}

async function retainedEvidencePaths(paths: MonadPaths): Promise<string[]> {
  return [
    ...(await retainedPaths(paths.agentsConfig, 'claim')),
    ...(await retainedPaths(paths.agentsConfig, 'rollback')),
    ...(await retainedPaths(paths.auth, 'claim')),
    ...(await retainedPaths(paths.auth, 'rollback')),
    ...(await committedEvidencePaths(`${paths.auth}.snapshot-transaction.json`)),
    ...(await conflictEvidencePaths(`${paths.auth}.snapshot-transaction.json`))
  ];
}

afterEach(async () => {
  for (const root of roots) await removeConfigTransactionSemaphoreForTests(root).catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('saveSnapshot commits auth.json and agents.json as one recoverable snapshot', async () => {
  const { paths, previous, next } = await snapshots();
  const steps: ConfigSnapshotTransactionStep[] = [];

  await saveSnapshot(paths, previous, next, { afterStep: (step) => void steps.push(step) });

  expect(steps).toEqual(REQUIRED_STEPS);
  expect(shape(await loadSnapshot(paths))).toEqual({ credential: null, grants: [[], []] });
  expect({
    authMode: await mode(paths.auth),
    agentsMode: await mode(paths.agentsConfig),
    artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
  }).toEqual({
    authMode: 0o600,
    agentsMode: 0o600,
    artifacts: [null, null, null, null, null, null, null, null]
  });
});

// One case per required step, each a full transaction against a fresh home with real fsync and
// lock acquisition. The work is bounded but nowhere near Bun's 5s default once the machine is busy
// running the rest of the monorepo's suites in parallel, so state the budget instead of inheriting
// an assumption about how fast the host is.
const HEAVY_FS_LOOP_TIMEOUT_MS = 60_000;

test(
  'startup recovery never observes a mixed auth and agents snapshot after any transaction step fails',
  async () => {
    for (const failedStep of REQUIRED_STEPS) {
      const { paths, previous, next } = await snapshots();
      await expect(
        saveSnapshot(paths, previous, next, {
          recoverOnFailure: false,
          afterStep: (step) => {
            if (step === failedStep) throw new Error(`injected failure: ${step}`);
          }
        })
      ).rejects.toThrow(`injected failure: ${failedStep}`);

      const artifactModes = await Promise.all(transactionArtifacts(paths).map(mode));
      expect(
        artifactModes.every((artifactMode) => artifactMode === null || artifactMode === 0o600),
        `artifacts after ${failedStep} must be absent or private`
      ).toBe(true);
      const recovered = shape(await loadSnapshot(paths));
      expect(recovered, `recovery after ${failedStep} must be the complete old or complete new snapshot`).toSatisfy(
        (value) =>
          JSON.stringify(value) ===
            JSON.stringify({ credential: 'secret-canary', grants: [[CREDENTIAL_ID], [CREDENTIAL_ID]] }) ||
          JSON.stringify(value) === JSON.stringify({ credential: null, grants: [[], []] })
      );
      expect({
        authMode: await mode(paths.auth),
        agentsMode: await mode(paths.agentsConfig),
        artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
      }).toEqual({
        authMode: 0o600,
        agentsMode: 0o600,
        artifacts: [null, null, null, null, null, null, null, null]
      });
    }
  },
  HEAVY_FS_LOOP_TIMEOUT_MS
);

test(
  'recovery injects every prepared, committed, orphan, and no-previous post-effect checkpoint',
  async () => {
    const scenarios = [
      { steps: PREPARED_RECOVERY_STEPS, setup: preparedRecoveryFixture },
      { steps: COMMITTED_RECOVERY_STEPS, setup: committedRecoveryFixture },
      { steps: COMMITTED_TEMP_RECOVERY_STEPS, setup: committedTempRecoveryFixture },
      { steps: ORPHAN_RECOVERY_STEPS, setup: orphanRecoveryFixture },
      { steps: NO_PREVIOUS_RECOVERY_STEPS, setup: noPreviousRecoveryFixture }
    ];

    for (const scenario of scenarios) {
      for (const failedStep of scenario.steps) {
        const { paths, expected, expectedAuthMode } = await scenario.setup();
        const steps: ConfigSnapshotTransactionStep[] = [];
        await expect(
          recoverConfigSnapshot(paths, {
            afterStep: (step) => {
              steps.push(step);
              if (step === failedStep) throw new Error(`recovery interrupted: ${step}`);
            }
          })
        ).rejects.toThrow(`recovery interrupted: ${failedStep}`);
        expect(steps).toEqual(scenario.steps.slice(0, scenario.steps.indexOf(failedStep) + 1));
        expect(
          (await Promise.all(transactionArtifacts(paths).map(mode))).every(
            (artifactMode) => artifactMode === null || artifactMode === 0o600
          )
        ).toBe(true);

        expect(shape(await loadSnapshot(paths))).toEqual(expected);
        expect({
          authMode: await mode(paths.auth),
          agentsMode: await mode(paths.agentsConfig),
          artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
        }).toEqual({
          authMode: expectedAuthMode,
          agentsMode: 0o600,
          artifacts: [null, null, null, null, null, null, null, null]
        });
      }
    }
  },
  HEAVY_FS_LOOP_TIMEOUT_MS
);

test(
  'conflict evidence survives every interrupted atomic decision write and restart',
  async () => {
    for (const failedStep of CONFLICT_EVIDENCE_STEPS) {
      const { paths, manifestPath, transactionId } = await deletedBeforeClaimConflictFixture();
      const observed: ConfigSnapshotTransactionStep[] = [];

      await expect(
        recoverConfigSnapshot(paths, {
          afterStep: (step) => {
            observed.push(step);
            if (step === failedStep) throw new Error(`conflict interrupted: ${step}`);
          }
        })
      ).rejects.toThrow(`conflict interrupted: ${failedStep}`);

      expect({
        conflictSteps: observed.filter((step) => step.startsWith('conflict:')),
        preparedMode: await mode(manifestPath),
        conflictModes: await Promise.all((await conflictEvidencePaths(manifestPath)).map(mode))
      }).toEqual({
        conflictSteps: CONFLICT_EVIDENCE_STEPS.slice(0, CONFLICT_EVIDENCE_STEPS.indexOf(failedStep) + 1),
        preparedMode: 0o600,
        conflictModes: failedStep === 'conflict:installed' || failedStep === 'conflict:directory-synced' ? [0o600] : []
      });

      await expect(recoverConfigSnapshot(paths)).resolves.toBeUndefined();
      await expect(recoverConfigSnapshot(paths)).resolves.toBeUndefined();
      const conflictPath = `${manifestPath}.conflicted-${transactionId}`;
      expect({
        evidence: await Bun.file(conflictPath).json(),
        mode: await mode(conflictPath),
        tempMode: await mode(`${conflictPath}.tmp`),
        preparedMode: await mode(manifestPath)
      }).toEqual({
        evidence: {
          version: 2,
          transactionId,
          phase: 'prepared',
          documents: [
            {
              name: 'agents',
              hadPrevious: true,
              previousSha256: expect.any(String),
              nextSha256: expect.any(String)
            },
            {
              name: 'auth',
              hadPrevious: true,
              previousSha256: expect.any(String),
              nextSha256: expect.any(String)
            }
          ],
          conflicts: [{ name: 'agents', reason: 'deleted-before-claim' }]
        },
        mode: 0o600,
        tempMode: null,
        preparedMode: null
      });
    }
  },
  HEAVY_FS_LOOP_TIMEOUT_MS
);

test('recovery atomically replaces a truncated conflict decision before removing the prepared manifest', async () => {
  const { paths, manifestPath, transactionId } = await deletedBeforeClaimConflictFixture();
  const conflictPath = `${manifestPath}.conflicted-${transactionId}`;
  const truncated = await open(conflictPath, 'wx', 0o600);
  try {
    await truncated.writeFile('{"version":2');
    await truncated.sync();
  } finally {
    await truncated.close();
  }

  await expect(recoverConfigSnapshot(paths)).resolves.toBeUndefined();

  expect({
    evidence: await Bun.file(conflictPath).json(),
    mode: await mode(conflictPath),
    tempMode: await mode(`${conflictPath}.tmp`),
    preparedMode: await mode(manifestPath)
  }).toEqual({
    evidence: {
      version: 2,
      transactionId,
      phase: 'prepared',
      documents: [
        {
          name: 'agents',
          hadPrevious: true,
          previousSha256: expect.any(String),
          nextSha256: expect.any(String)
        },
        {
          name: 'auth',
          hadPrevious: true,
          previousSha256: expect.any(String),
          nextSha256: expect.any(String)
        }
      ],
      conflicts: [{ name: 'agents', reason: 'deleted-before-claim' }]
    },
    mode: 0o600,
    tempMode: null,
    preparedMode: null
  });
});

test('recovery rejects v1 and non-randomUUID transaction IDs before deriving evidence paths', async () => {
  const invalidTransactions: Array<{ label: string; mutate(value: Record<string, unknown>): void }> = [
    {
      label: 'v1',
      mutate: (value) => {
        value.version = 1;
        delete value.transactionId;
      }
    },
    {
      label: 'uppercase',
      mutate: (value) => {
        value.transactionId = String(value.transactionId).toUpperCase();
      }
    },
    {
      label: 'wrong-version',
      mutate: (value) => {
        value.transactionId = '00000000-0000-0000-8000-000000000000';
      }
    },
    {
      label: 'overlong',
      mutate: (value) => {
        value.transactionId = `${value.transactionId}${'a'.repeat(64)}`;
      }
    }
  ];

  for (const invalid of invalidTransactions) {
    const fixture = await preparedRecoveryFixture();
    const manifestPath = `${fixture.paths.auth}.snapshot-transaction.json`;
    const value = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
    invalid.mutate(value);
    await Bun.write(manifestPath, `${JSON.stringify(value, null, 2)}\n`);

    await expect(recoverConfigSnapshot(fixture.paths)).rejects.toThrow(
      'monad: invalid config snapshot recovery manifest'
    );
    expect({
      label: invalid.label,
      state: await rawSnapshotShape(fixture.paths),
      preparedMode: await mode(manifestPath),
      derivedClaimCount: (await retainedPaths(fixture.paths.agentsConfig, 'claim')).length
    }).toEqual({
      label: invalid.label,
      state: { credential: 'secret-canary', grants: [[CREDENTIAL_ID], [CREDENTIAL_ID]] },
      preparedMode: 0o600,
      derivedClaimCount: 0
    });
  }
});

test('committed evidence retention is bounded and removes deleted credential secrets', async () => {
  const { paths, previous, next } = await snapshots();
  await saveSnapshot(paths, previous, next);
  const loaded = await loadSnapshot(paths);
  if (!loaded?.auth) throw new Error('missing current auth snapshot');
  let current: PersistedConfigSnapshot = loaded;

  for (let index = 0; index < 4; index++) {
    const following: PersistedConfigSnapshot = structuredClone(current);
    if (!following.auth) throw new Error('missing following auth snapshot');
    following.auth.credentials[CREDENTIAL_ID] = {
      label: `Token ${index}`,
      environmentVariable: 'TOKEN',
      secret: `replacement-secret-${index}`,
      allowedHosts: ['example.com'],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: `2026-07-29T00:00:0${index}.000Z`
    };
    await saveSnapshot(paths, current, following);
    current = following;
  }

  const retained = await retainedEvidencePaths(paths);
  expect({
    committedCount: (await committedEvidencePaths(`${paths.auth}.snapshot-transaction.json`)).length,
    authClaimCount: (await retainedPaths(paths.auth, 'claim')).length,
    secretCanaryRetained: (await Promise.all(retained.map((path) => Bun.file(path).text()))).some((text) =>
      text.includes('secret-canary')
    ),
    modes: await Promise.all(retained.map(mode))
  }).toEqual({
    committedCount: 2,
    authClaimCount: 2,
    secretCanaryRetained: false,
    modes: retained.map(() => 0o600)
  });
});

test('committed evidence GC preserves active conflict decisions and their claimed inode', async () => {
  const { paths, previous, next } = await snapshots();
  const external = (await Bun.file(paths.agentsConfig).json()) as {
    agent: { agents: Array<{ name: string }> };
  };
  const firstAgent = external.agent.agents[0];
  if (!firstAgent) throw new Error('missing external agent fixture');
  firstAgent.name = 'Conflict evidence';
  const serialized = `${JSON.stringify(external, null, 2)}\n`;
  const descriptor = await open(paths.agentsConfig, 'r+');
  try {
    await expect(
      saveSnapshot(paths, previous, next, {
        afterStep: async (step) => {
          if (step !== 'check:agents:claimed') return;
          await descriptor.write(serialized, 0, 'utf8');
          await descriptor.truncate(Buffer.byteLength(serialized));
          await descriptor.sync();
        }
      })
    ).rejects.toThrow('snapshot transaction conflict: agents');
  } finally {
    await descriptor.close();
  }

  const loaded = await loadSnapshot(paths);
  if (!loaded?.auth) throw new Error('missing recovered auth snapshot');
  let current: PersistedConfigSnapshot = loaded;
  for (let index = 0; index < 4; index++) {
    const following: PersistedConfigSnapshot = structuredClone(current);
    if (!following.auth) throw new Error('missing following auth snapshot');
    const credential = following.auth.credentials[CREDENTIAL_ID];
    if (!credential) throw new Error('missing following credential');
    following.auth.credentials[CREDENTIAL_ID] = {
      ...credential,
      label: `GC mutation ${index}`,
      updatedAt: `2026-07-29T00:01:0${index}.000Z`
    };
    await saveSnapshot(paths, current, following);
    current = following;
  }

  const conflicts = await conflictEvidencePaths(`${paths.auth}.snapshot-transaction.json`);
  const claims = await retainedPaths(paths.agentsConfig, 'claim');
  expect({
    conflictCount: conflicts.length,
    conflictModes: await Promise.all(conflicts.map(mode)),
    claimCount: claims.length,
    claimModes: await Promise.all(claims.map(mode)),
    claimedNames: await Promise.all(
      claims.map(async (path) => {
        const value = (await Bun.file(path).json()) as typeof external;
        return value.agent.agents.map(({ name }) => name);
      })
    ),
    committedCount: (await committedEvidencePaths(`${paths.auth}.snapshot-transaction.json`)).length
  }).toEqual({
    conflictCount: 1,
    conflictModes: [0o600],
    claimCount: 1,
    claimModes: [0o600],
    claimedNames: [['Conflict evidence', 'B']],
    committedCount: 2
  });
});

test('saveSnapshot rejects a stale previous document before preparing a transaction', async () => {
  const { paths, previous, next } = await snapshots();
  await unlink(paths.agentsConfig);

  await expect(saveSnapshot(paths, previous, next)).rejects.toThrow('snapshot transaction conflict: agents');

  expect((await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret).toBe('secret-canary');
  expect(await mode(paths.agentsConfig)).toBeNull();
  expect(await Promise.all(transactionArtifacts(paths).map(mode))).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ]);
});

test('saveSnapshot accepts semantically identical JSON with different formatting and key order', async () => {
  const { paths, previous, next } = await snapshots();
  for (const path of [paths.agentsConfig, paths.auth]) {
    const parsed = (await Bun.file(path).json()) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    await Bun.write(path, JSON.stringify(reversed));
  }

  await saveSnapshot(paths, previous, next);

  expect(shape(await loadSnapshot(paths))).toEqual({ credential: null, grants: [[], []] });
});

test('saveSnapshot rejects a stale semantic document change and preserves the external state', async () => {
  const { paths, previous, next } = await snapshots();
  const external = (await Bun.file(paths.agentsConfig).json()) as {
    agent: { agents: Array<{ name: string }> };
  };
  const externalAgent = external.agent.agents[0];
  if (!externalAgent) throw new Error('missing external agent fixture');
  externalAgent.name = 'External';
  await Bun.write(paths.agentsConfig, `${JSON.stringify(external, null, 4)}\n`);

  await expect(saveSnapshot(paths, previous, next)).rejects.toThrow('snapshot transaction conflict: agents');

  expect({
    externalName: ((await Bun.file(paths.agentsConfig).json()) as typeof external).agent.agents[0]?.name,
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret,
    artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
  }).toEqual({
    externalName: 'External',
    credential: 'secret-canary',
    artifacts: [null, null, null, null, null, null, null, null]
  });
});

test('saveSnapshot rechecks semantic state before install and never overwrites an intervening external edit', async () => {
  const { paths, previous, next } = await snapshots();
  let edited = false;

  await expect(
    saveSnapshot(paths, previous, next, {
      afterStep: async (step) => {
        if (edited || step !== 'stage:auth:directory-synced') return;
        edited = true;
        const external = (await Bun.file(paths.agentsConfig).json()) as {
          agent: { agents: Array<{ name: string }> };
        };
        const externalAgent = external.agent.agents[0];
        if (!externalAgent) throw new Error('missing external agent fixture');
        externalAgent.name = 'External between checks';
        await Bun.write(paths.agentsConfig, `${JSON.stringify(external, null, 2)}\n`);
      }
    })
  ).rejects.toThrow('snapshot transaction conflict: agents');

  expect({
    externalName: ((await Bun.file(paths.agentsConfig).json()) as { agent: { agents: Array<{ name: string }> } }).agent
      .agents[0]?.name,
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret,
    artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
  }).toEqual({
    externalName: 'External between checks',
    credential: 'secret-canary',
    artifacts: [null, null, null, null, null, null, null, null]
  });
});

test('saveSnapshot atomically claims the final checked target and preserves a later external edit', async () => {
  const { paths, previous, next } = await snapshots();
  let edited = false;

  await expect(
    saveSnapshot(paths, previous, next, {
      afterStep: async (step) => {
        if (edited || step !== 'check:auth:final') return;
        edited = true;
        await writeExternalAgentName(paths.agentsConfig, 'External after final check');
      }
    })
  ).rejects.toThrow('snapshot transaction conflict: agents');

  expect({
    activeName: ((await Bun.file(paths.agentsConfig).json()) as { agent: { agents: Array<{ name: string }> } }).agent
      .agents[0]?.name,
    retainedNames: await Promise.all(
      (await retainedPaths(paths.agentsConfig, 'claim')).map(async (path) => {
        const retained = (await Bun.file(path).json()) as { agent: { agents: Array<{ name: string }> } };
        return retained.agent.agents[0]?.name;
      })
    ),
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret
  }).toEqual({
    activeName: 'A',
    retainedNames: ['External after final check'],
    credential: 'secret-canary'
  });
});

test('saveSnapshot installs without overwriting an external target created after the atomic claim', async () => {
  const { paths, previous, next } = await snapshots();
  let edited = false;

  await expect(
    saveSnapshot(paths, previous, next, {
      afterStep: async (step) => {
        if (edited || step !== 'claim:agents:directory-synced') return;
        edited = true;
        const external = (await Bun.file(`${paths.agentsConfig}.snapshot-previous`).json()) as {
          agent: { agents: Array<{ name: string }> };
        };
        const externalAgent = external.agent.agents[0];
        if (!externalAgent) throw new Error('missing claimed agent fixture');
        externalAgent.name = 'External after claim';
        await Bun.write(paths.agentsConfig, `${JSON.stringify(external, null, 2)}\n`);
      }
    })
  ).rejects.toThrow('snapshot transaction conflict: agents');

  expect({
    externalName: ((await Bun.file(paths.agentsConfig).json()) as { agent: { agents: Array<{ name: string }> } }).agent
      .agents[0]?.name,
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret
  }).toEqual({ externalName: 'External after claim', credential: 'secret-canary' });
});

test('prepared recovery preserves an external target deletion before its claim', async () => {
  const { paths, previous, next } = await snapshots();
  let deleted = false;

  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: async (step) => {
        if (deleted || step !== 'manifest:prepared:directory-synced') return;
        deleted = true;
        await unlink(paths.agentsConfig);
      }
    })
  ).rejects.toThrow('snapshot transaction conflict: agents');

  await expect(recoverConfigSnapshot(paths)).resolves.toBeUndefined();
  await expect(recoverConfigSnapshot(paths)).resolves.toBeUndefined();
  const rollbacks = await retainedPaths(paths.agentsConfig, 'rollback');
  const conflicts = await conflictEvidencePaths(`${paths.auth}.snapshot-transaction.json`);
  expect({
    deleted,
    agentsExists: await Bun.file(paths.agentsConfig).exists(),
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret,
    rollbackModes: await Promise.all(rollbacks.map(mode)),
    rollbackNames: await Promise.all(
      rollbacks.map(async (path) => {
        const rollback = (await Bun.file(path).json()) as { agent: { agents: Array<{ name: string }> } };
        return rollback.agent.agents[0]?.name;
      })
    ),
    conflictModes: await Promise.all(conflicts.map(mode)),
    artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
  }).toEqual({
    deleted: true,
    agentsExists: false,
    credential: 'secret-canary',
    rollbackModes: [0o600],
    rollbackNames: ['A'],
    conflictModes: [0o600],
    artifacts: [null, null, null, null, null, null, null, null]
  });
});

test('saveSnapshot revalidates a claimed inode and preserves an edit written through an open descriptor', async () => {
  const { paths, previous, next } = await snapshots();
  const external = (await Bun.file(paths.agentsConfig).json()) as {
    agent: { agents: Array<{ name: string }> };
  };
  const externalAgent = external.agent.agents[0];
  if (!externalAgent) throw new Error('missing external agent fixture');
  externalAgent.name = 'External through descriptor';
  const serialized = `${JSON.stringify(external, null, 2)}\n`;
  const descriptor = await open(paths.agentsConfig, 'r+');
  let edited = false;
  try {
    await expect(
      saveSnapshot(paths, previous, next, {
        afterStep: async (step) => {
          if (edited || step !== 'check:agents:claimed') return;
          edited = true;
          await descriptor.write(serialized, 0, 'utf8');
          await descriptor.truncate(Buffer.byteLength(serialized));
          await descriptor.sync();
        }
      })
    ).rejects.toThrow('snapshot transaction conflict: agents');
  } finally {
    await descriptor.close();
  }

  expect({
    edited,
    activeName: ((await Bun.file(paths.agentsConfig).json()) as typeof external).agent.agents[0]?.name,
    retainedNames: await Promise.all(
      (await retainedPaths(paths.agentsConfig, 'claim')).map(async (path) => {
        const retained = (await Bun.file(path).json()) as typeof external;
        return retained.agent.agents[0]?.name;
      })
    ),
    credential: (await loadAuth(paths.auth))?.credentials[CREDENTIAL_ID]?.secret,
    artifacts: await Promise.all(transactionArtifacts(paths).map(mode))
  }).toEqual({
    edited: true,
    activeName: 'A',
    retainedNames: ['External through descriptor'],
    credential: 'secret-canary',
    artifacts: [null, null, null, null, null, null, null, null]
  });
});

test('a descriptor edit after commit remains readable through retained claim evidence', async () => {
  const { paths, previous, next } = await snapshots();
  const external = (await Bun.file(paths.agentsConfig).json()) as {
    agent: { agents: Array<{ name: string }> };
  };
  const externalAgent = external.agent.agents[0];
  if (!externalAgent) throw new Error('missing external agent fixture');
  externalAgent.name = 'External after commit';
  const serialized = `${JSON.stringify(external, null, 2)}\n`;
  const descriptor = await open(paths.agentsConfig, 'r+');
  try {
    await saveSnapshot(paths, previous, next);
    await descriptor.write(serialized, 0, 'utf8');
    await descriptor.truncate(Buffer.byteLength(serialized));
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }

  const claims = await retainedPaths(paths.agentsConfig, 'claim');
  expect({
    active: shape(await loadSnapshot(paths)),
    claimModes: await Promise.all(claims.map(mode)),
    retainedNames: await Promise.all(
      claims.map(async (path) => {
        const retained = (await Bun.file(path).json()) as typeof external;
        return retained.agent.agents[0]?.name;
      })
    )
  }).toEqual({
    active: { credential: null, grants: [[], []] },
    claimModes: [0o600],
    retainedNames: ['External after commit']
  });
});

test('snapshot recovery waits for a writer holding the inter-process transaction lock', async () => {
  const { paths } = await snapshots();
  const moduleUrl = new URL('../../src/config/config-io.ts', import.meta.url).href;
  // The handshake is a pipe in each direction rather than a polled marker file: the child announces
  // the critical section on stdout and holds it until stdin reaches EOF. Nothing here waits on a
  // duration, so a loaded machine cannot turn "the child was slow to start" into a failure.
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
        const { loadSnapshot, saveSnapshot } = await import(${JSON.stringify(moduleUrl)});
        const paths = JSON.parse(process.env.MONAD_TEST_PATHS);
        const previous = await loadSnapshot(paths);
        const next = structuredClone(previous);
        delete next.auth.credentials[${JSON.stringify(CREDENTIAL_ID)}];
        for (const agent of next.cfg.agent.agents) agent.credentialIds = [];
        await saveSnapshot(paths, previous, next, {
          afterStep: async (step) => {
            if (step !== 'stage:agents:directory-synced') return;
            await Bun.write(Bun.stdout, 'holding\\n');
            await Bun.stdin.text();
          }
        });
      `
    ],
    {
      env: { ...process.env, MONAD_TEST_PATHS: JSON.stringify(paths) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );
  let released = false;
  try {
    expect(await readLine(child.stdout)).toBe('holding');
    expect(await mode(`${paths.auth}.snapshot-transaction.json.lock`)).toBeNull();

    let settledWhileHeld = false;
    const recovery = recoverConfigSnapshot(paths).then(() => {
      settledWhileHeld = !released;
    });

    // The one remaining duration is a negative assertion, and load can only ever strengthen it: a
    // slow machine makes recovery LESS likely to finish inside the window, so it cannot flake the
    // way a readiness deadline does. It fails only if recovery ignores the lock outright.
    await Bun.sleep(50);
    expect(settledWhileHeld).toBe(false);

    released = true;
    child.stdin.end();
    const childExit = await child.exited;
    if (childExit !== 0) throw new Error('child snapshot writer failed');
    await recovery;

    expect({
      settledWhileHeld,
      state: shape(await loadSnapshot(paths)),
      lockMode: await mode(`${paths.auth}.snapshot-transaction.json.lock`)
    }).toEqual({
      settledWhileHeld: false,
      state: { credential: null, grants: [[], []] },
      lockMode: null
    });
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited;
  }
});

test('config-only snapshots atomically cover config.json, agents.json, and mesh.json', async () => {
  const { paths, previous } = await snapshots();
  const next = structuredClone(previous);
  next.cfg.developerMode = true;
  next.cfg.agent.agents = [];
  next.cfg.peers = [
    {
      id: 'peer_000000000001',
      label: 'Peer',
      baseUrl: 'https://peer.example.com',
      defaultAgent: 'default',
      enabled: true
    }
  ];
  const steps: ConfigSnapshotTransactionStep[] = [];

  await expect(
    saveSnapshot(paths, previous, next, {
      recoverOnFailure: false,
      afterStep: (step) => {
        steps.push(step);
        if (step === 'install:mesh:linked') throw new Error('config-only crash');
      }
    })
  ).rejects.toThrow('config-only crash');

  expect(steps.filter((step) => step.endsWith(':created-secure') && step.startsWith('stage:'))).toEqual([
    'stage:config:created-secure',
    'stage:agents:created-secure',
    'stage:mesh:created-secure'
  ]);
  const recovered = await loadSnapshot(paths);
  expect({
    developerMode: recovered?.cfg.developerMode,
    agentIds: recovered?.cfg.agent.agents.map((agent) => agent.id),
    peerIds: recovered?.cfg.peers.map((peer) => peer.id)
  }).toEqual({
    developerMode: false,
    agentIds: [AGENT_A, AGENT_B],
    peerIds: []
  });
});

test('loadSnapshot waits for the active transaction lock before running recovery', async () => {
  const { paths, previous, next } = await snapshots();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let loadSettled = false;
  const save = saveSnapshot(paths, previous, next, {
    afterStep: async (step) => {
      if (step !== 'manifest:prepared:directory-synced') return;
      reached.resolve();
      await release.promise;
    }
  });
  await reached.promise;

  const load = loadSnapshot(paths).then((snapshot) => {
    loadSettled = true;
    return snapshot;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(loadSettled).toBe(false);

  release.resolve();
  await save;
  expect(shape(await load)).toEqual({ credential: null, grants: [[], []] });
});
