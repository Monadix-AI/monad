import type { Dirent } from 'node:fs';
import type { AgentConfig } from '@monad/environment';
import type { AgentId } from '@monad/protocol';
import type { AgentCreateTransactionRoot, AnchoredDirectory } from './agent-create-transaction-root.ts';

import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { agentIdSchema } from '@monad/protocol';

import {
  assertAnchoredDirectory,
  isAnchoredDirectoryCurrent,
  openAgentCreateTransactionRoot,
  openAnchoredDirectory,
  syncAnchoredDirectory
} from './agent-create-transaction-root.ts';
import { assertValidAgentDir, composeAgentMd, toAgentDir } from './agent-def.ts';

export { ensureSecureAgentCreateTransactionRoot } from './agent-create-transaction-root.ts';

export type AgentCreateTransactionStep =
  | 'prompt-create:root-created'
  | 'prompt-create:root-directory-synced'
  | 'prompt-create:root-validated'
  | 'prompt-create:startup-root-validated'
  | 'prompt-create:transaction-created'
  | 'prompt-create:transaction-directory-synced'
  | 'prompt-create:prompt-created-secure'
  | 'prompt-create:prompt-written'
  | 'prompt-create:prompt-synced'
  | 'prompt-create:prompt-directory-synced'
  | 'prompt-create:manifest-created-secure'
  | 'prompt-create:manifest-written'
  | 'prompt-create:manifest-synced'
  | 'prompt-create:manifest-directory-synced'
  | 'prompt-create:target-created'
  | 'prompt-create:target-directory-synced'
  | 'prompt-create:prompt-installed'
  | 'prompt-create:prompt-source-directory-synced'
  | 'prompt-create:prompt-install-directory-synced'
  | 'prompt-create:transaction-removed'
  | 'prompt-create:transaction-root-directory-synced';

export interface AgentCreateTransactionOptions {
  afterStep?(step: AgentCreateTransactionStep): void | Promise<void>;
  recoverOnFailure?: boolean;
}

export interface AgentCreatePromptInput {
  id: AgentId;
  dir: string;
  name: string;
  prompt: string;
}

export interface AgentCreatePromptTransaction {
  agentsRoot: string;
  transactionRoot: string;
  transactionPath: string;
  stagedPromptPath: string;
  manifestPath: string;
  finalDirectory: string;
  finalPromptPath: string;
  manifest: AgentCreateManifest;
}

interface AgentCreateManifest {
  version: 1;
  agentId: AgentId;
  dir: string;
}

const TRANSACTION_ROOT = '.create-transactions';
const PROMPT_FILE = 'AGENT.md';
const MANIFEST_FILE = 'manifest.json';
const transactionLocks = new Map<string, Promise<void>>();

export async function stageAgentCreatePrompt(
  agentsRoot: string,
  input: AgentCreatePromptInput,
  options: AgentCreateTransactionOptions = {}
): Promise<AgentCreatePromptTransaction> {
  agentIdSchema.parse(input.id);
  assertValidAgentDir(input.dir);
  const root = await openAgentCreateTransactionRoot(agentsRoot);
  if (root === null) throw new Error('monad: unsafe agent create transaction root: missing');
  try {
    if (root.created) {
      await options.afterStep?.('prompt-create:root-created');
      await syncDirectory(agentsRoot);
      await options.afterStep?.('prompt-create:root-directory-synced');
    }
    await options.afterStep?.('prompt-create:root-validated');
    await assertAnchoredDirectory(root);
    const transaction = transactionFor(agentsRoot, input.id, input.dir);
    return await withTransactionLock(transaction.transactionPath, async () => {
      let transactionDirectory: AnchoredDirectory | null = null;
      try {
        await assertAnchoredDirectory(root);
        await mkdir(transaction.transactionPath, { mode: 0o700 });
        await assertAnchoredDirectory(root);
        transactionDirectory = await openAnchoredDirectory(transaction.transactionPath);
        await assertAnchoredDirectory(root);
        await options.afterStep?.('prompt-create:transaction-created');
        await syncAnchoredDirectory(root);
        await options.afterStep?.('prompt-create:transaction-directory-synced');
        await writeSecureFile(
          transaction.stagedPromptPath,
          composeAgentMd({ name: input.name }, input.prompt),
          'prompt',
          options,
          root,
          transactionDirectory
        );
        await writeSecureFile(
          transaction.manifestPath,
          `${JSON.stringify(transaction.manifest, null, 2)}\n`,
          'manifest',
          options,
          root,
          transactionDirectory
        );
        return transaction;
      } catch (error) {
        if (
          options.recoverOnFailure !== false &&
          (await isAnchoredDirectoryCurrent(root)) &&
          (transactionDirectory === null || (await isAnchoredDirectoryCurrent(transactionDirectory)))
        ) {
          await rm(transaction.transactionPath, { recursive: true, force: true }).catch(() => {});
          await syncAnchoredDirectory(root).catch(() => {});
        }
        throw error;
      } finally {
        await transactionDirectory?.handle.close();
      }
    });
  } finally {
    await root.handle.close();
  }
}

export async function installAgentCreatePrompt(
  transaction: AgentCreatePromptTransaction,
  options: AgentCreateTransactionOptions = {}
): Promise<void> {
  await withTransactionLock(transaction.transactionPath, async () => {
    parseManifest(await readFile(transaction.manifestPath, 'utf8'));
    try {
      await mkdir(transaction.finalDirectory, { mode: 0o700 });
      await options.afterStep?.('prompt-create:target-created');
      await syncDirectory(transaction.agentsRoot);
      await options.afterStep?.('prompt-create:target-directory-synced');
      await rename(transaction.stagedPromptPath, transaction.finalPromptPath);
      await options.afterStep?.('prompt-create:prompt-installed');
      await syncDirectory(transaction.transactionPath);
      await options.afterStep?.('prompt-create:prompt-source-directory-synced');
      await syncDirectory(transaction.finalDirectory);
      await options.afterStep?.('prompt-create:prompt-install-directory-synced');
    } catch (error) {
      if (options.recoverOnFailure !== false) {
        await reconcileTransaction(transaction, []).catch(() => {});
      }
      throw error;
    }
  });
}

export async function completeAgentCreateTransaction(
  transaction: AgentCreatePromptTransaction,
  options: AgentCreateTransactionOptions = {}
): Promise<void> {
  await withTransactionLock(transaction.transactionPath, async () => {
    await rm(transaction.transactionPath, { recursive: true, force: true });
    await options.afterStep?.('prompt-create:transaction-removed');
    await syncDirectory(transaction.transactionRoot);
    await options.afterStep?.('prompt-create:transaction-root-directory-synced');
  });
}

export async function recoverAgentCreateTransaction(
  transaction: AgentCreatePromptTransaction,
  agents: Array<Pick<AgentConfig, 'id' | 'dir' | 'name'>>
): Promise<void> {
  await withTransactionLock(transaction.transactionPath, () => reconcileTransaction(transaction, agents));
}

export async function recoverAgentCreateTransactions(
  agentsRoot: string,
  agents: Array<Pick<AgentConfig, 'id' | 'dir' | 'name'>>,
  options: AgentCreateTransactionOptions = {}
): Promise<void> {
  const root = await openAgentCreateTransactionRoot(agentsRoot, { create: false });
  if (root === null) return;
  try {
    try {
      await options.afterStep?.('prompt-create:startup-root-validated');
      await assertAnchoredDirectory(root);
      const entries = await readdir(root.path, { withFileTypes: true });
      await assertAnchoredDirectory(root);
      const configured = new Map(agents.map((agent) => [agent.id, agent]));
      for (const entry of entries) {
        await recoverTransactionEntry(root, entry, configured);
      }
    } finally {
      await syncDirectory(agentsRoot);
    }
  } finally {
    await root.handle.close();
  }
}

async function recoverTransactionEntry(
  root: AgentCreateTransactionRoot,
  entry: Dirent,
  configured: Map<AgentId, Pick<AgentConfig, 'id' | 'dir' | 'name'>>
): Promise<void> {
  await assertAnchoredDirectory(root);
  const transactionPath = join(root.path, entry.name);
  if (!entry.isDirectory()) {
    await withTransactionLock(transactionPath, async () => {
      await assertAnchoredDirectory(root);
      await rm(transactionPath, { force: true });
      await assertAnchoredDirectory(root);
      await syncAnchoredDirectory(root);
    });
    return;
  }
  let manifest: AgentCreateManifest | null = null;
  try {
    manifest = parseManifest(await readFile(join(transactionPath, MANIFEST_FILE), 'utf8'));
    await assertAnchoredDirectory(root);
  } catch {
    manifest = null;
  }
  if (manifest === null) {
    await withTransactionLock(transactionPath, async () => {
      await assertAnchoredDirectory(root);
      await rm(transactionPath, { recursive: true, force: true });
      await assertAnchoredDirectory(root);
      await syncAnchoredDirectory(root);
    });
    return;
  }
  const transaction = transactionFor(join(root.path, '..'), manifest.agentId, manifest.dir);
  await withTransactionLock(transaction.transactionPath, () =>
    reconcileTransaction(transaction, [...configured.values()], root)
  );
}

async function reconcileTransaction(
  transaction: AgentCreatePromptTransaction,
  agents: Array<Pick<AgentConfig, 'id' | 'dir' | 'name'>>,
  root?: AgentCreateTransactionRoot
): Promise<void> {
  if (root) await assertAnchoredDirectory(root);
  const agent = agents.find((candidate) => candidate.id === transaction.manifest.agentId);
  if (agent) {
    const configuredDir = agent.dir ?? toAgentDir(agent.name);
    assertValidAgentDir(configuredDir);
    if (configuredDir !== transaction.manifest.dir) {
      throw new Error('monad: agent create recovery directory mismatch');
    }
    if (!(await exists(transaction.finalPromptPath))) {
      if (!(await exists(transaction.stagedPromptPath))) {
        throw new Error(`monad: agent create recovery evidence missing: ${transaction.manifest.agentId}`);
      }
      await mkdir(transaction.finalDirectory, { recursive: true, mode: 0o700 });
      await rename(transaction.stagedPromptPath, transaction.finalPromptPath);
      if (root) await assertAnchoredDirectory(root);
      await syncDirectory(transaction.transactionPath);
      await syncDirectory(transaction.finalDirectory);
      await syncDirectory(transaction.agentsRoot);
    }
  } else {
    const conflicting = agents.some(
      (candidate) => (candidate.dir ?? toAgentDir(candidate.name)) === transaction.manifest.dir
    );
    if (conflicting) throw new Error('monad: agent create recovery directory conflict');
    await rm(transaction.finalDirectory, { recursive: true, force: true });
    await syncDirectory(transaction.agentsRoot);
  }
  if (root) await assertAnchoredDirectory(root);
  await rm(transaction.transactionPath, { recursive: true, force: true });
  if (root) {
    await assertAnchoredDirectory(root);
    await syncAnchoredDirectory(root);
  } else {
    await syncDirectory(transaction.transactionRoot);
  }
}

function transactionFor(agentsRoot: string, agentId: AgentId, dir: string): AgentCreatePromptTransaction {
  agentIdSchema.parse(agentId);
  assertValidAgentDir(dir);
  const transactionRoot = join(agentsRoot, TRANSACTION_ROOT);
  const transactionPath = join(transactionRoot, agentId);
  const manifest: AgentCreateManifest = { version: 1, agentId, dir };
  const finalDirectory = join(agentsRoot, dir);
  return {
    agentsRoot,
    transactionRoot,
    transactionPath,
    stagedPromptPath: join(transactionPath, PROMPT_FILE),
    manifestPath: join(transactionPath, MANIFEST_FILE),
    finalDirectory,
    finalPromptPath: join(finalDirectory, PROMPT_FILE),
    manifest
  };
}

function parseManifest(raw: string): AgentCreateManifest {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.version !== 1 || typeof value.dir !== 'string') {
    throw new Error('monad: invalid agent create recovery manifest');
  }
  const agentId = agentIdSchema.parse(value.agentId);
  assertValidAgentDir(value.dir);
  return { version: 1, agentId, dir: value.dir };
}

async function writeSecureFile(
  path: string,
  content: string,
  kind: 'prompt' | 'manifest',
  options: AgentCreateTransactionOptions,
  root: AgentCreateTransactionRoot,
  parent: AnchoredDirectory
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await assertAnchoredDirectory(root);
    await assertAnchoredDirectory(parent);
    await options.afterStep?.(`prompt-create:${kind}-created-secure`);
    await assertAnchoredDirectory(root);
    await assertAnchoredDirectory(parent);
    await handle.writeFile(content);
    await options.afterStep?.(`prompt-create:${kind}-written`);
    await handle.sync();
    await options.afterStep?.(`prompt-create:${kind}-synced`);
  } finally {
    await handle.close();
  }
  await assertAnchoredDirectory(root);
  await assertAnchoredDirectory(parent);
  await syncAnchoredDirectory(parent);
  await options.afterStep?.(`prompt-create:${kind}-directory-synced`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withTransactionLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = transactionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  transactionLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (transactionLocks.get(key) === tail) transactionLocks.delete(key);
  }
}
