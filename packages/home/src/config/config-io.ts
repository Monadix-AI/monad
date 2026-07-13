import { chmod, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runMigrations } from '../migrate.ts';
import { friendlySchemaError } from './config-errors.ts';
import { CURRENT_AUTH_VERSION, type MonadAuth, monadAuthSchema } from './config-schema.ts';
import {
  CURRENT_CONFIG_VERSION,
  CURRENT_PROFILE_VERSION,
  getProfileSchemaUrl,
  getSchemaUrl,
  type MonadConfig,
  type MonadProfile,
  type MonadSystemConfig,
  monadConfigSchema,
  monadProfileSchema,
  monadSystemConfigSchema,
  type SandboxConfig,
  sandboxConfigSchema
} from './index.ts';

const CONFIG_MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations', 'config');
const PROFILE_MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations', 'profile');
const AUTH_MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations', 'auth');

function migrateSandboxBackend(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'activeBackend' in raw) return raw;
  const sandbox = raw as Record<string, unknown>;
  const backend = sandbox.backend;
  const activeBackend =
    backend === 'vm'
      ? { source: 'builtin', kind: 'vm' }
      : backend === 'docker' || backend === 'e2b'
        ? { source: 'atom-pack', packId: 'monad-power-pack', kind: backend }
        : { source: 'builtin', kind: 'auto' };
  return { ...sandbox, activeBackend };
}

export async function migrateConfig(raw: unknown): Promise<MonadConfig> {
  return runMigrations(raw, CURRENT_CONFIG_VERSION, CONFIG_MIGRATIONS_DIR, (data) => monadConfigSchema.parse(data));
}

export async function tryParseConfig(raw: unknown): Promise<MonadConfig | null> {
  try {
    return await migrateConfig(raw);
  } catch {
    return null;
  }
}

export async function tryParseProfile(profilePath: string): Promise<MonadProfile | null> {
  try {
    const raw = JSON.parse(await Bun.file(profilePath).text());
    return await migrateProfile(raw);
  } catch {
    return null;
  }
}

async function migrateSystemConfig(raw: unknown): Promise<MonadSystemConfig> {
  return runMigrations(raw, CURRENT_CONFIG_VERSION, CONFIG_MIGRATIONS_DIR, (data) =>
    monadSystemConfigSchema.parse(data)
  );
}

async function migrateProfile(raw: unknown): Promise<MonadProfile> {
  return runMigrations(raw, CURRENT_PROFILE_VERSION, PROFILE_MIGRATIONS_DIR, (data) => monadProfileSchema.parse(data));
}

function mergeConfigs(system: MonadSystemConfig, profile: MonadProfile, sandbox: SandboxConfig): MonadConfig {
  return {
    version: system.version,
    principal: system.principal,
    user: profile.user,
    appearance: profile.appearance,
    network: system.network,
    agent: {
      ...system.agent,
      tools: { ...system.agent.tools, ...profile.agent.tools },
      agents: profile.agent.agents,
      defaultAgentId: profile.agent.defaultAgentId
    },
    sandbox,
    mcpServers: system.mcpServers,
    acpAgents: system.acpAgents,
    externalAgents: system.externalAgents,
    peers: system.peers,
    developerMode: system.developerMode,
    model: profile.model,
    skills: profile.skills,
    browser: profile.browser,
    computer: profile.computer,
    mo: profile.mo,
    obscura: profile.obscura,
    channels: profile.channels,
    locale: profile.locale,
    atomPins: profile.atomPins,
    hooks: profile.hooks,
    observability: system.observability,
    openaiCompat: profile.openaiCompat,
    memory: profile.memory,
    context: profile.context
  };
}

// Extract only the system fields from a full MonadConfig for writing to config.json.
function extractSystemConfig(cfg: MonadConfig): MonadSystemConfig {
  return monadSystemConfigSchema.parse({
    version: cfg.version,
    principal: cfg.principal,
    network: cfg.network,
    agent: {
      globalSandbox: cfg.agent.globalSandbox,
      tools: cfg.agent.tools,
      // Round-trip the operator approval policy; omitting it lets the schema default ({}) silently
      // overwrite the on-disk allow/deny/ask rules on every system-config save.
      approvals: cfg.agent.approvals
    },
    mcpServers: cfg.mcpServers,
    acpAgents: cfg.acpAgents,
    externalAgents: cfg.externalAgents,
    peers: cfg.peers,
    developerMode: cfg.developerMode,
    observability: cfg.observability
  });
}

// Extract only the profile fields from a full MonadConfig for writing to profile.json.
function extractProfile(cfg: MonadConfig): MonadProfile {
  return monadProfileSchema.parse({
    version: CURRENT_PROFILE_VERSION,
    user: cfg.user,
    appearance: cfg.appearance,
    model: cfg.model,
    agent: {
      agents: cfg.agent.agents,
      defaultAgentId: cfg.agent.defaultAgentId,
      tools: {
        webSearch: cfg.agent.tools.webSearch,
        email: cfg.agent.tools.email,
        codeExecBackend: cfg.agent.tools.codeExecBackend,
        codeExecE2b: cfg.agent.tools.codeExecE2b,
        codeExecDocker: cfg.agent.tools.codeExecDocker
      }
    },
    skills: cfg.skills,
    browser: cfg.browser,
    computer: cfg.computer,
    mo: cfg.mo,
    obscura: cfg.obscura,
    channels: cfg.channels,
    locale: cfg.locale,
    atomPins: cfg.atomPins,
    hooks: cfg.hooks,
    openaiCompat: cfg.openaiCompat,
    memory: cfg.memory,
    context: cfg.context
  });
}

/**
 * Load both config.json (system) and profile.json (business settings) and merge
 * into a single MonadConfig. If profile.json is missing but config.json contains
 * profile fields (first boot after upgrade), profile.json is bootstrapped from it.
 */
export async function loadAll(
  configPath: string,
  profilePath: string,
  sandboxPath: string = join(dirname(configPath), 'sandbox.json')
): Promise<MonadConfig | null> {
  const [rawSystem, rawProfile, rawSandbox] = await Promise.all([
    Bun.file(configPath)
      .text()
      .catch((err: unknown) => {
        if (isMissingFile(err)) return null;
        throw err;
      }),
    // initMonadHome always writes both files together; an absent profile.json falls back to defaults.
    Bun.file(profilePath)
      .text()
      .catch((err: unknown) => {
        if (isMissingFile(err)) return null;
        throw err;
      }),
    // sandbox.json is authoritative and versionless; an absent file falls back to schema defaults
    // (fail-safe: confine=true). A present-but-malformed file THROWS below — never silently defaults.
    Bun.file(sandboxPath)
      .text()
      .catch((err: unknown) => {
        if (isMissingFile(err)) return null;
        throw err;
      })
  ]);

  if (rawSystem === null) return null;

  let parsedSystem: unknown;
  try {
    parsedSystem = JSON.parse(rawSystem);
  } catch {
    throw new Error(`monad: config.json is not valid JSON at ${configPath}. Fix the file and retry.`);
  }
  let system: MonadSystemConfig;
  try {
    system = await migrateSystemConfig(parsedSystem);
  } catch (err) {
    throw friendlySchemaError('config.json', configPath, err);
  }

  let profile: MonadProfile;
  if (rawProfile !== null) {
    let parsedProfile: unknown;
    try {
      parsedProfile = JSON.parse(rawProfile);
    } catch {
      throw new Error(`monad: profile.json is not valid JSON at ${profilePath}. Fix the file and retry.`);
    }
    try {
      profile = await migrateProfile(parsedProfile);
    } catch (err) {
      throw friendlySchemaError('profile.json', profilePath, err);
    }
  } else {
    profile = monadProfileSchema.parse({ version: CURRENT_PROFILE_VERSION, model: { default: '' } });
  }

  let sandbox: SandboxConfig;
  if (rawSandbox !== null) {
    let parsedSandbox: unknown;
    try {
      parsedSandbox = JSON.parse(rawSandbox);
    } catch {
      throw new Error(`monad: sandbox.json is not valid JSON at ${sandboxPath}. Fix the file and retry.`);
    }
    try {
      sandbox = sandboxConfigSchema.parse(migrateSandboxBackend(parsedSandbox));
    } catch (err) {
      // A present-but-invalid policy must fail closed, never silently degrade to an unconfined default.
      throw friendlySchemaError('sandbox.json', sandboxPath, err);
    }
  } else {
    sandbox = sandboxConfigSchema.parse({});
  }

  return mergeConfigs(system, profile, sandbox);
}

export async function saveSystemConfig(configPath: string, cfg: MonadConfig): Promise<void> {
  const system = extractSystemConfig(cfg);
  try {
    monadSystemConfigSchema.parse(system);
  } catch (err) {
    throw friendlySchemaError('config.json', configPath, err);
  }
  await atomicWrite(configPath, `${JSON.stringify({ $schema: getSchemaUrl(), ...system }, null, 2)}\n`);
  await setSecurePermissions(configPath); // holds network.remoteAccess.token — owner-only
}

export async function saveProfile(profilePath: string, cfg: MonadConfig): Promise<void> {
  const profile = extractProfile(cfg);
  try {
    monadProfileSchema.parse(profile);
  } catch (err) {
    throw friendlySchemaError('profile.json', profilePath, err);
  }
  await atomicWrite(profilePath, `${JSON.stringify({ $schema: getProfileSchemaUrl(), ...profile }, null, 2)}\n`);
  await setSecurePermissions(profilePath);
}

// sandbox.json holds the sandbox POLICY block (cfg.sandbox). Versionless — every field defaults, so
// an absent file is a valid fail-safe policy and there's nothing to migrate. Locked 0o600 because a
// `credential` secret-ref may live here.
export async function saveSandbox(sandboxPath: string, cfg: MonadConfig): Promise<void> {
  let sandbox: SandboxConfig;
  try {
    sandbox = sandboxConfigSchema.parse(cfg.sandbox);
  } catch (err) {
    throw friendlySchemaError('sandbox.json', sandboxPath, err);
  }
  await atomicWrite(sandboxPath, `${JSON.stringify(sandbox, null, 2)}\n`);
  await setSecurePermissions(sandboxPath);
}

// Write config.json, then profile.json, then sandbox.json in sequence so a file-watcher that fires
// between writes always reads a consistent state (system is stable before profile/sandbox land).
export async function saveAll(
  configPath: string,
  profilePath: string,
  cfg: MonadConfig,
  sandboxPath: string = join(dirname(configPath), 'sandbox.json')
): Promise<void> {
  await saveSystemConfig(configPath, cfg);
  await saveProfile(profilePath, cfg);
  await saveSandbox(sandboxPath, cfg);
}

export async function tryParseAuth(raw: unknown): Promise<MonadAuth | null> {
  try {
    return await runMigrations(raw, CURRENT_AUTH_VERSION, AUTH_MIGRATIONS_DIR, (data) => monadAuthSchema.parse(data));
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await Bun.write(tmp, content);
  if (process.platform === 'win32') {
    try {
      await unlink(filePath);
    } catch {
      /* target may not exist yet */
    }
  }
  await rename(tmp, filePath);
}

async function setSecurePermissions(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o600);
  }
}

// ENOTDIR can also mean "no file here" when a path component is a file, not a dir.
function isMissingFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function loadConfig(configPath: string): Promise<MonadConfig | null> {
  const siblingProfilePath = join(dirname(configPath), 'profile.json');
  return loadAll(configPath, siblingProfilePath);
}

export async function loadAuth(authPath: string): Promise<MonadAuth | null> {
  let raw: string;
  try {
    raw = await Bun.file(authPath).text();
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return tryParseAuth(parsed);
}

export async function saveAuth(authPath: string, auth: MonadAuth): Promise<void> {
  try {
    monadAuthSchema.parse(auth);
  } catch (err) {
    throw friendlySchemaError('auth.json', authPath, err);
  }
  await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  await setSecurePermissions(authPath);
}
