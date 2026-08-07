import type { AgentConfig } from '@monad/environment';
import type { AgentCreateTransactionStep } from '#/store/home/agent-create-transaction.ts';

import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completeAgentCreateTransaction,
  ensureSecureAgentCreateTransactionRoot,
  installAgentCreatePrompt,
  recoverAgentCreateTransactions,
  stageAgentCreatePrompt
} from '#/store/home/agent-create-transaction.ts';

const AGENT_ID = 'agt_000000000001' as const;
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
  const root = await mkdtemp(join(tmpdir(), 'monad-agent-create-unix-'));
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('agent prompt creation keeps transaction artifacts private through every recovery checkpoint', async () => {
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

    await expect(
      (async () => {
        const transaction = await stageAgentCreatePrompt(
          agentsRoot,
          { id: AGENT_ID, dir: 'durable-agent', name: 'Durable agent', prompt: 'Durable prompt.' },
          options
        );
        await installAgentCreatePrompt(transaction, options);
        await completeAgentCreateTransaction(transaction, options);
      })()
    ).rejects.toThrow(`create interrupted: ${failedStep}`);

    const artifactModes = await Promise.all(
      [transactionPath, stagedPrompt, manifest, finalPrompt].map((path) => mode(path))
    );
    expect(artifactModes.every((value) => value === null || value === 0o700 || value === 0o600)).toBe(true);

    const committed = CREATE_STEPS.indexOf(failedStep) >= CREATE_STEPS.indexOf('prompt-create:transaction-removed');
    await recoverAgentCreateTransactions(agentsRoot, committed ? [configuredAgent()] : []);
    expect(await mode(finalPrompt)).toBe(committed ? 0o600 : null);
  }
});

test('prompt staging repairs a same-owner transaction root and private prompt modes', async () => {
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

  expect({
    rootMode: (await lstat(transactionRoot)).mode & 0o777,
    promptMode: await mode(transaction.stagedPromptPath),
    prompt: await Bun.file(transaction.stagedPromptPath).text()
  }).toEqual({ rootMode: 0o700, promptMode: 0o600, prompt: expect.stringContaining('Private prompt.') });
});

test('prompt transaction root validation rejects a directory owned by a different user', async () => {
  const agentsRoot = await makeAgentsRoot();
  const transactionRoot = join(agentsRoot, '.create-transactions');
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  const actualUid = (await lstat(transactionRoot)).uid;

  await expect(ensureSecureAgentCreateTransactionRoot(agentsRoot, { expectedOwnerUid: actualUid + 1 })).rejects.toThrow(
    'unsafe agent create transaction root: owner'
  );
});
