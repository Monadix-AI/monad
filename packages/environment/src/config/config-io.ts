import type { MonadPaths } from '../paths.ts';
import type { MonadAgentsConfig } from './agents.ts';
import type { MonadMeshConfig } from './mesh.ts';

import { chmod, rename, unlink } from 'node:fs/promises';

import { CURRENT_AGENTS_VERSION, getAgentsSchemaUrl, monadAgentsConfigSchema } from './agents.ts';
import { getAuthSchemaUrl, type MonadAuth, monadAuthSchema } from './auth.ts';
import {
  CURRENT_CONFIG_VERSION,
  getConfigSchemaUrl,
  type MonadConfig,
  type MonadSystemConfig,
  monadConfigSchema,
  monadSystemConfigSchema
} from './config.ts';
import { friendlySchemaError } from './config-errors.ts';
import { CURRENT_MESH_VERSION, getMeshSchemaUrl, monadMeshConfigSchema } from './mesh.ts';

export type ConfigFilePaths = Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>;

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

function extractConfig(cfg: MonadConfig): MonadSystemConfig {
  return monadSystemConfigSchema.parse({
    version: CURRENT_CONFIG_VERSION,
    developerMode: cfg.developerMode,
    user: cfg.user,
    appearance: cfg.appearance,
    network: cfg.network,
    channels: cfg.channels,
    mo: cfg.mo,
    locale: cfg.locale,
    atomPins: cfg.atomPins,
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
    system = monadSystemConfigSchema.parse(rawConfig);
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
    return monadAuthSchema.parse(raw);
  } catch {
    return null;
  }
}

export async function loadConfig(paths: ConfigFilePaths): Promise<MonadConfig | null> {
  return loadAll(paths);
}

export async function loadAuth(authPath: string): Promise<MonadAuth | null> {
  try {
    return monadAuthSchema.parse(await readJson('auth.json', authPath));
  } catch (error) {
    if (isMissingFile(error)) return null;
    return null;
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
  await atomicWrite(filePath, `${JSON.stringify({ $schema: schemaUrl, ...value }, null, 2)}\n`);
  await setSecurePermissions(filePath);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await Bun.write(tmp, content);
  if (process.platform === 'win32') {
    try {
      await unlink(filePath);
    } catch {
      // The target may not exist yet.
    }
  }
  await rename(tmp, filePath);
}

async function setSecurePermissions(filePath: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
