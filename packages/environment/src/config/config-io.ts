import type { MonadPaths } from '../paths.ts';
import type { MonadAgentsConfig } from './agents.ts';
import type { MonadMeshConfig } from './mesh.ts';

import { CURRENT_AGENTS_VERSION, getAgentsSchemaUrl, monadAgentsConfigSchema } from './agents.ts';
import { getAuthSchemaUrl, type MonadAuth, monadAuthSchema } from './auth.ts';
import {
  CURRENT_CONFIG_VERSION,
  getConfigSchemaUrl,
  logAutoCleanupSchema,
  type MonadConfig,
  type MonadSystemConfig,
  monadConfigSchema,
  monadSystemConfigSchema
} from './config.ts';
import { friendlySchemaError } from './config-errors.ts';
import {
  type ConfigSnapshotDocument,
  type ConfigSnapshotTransactionOptions,
  recoverConfigSnapshotTransaction,
  saveConfigSnapshotTransaction,
  secureAtomicWrite
} from './config-snapshot-transaction.ts';
import { CURRENT_MESH_VERSION, getMeshSchemaUrl, monadMeshConfigSchema } from './mesh.ts';

export type {
  ConfigSnapshotTransactionOptions,
  ConfigSnapshotTransactionStep
} from './config-snapshot-transaction.ts';

export type ConfigFilePaths = Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>;
export type ConfigSnapshotPaths = Pick<MonadPaths, 'home' | 'auth' | 'config' | 'agentsConfig' | 'mesh'>;

export interface PersistedConfigSnapshot {
  cfg: MonadConfig;
  auth: MonadAuth | null;
}

const SNAPSHOT_DOCUMENTS = ['config', 'agents', 'mesh', 'auth'] as const;

export interface ParsedSystemConfig {
  cfg: MonadSystemConfig;
  warnings: string[];
}

export async function migrateConfig(raw: unknown): Promise<MonadConfig> {
  return monadConfigSchema.parse(raw);
}

export async function tryParseConfig(raw: unknown): Promise<MonadConfig | null> {
  try {
    return await migrateConfig(raw);
  } catch {
    return null;
  }
}

export async function tryParseAgents(agentsPath: string): Promise<MonadAgentsConfig | null> {
  try {
    const raw = await readJson('agents.json', agentsPath);
    return parseAgents(raw);
  } catch {
    return null;
  }
}

function parseAgents(raw: unknown): MonadAgentsConfig {
  return monadAgentsConfigSchema.parse(raw);
}

function mergeConfigs(system: MonadSystemConfig, agents: MonadAgentsConfig, mesh: MonadMeshConfig): MonadConfig {
  return monadConfigSchema.parse({ ...system, ...agents, ...mesh, version: system.version });
}

export function parseSystemConfigWithWarnings(raw: unknown): ParsedSystemConfig {
  const normalized = normalizeLogAutoCleanup(raw);
  return { cfg: monadSystemConfigSchema.parse(normalized.raw), warnings: normalized.warnings };
}

function normalizeLogAutoCleanup(raw: unknown): { raw: unknown; warnings: string[] } {
  if (!isRecord(raw) || !isRecord(raw.logs) || !('autoCleanup' in raw.logs)) {
    return { raw, warnings: [] };
  }
  if (logAutoCleanupSchema.safeParse(raw.logs.autoCleanup).success) {
    return { raw, warnings: [] };
  }
  return {
    raw: {
      ...raw,
      logs: { ...raw.logs, autoCleanup: { enabled: true, retentionDays: 14 } }
    },
    warnings: ['logs.autoCleanup']
  };
}

function extractConfig(cfg: MonadConfig): MonadSystemConfig {
  return monadSystemConfigSchema.parse({
    version: CURRENT_CONFIG_VERSION,
    developerMode: cfg.developerMode,
    user: cfg.user,
    appearance: cfg.appearance,
    network: cfg.network,
    channels: cfg.channels,
    logs: cfg.logs,
    locale: cfg.locale,
    atomPins: cfg.atomPins,
    atomExperienceReview: cfg.atomExperienceReview,
    atomRegistries: cfg.atomRegistries,
    observability: cfg.observability,
    openaiCompat: cfg.openaiCompat
  });
}

function extractAgents(cfg: MonadConfig): MonadAgentsConfig {
  return monadAgentsConfigSchema.parse({
    version: CURRENT_AGENTS_VERSION,
    model: cfg.model,
    agent: cfg.agent,
    sandbox: cfg.sandbox,
    skills: cfg.skills,
    mcpServers: cfg.mcpServers,
    browser: cfg.browser,
    computer: cfg.computer,
    obscura: cfg.obscura,
    hooks: cfg.hooks,
    policyHooks: cfg.policyHooks,
    memory: cfg.memory,
    context: cfg.context
  });
}

function extractMesh(cfg: MonadConfig): MonadMeshConfig {
  return monadMeshConfigSchema.parse({
    version: CURRENT_MESH_VERSION,
    acpAgents: cfg.acpAgents,
    meshAgents: cfg.meshAgents,
    peers: cfg.peers,
    monadix: cfg.monadix
  });
}

export async function loadAll(paths: ConfigFilePaths): Promise<MonadConfig | null> {
  const [rawConfig, rawAgents, rawMesh] = await Promise.all([
    readOptionalJson('config.json', paths.config),
    readOptionalJson('agents.json', paths.agentsConfig),
    readOptionalJson('mesh.json', paths.mesh)
  ]);
  if (rawConfig === null && rawAgents === null && rawMesh === null) return null;
  if (rawConfig === null) throw new Error(`monad: config.json is missing at ${paths.config}.`);
  if (rawAgents === null) throw new Error(`monad: agents.json is missing at ${paths.agentsConfig}.`);
  if (rawMesh === null) throw new Error(`monad: mesh.json is missing at ${paths.mesh}.`);

  let system: MonadSystemConfig;
  let agents: MonadAgentsConfig;
  let mesh: MonadMeshConfig;
  try {
    system = parseSystemConfigWithWarnings(rawConfig).cfg;
  } catch (error) {
    throw friendlySchemaError('config.json', paths.config, error);
  }
  try {
    agents = parseAgents(rawAgents);
  } catch (error) {
    throw friendlySchemaError('agents.json', paths.agentsConfig, error);
  }
  try {
    mesh = monadMeshConfigSchema.parse(rawMesh);
  } catch (error) {
    throw friendlySchemaError('mesh.json', paths.mesh, error);
  }
  return mergeConfigs(system, agents, mesh);
}

export async function loadSnapshot(paths: ConfigSnapshotPaths): Promise<PersistedConfigSnapshot | null> {
  await recoverConfigSnapshot(paths);
  const [cfg, auth] = await Promise.all([loadAll(paths), loadAuth(paths.auth)]);
  return cfg === null ? null : { cfg, auth };
}

export async function saveConfig(configPath: string, cfg: MonadConfig): Promise<void> {
  await writeDocument(configPath, getConfigSchemaUrl(), extractConfig(cfg));
}

export async function saveAgents(agentsPath: string, cfg: MonadConfig): Promise<void> {
  await writeDocument(agentsPath, getAgentsSchemaUrl(), extractAgents(cfg));
}

export async function saveMesh(meshPath: string, cfg: MonadConfig): Promise<void> {
  await writeDocument(meshPath, getMeshSchemaUrl(), extractMesh(cfg));
}

export async function saveAll(paths: ConfigFilePaths, cfg: MonadConfig): Promise<void> {
  await saveConfig(paths.config, cfg);
  await saveAgents(paths.agentsConfig, cfg);
  await saveMesh(paths.mesh, cfg);
}

export async function tryParseAuth(raw: unknown): Promise<MonadAuth | null> {
  try {
    return monadAuthSchema.parse(withoutSchemaMarker(raw));
  } catch {
    return null;
  }
}

export async function loadConfig(paths: ConfigFilePaths): Promise<MonadConfig | null> {
  return loadAll(paths);
}

export async function loadAuth(authPath: string): Promise<MonadAuth | null> {
  try {
    return monadAuthSchema.parse(withoutSchemaMarker(await readJson('auth.json', authPath)));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw friendlySchemaError('auth.json', authPath, error);
  }
}

export async function saveAuth(authPath: string, auth: MonadAuth): Promise<void> {
  try {
    monadAuthSchema.parse(auth);
  } catch (error) {
    throw friendlySchemaError('auth.json', authPath, error);
  }
  await writeDocument(authPath, getAuthSchemaUrl(), auth);
}

export async function saveSnapshot(
  paths: ConfigSnapshotPaths,
  previous: PersistedConfigSnapshot,
  next: PersistedConfigSnapshot,
  options: ConfigSnapshotTransactionOptions = {}
): Promise<void> {
  const documents = SNAPSHOT_DOCUMENTS.flatMap((name) => {
    const previousContent = snapshotDocumentContent(name, previous);
    const nextContent = snapshotDocumentContent(name, next);
    if (previousContent === nextContent) return [];
    if (nextContent === null) throw new Error(`monad: snapshot transaction cannot remove ${name}.json`);
    return [
      {
        name,
        target: documentPath(paths, name),
        previousContent,
        nextContent,
        normalize: (content: string) => JSON.stringify(parseSnapshotDocument(name, JSON.parse(content)))
      }
    ];
  });
  await saveConfigSnapshotTransaction(snapshotTransactionLayout(paths), documents, options);
}

export async function recoverConfigSnapshot(
  paths: ConfigSnapshotPaths,
  options: ConfigSnapshotTransactionOptions = {}
): Promise<void> {
  await recoverConfigSnapshotTransaction(snapshotTransactionLayout(paths), options);
}

async function readOptionalJson(label: string, filePath: string): Promise<unknown | null> {
  try {
    return await readJson(label, filePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readJson(label: string, filePath: string): Promise<unknown> {
  const raw = await Bun.file(filePath).text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`monad: ${label} is not valid JSON at ${filePath}. Fix the file and retry.`);
  }
}

async function writeDocument(filePath: string, schemaUrl: string, value: object): Promise<void> {
  await secureAtomicWrite(filePath, `${JSON.stringify({ $schema: schemaUrl, ...value }, null, 2)}\n`);
}

function snapshotDocumentValue(name: ConfigSnapshotDocument, snapshot: PersistedConfigSnapshot): object | null {
  if (name === 'config') return extractConfig(snapshot.cfg);
  if (name === 'agents') return extractAgents(snapshot.cfg);
  if (name === 'mesh') return extractMesh(snapshot.cfg);
  return snapshot.auth;
}

function snapshotDocumentContent(name: ConfigSnapshotDocument, snapshot: PersistedConfigSnapshot): string | null {
  const value = snapshotDocumentValue(name, snapshot);
  if (value === null) return null;
  const schemaUrl =
    name === 'config'
      ? getConfigSchemaUrl()
      : name === 'agents'
        ? getAgentsSchemaUrl()
        : name === 'mesh'
          ? getMeshSchemaUrl()
          : getAuthSchemaUrl();
  return `${JSON.stringify({ $schema: schemaUrl, ...value }, null, 2)}\n`;
}

function parseSnapshotDocument(name: ConfigSnapshotDocument, raw: unknown): object {
  const value = withoutSchemaMarker(raw);
  if (name === 'config') {
    return monadSystemConfigSchema.parse(value);
  }
  if (name === 'agents') {
    return monadAgentsConfigSchema.parse(value);
  }
  if (name === 'mesh') {
    return monadMeshConfigSchema.parse(value);
  }
  return monadAuthSchema.parse(value);
}

function documentPath(paths: ConfigSnapshotPaths, name: ConfigSnapshotDocument): string {
  if (name === 'agents') return paths.agentsConfig;
  return paths[name];
}

function snapshotTransactionLayout(paths: ConfigSnapshotPaths) {
  return {
    home: paths.home,
    manifestPath: `${paths.auth}.snapshot-transaction.json`,
    documents: SNAPSHOT_DOCUMENTS.map((name) => ({ name, target: documentPath(paths, name) }))
  };
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutSchemaMarker(value: unknown): unknown {
  if (!isRecord(value) || !('$schema' in value)) return value;
  const { $schema: _, ...document } = value;
  return document;
}
