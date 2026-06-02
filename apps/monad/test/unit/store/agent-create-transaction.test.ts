import type { AgentConfig } from '@monad/environment';
import type { AgentCreateTransactionStep } from '#/store/home/agent-create-transaction.ts';

import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completeAgentCreateTransaction,
  ensureSecureAgentCreateTransactionRoot,
  installAgentCreatePrompt,
  recoverAgentCreateTransaction,
  recoverAgentCreateTransactions,
  stageAgentCreatePrompt
} from '#/store/home/agent-create-transaction.ts';

const AGENT_ID = 'agt_000000000001' as const;
const AGENT_ID_B = 'agt_000000000002' as const;
const roots: string[] = [];
const CREATE_STEPS: AgentCreateTransactionStep[] = [
  'prompt-create:root-created',
  'prompt-create:root-directory-synced',
  'prompt-create:transaction-created',
  'prompt-create:transaction-directory-synced',
  'prompt-create:prompt-created-secure',
  'prompt-create:prompt-written',
  'prompt-create:prompt-synced',
  'prompt-create:prompt-directory-synced',
  'prompt-create:manifest-created-secure',
  'prompt-create:manifest-written',
  'prompt-create:manifest-synced',
  'prompt-create:manifest-directory-synced',
  'prompt-create:target-created',
  'prompt-create:target-directory-synced',
  'prompt-create:prompt-installed',
  'prompt-create:prompt-source-directory-synced',
  'prompt-create:prompt-install-directory-synced',
  'prompt-create:transaction-removed',
  'prompt-create:transaction-root-directory-synced'
];

function configuredAgent(): Pick<AgentConfig, 'id' | 'dir' | 'name'> {
  return { id: AGENT_ID, dir: 'durable-agent', name: 'Durable agent' };
}

async function makeAgentsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'monad-agent-create-'));
  roots.push(root);
  return join(root, 'agents');
}

async function mode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function transactionEntries(agentsRoot: string): Promise<string[]> {
  try {
    return await readdir(join(agentsRoot, '.create-transactions'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('agent prompt creation recovers after every staged, finalize, and cleanup checkpoint', async () => {
  for (const failedStep of CREATE_STEPS) {
    const agentsRoot = await makeAgentsRoot();
    const transactionPath = join(agentsRoot, '.create-transactions', AGENT_ID);
    const stagedPrompt = join(transactionPath, 'AGENT.md');
    const manifest = join(transactionPath, 'manifest.json');
    const finalPrompt = join(agentsRoot, 'durable-agent', 'AGENT.md');
    const options = {
      recoverOnFailure: false,
      afterStep(step: AgentCreateTransactionStep) {
        if (step === failedStep) throw new Error(`create interrupted: ${step}`);
      }
    };
    let transaction: Awaited<ReturnType<typeof stageAgentCreatePrompt>> | undefined;

    await expect(
      (async () => {
        transaction = await stageAgentCreatePrompt(
          agentsRoot,
          { id: AGENT_ID, dir: 'durable-agent', name: 'Durable agent', prompt: 'Durable prompt.' },
          options
        );
        await installAgentCreatePrompt(transaction, options);
        await completeAgentCreateTransaction(transaction, options);
      })()
    ).rejects.toThrow(`create interrupted: ${failedStep}`);

    if (process.platform !== 'win32') {
      expect(
        [await mode(transactionPath), await mode(stagedPrompt), await mode(manifest), await mode(finalPrompt)].every(
          (artifactMode) => artifactMode === null || artifactMode === 0o700 || artifactMode === 0o600
        )
      ).toBe(true);
    }
    const committed = CREATE_STEPS.indexOf(failedStep) >= CREATE_STEPS.indexOf('prompt-create:transaction-removed');
    await recoverAgentCreateTransactions(agentsRoot, committed ? [configuredAgent()] : []);

    expect({
      prompt: await Bun.file(finalPrompt)
        .exists()
        .then(async (exists) => (exists ? Bun.file(finalPrompt).text() : null)),
      transactions: await transactionEntries(agentsRoot)
    }).toEqual({
      prompt: committed ? expect.stringContaining('Durable prompt.') : null,
      transactions: []
    });
    if (process.platform !== 'win32') expect(await mode(finalPrompt)).toBe(committed ? 0o600 : null);
  }
});

test('restart finalizes a staged prompt when config committed and removes it when config did not commit', async () => {
  for (const committed of [false, true]) {
    const agentsRoot = await makeAgentsRoot();
    await stageAgentCreatePrompt(agentsRoot, {
      id: AGENT_ID,
      dir: 'durable-agent',
      name: 'Durable agent',
      prompt: 'Recovered prompt.'
    });

    await recoverAgentCreateTransactions(agentsRoot, committed ? [configuredAgent()] : []);

    expect({
      prompt: await Bun.file(join(agentsRoot, 'durable-agent', 'AGENT.md')).exists(),
      transactions: await transactionEntries(agentsRoot)
    }).toEqual({ prompt: committed, transactions: [] });
  }
});

test('live recovery owns one transaction and cannot delete another create paused after prompt install', async () => {
  const agentsRoot = await makeAgentsRoot();
  const transactionA = await stageAgentCreatePrompt(agentsRoot, {
    id: AGENT_ID,
    dir: 'agent-a',
    name: 'Agent A',
    prompt: 'Prompt A.'
  });
  const transactionB = await stageAgentCreatePrompt(agentsRoot, {
    id: AGENT_ID_B,
    dir: 'agent-b',
    name: 'Agent B',
    prompt: 'Prompt B.'
  });
  await installAgentCreatePrompt(transactionA);
  const bInstalled = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const installB = installAgentCreatePrompt(transactionB, {
    afterStep: async (step) => {
      if (step !== 'prompt-create:prompt-installed') return;
      bInstalled.resolve();
      await releaseB.promise;
    }
  });
  await bInstalled.promise;

  await recoverAgentCreateTransaction(transactionA, [{ id: AGENT_ID, dir: 'agent-a', name: 'Agent A' }]);
  expect({
    aPrompt: await Bun.file(join(agentsRoot, 'agent-a', 'AGENT.md')).exists(),
    aMarker: await Bun.file(transactionA.manifestPath).exists(),
    bPrompt: await Bun.file(join(agentsRoot, 'agent-b', 'AGENT.md')).exists(),
    bMarker: await Bun.file(transactionB.manifestPath).exists()
  }).toEqual({ aPrompt: true, aMarker: false, bPrompt: true, bMarker: true });

  releaseB.resolve();
  await installB;
  await completeAgentCreateTransaction(transactionB);
  expect({
    bPrompt: await Bun.file(join(agentsRoot, 'agent-b', 'AGENT.md')).exists(),
    transactions: await transactionEntries(agentsRoot)
  }).toEqual({ bPrompt: true, transactions: [] });
});

test('prompt staging rejects symlink and non-directory transaction roots before writing', async () => {
  for (const kind of ['symlink', 'file'] as const) {
    const agentsRoot = await makeAgentsRoot();
    await mkdir(agentsRoot, { recursive: true });
    const transactionRoot = join(agentsRoot, '.create-transactions');
    if (kind === 'symlink') {
      const target = join(agentsRoot, 'attacker-controlled');
      await mkdir(target);
      await symlink(target, transactionRoot);
    } else {
      await Bun.write(transactionRoot, 'not a directory');
    }

    await expect(
      stageAgentCreatePrompt(agentsRoot, {
        id: AGENT_ID,
        dir: 'safe-agent',
        name: 'Safe agent',
        prompt: 'Secret prompt.'
      })
    ).rejects.toThrow(`unsafe agent create transaction root: ${kind}`);
    expect(await Bun.file(join(transactionRoot, AGENT_ID, 'AGENT.md')).exists()).toBe(false);
  }
});

test('prompt staging securely repairs a same-owner transaction root to mode 0700', async () => {
  const agentsRoot = await makeAgentsRoot();
  const transactionRoot = join(agentsRoot, '.create-transactions');
  await mkdir(transactionRoot, { recursive: true, mode: 0o755 });
  await chmod(transactionRoot, 0o755);

  const transaction = await stageAgentCreatePrompt(agentsRoot, {
    id: AGENT_ID,
    dir: 'safe-agent',
    name: 'Safe agent',
    prompt: 'Private prompt.'
  });

  if (process.platform === 'win32') {
    expect({
      rootIsDirectory: (await lstat(transactionRoot)).isDirectory(),
      prompt: await Bun.file(transaction.stagedPromptPath).text()
    }).toEqual({ rootIsDirectory: true, prompt: expect.stringContaining('Private prompt.') });
  } else {
    expect({
      rootMode: (await lstat(transactionRoot)).mode & 0o777,
      promptMode: await mode(transaction.stagedPromptPath)
    }).toEqual({ rootMode: 0o700, promptMode: 0o600 });
  }
});

test('prompt staging aborts before secret write when the validated transaction root is swapped', async () => {
  const agentsRoot = await makeAgentsRoot();
  const transactionRoot = join(agentsRoot, '.create-transactions');
  const anchoredRoot = join(agentsRoot, '.create-transactions-anchored');
  const attackerRoot = join(agentsRoot, 'attacker-controlled');
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await mkdir(attackerRoot, { mode: 0o700 });
  let swapped = false;

  await expect(
    stageAgentCreatePrompt(
      agentsRoot,
      {
        id: AGENT_ID,
        dir: 'safe-agent',
        name: 'Safe agent',
        prompt: 'Secret prompt.'
      },
      {
        afterStep: async (step) => {
          if ((step as string) !== 'prompt-create:root-validated') return;
          swapped = true;
          await rename(transactionRoot, anchoredRoot);
          await symlink(attackerRoot, transactionRoot);
        }
      }
    )
  ).rejects.toThrow('unsafe agent create transaction root: replaced');

  expect({
    swapped,
    anchoredPrompt: await Bun.file(join(anchoredRoot, AGENT_ID, 'AGENT.md')).exists(),
    attackerPrompt: await Bun.file(join(attackerRoot, AGENT_ID, 'AGENT.md')).exists()
  }).toEqual({ swapped: true, anchoredPrompt: false, attackerPrompt: false });
});

test('startup prompt recovery aborts before scanning a swapped transaction root', async () => {
  const agentsRoot = await makeAgentsRoot();
  const transaction = await stageAgentCreatePrompt(agentsRoot, {
    id: AGENT_ID,
    dir: 'durable-agent',
    name: 'Durable agent',
    prompt: 'Durable prompt.'
  });
  const anchoredRoot = join(agentsRoot, '.create-transactions-anchored');
  const attackerRoot = join(agentsRoot, 'attacker-controlled');
  const attackerMarker = join(attackerRoot, 'must-remain');
  await mkdir(attackerRoot, { mode: 0o700 });
  await Bun.write(attackerMarker, 'attacker-owned');
  let swapped = false;
  const recoverWithOptions = recoverAgentCreateTransactions as unknown as (
    root: string,
    agents: Array<Pick<AgentConfig, 'id' | 'dir' | 'name'>>,
    options: { afterStep(step: string): void | Promise<void> }
  ) => Promise<void>;

  await expect(
    recoverWithOptions(agentsRoot, [configuredAgent()], {
      afterStep: async (step) => {
        if (step !== 'prompt-create:startup-root-validated') return;
        swapped = true;
        await rename(transaction.transactionRoot, anchoredRoot);
        await symlink(attackerRoot, transaction.transactionRoot);
      }
    })
  ).rejects.toThrow('unsafe agent create transaction root: replaced');

  expect({
    swapped,
    attackerMarker: await Bun.file(attackerMarker).text(),
    anchoredPrompt: await Bun.file(join(anchoredRoot, AGENT_ID, 'AGENT.md')).exists(),
    finalPrompt: await Bun.file(transaction.finalPromptPath).exists()
  }).toEqual({
    swapped: true,
    attackerMarker: 'attacker-owned',
    anchoredPrompt: true,
    finalPrompt: false
  });
});

test('prompt transaction root validation rejects a directory owned by a different user where ownership is available', async () => {
  if (typeof process.getuid !== 'function') return;
  const agentsRoot = await makeAgentsRoot();
  const transactionRoot = join(agentsRoot, '.create-transactions');
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  const actualUid = (await lstat(transactionRoot)).uid;

  await expect(ensureSecureAgentCreateTransactionRoot(agentsRoot, { expectedOwnerUid: actualUid + 1 })).rejects.toThrow(
    'unsafe agent create transaction root: owner'
  );
});
