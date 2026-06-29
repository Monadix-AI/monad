import type { AgentConfig, MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type {
  ImportSettingsApplyRequest,
  ImportSettingsApplyResult,
  ImportSettingsItem,
  ImportSettingsPreview,
  ImportSettingsRequest,
  ModelRoles
} from '@monad/protocol';
import type { ParsedImport, PlannedItem, SettingsImportDeps } from './types.ts';

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAll, loadAuth, saveAll, saveAuth, saveSystemConfig } from '@monad/home';
import { newId } from '@monad/protocol';

import { toAgentDir, writeAgentBody } from '@/store/home/agent-def.ts';
import { installSkillFromDir } from '@/store/home/skills.ts';
import { parseSource } from './adapters/index.ts';

const MAX_SKILL_IMPORT_FILES = 256;
const MAX_SKILL_IMPORT_BYTES = 10 * 1024 * 1024;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secretShape(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, '<redacted>'])
  );
}

function payloadFingerprint(payload: PlannedItem['payload']): unknown {
  switch (payload.kind) {
    case 'mcpServer': {
      const server = payload.server;
      if (server.transport === 'stdio') {
        return {
          kind: payload.kind,
          server: {
            name: server.name,
            transport: server.transport,
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            env: secretShape(server.env),
            requestTimeoutMs: server.requestTimeoutMs,
            enabled: server.enabled,
            trust: server.trust
          }
        };
      }
      return {
        kind: payload.kind,
        server: {
          name: server.name,
          transport: server.transport,
          url: server.url,
          auth:
            server.auth.mode === 'headers'
              ? { mode: server.auth.mode, headers: secretShape(server.auth.headers) }
              : server.auth,
          requestTimeoutMs: server.requestTimeoutMs,
          enabled: server.enabled,
          trust: server.trust
        }
      };
    }
    case 'credential':
      return { ...payload, accessToken: '<redacted>' };
    case 'agent':
      return { ...payload, prompt: sha256(payload.prompt) };
    case 'skill':
      return payload;
    default:
      return payload;
  }
}

function itemHash(item: PlannedItem): string {
  return sha256(stableJson({ ...publicItemWithoutHash(item), payload: payloadFingerprint(item.payload) }));
}

function routeFromSpec(spec: string | undefined): { provider: string; modelId: string } | undefined {
  if (!spec) return undefined;
  const i = spec.indexOf(':');
  return i > 0 ? { provider: spec.slice(0, i), modelId: spec.slice(i + 1) } : undefined;
}

export function applyModelRolesToConfiguredDefaultProfile(cfg: MonadConfig, roles: ModelRoles): void {
  const defaultAlias = cfg.model.default || 'default';
  const profile = cfg.model.profiles.find((p) => p.alias === defaultAlias);
  if (!profile) throw new Error(`settings import: default profile "${defaultAlias}" is not configured`);
  profile.routes = {
    chat: profile.routes.chat,
    fast: profile.routes.fast,
    vision: routeFromSpec(roles.vision),
    image: routeFromSpec(roles.image),
    video: routeFromSpec(roles.video),
    speech: routeFromSpec(roles.speech),
    embedding: routeFromSpec(roles.embedding),
    memory: routeFromSpec(roles.memory)
  };
}

function publicItemWithoutHash(item: PlannedItem): Omit<ImportSettingsItem, 'hash'> {
  const { payload: _payload, ...rest } = item;
  return rest;
}

function publicItem(item: PlannedItem): ImportSettingsItem {
  return { ...publicItemWithoutHash(item), hash: itemHash(item) };
}

function summarizeConflict(item: PlannedItem, cfg: MonadConfig): string | undefined {
  const payload = item.payload;
  switch (payload.kind) {
    case 'mcpServer': {
      const existing = cfg.mcpServers.find((s) => s.name === payload.server.name);
      if (!existing) return undefined;
      const incoming = payload.server.transport === 'stdio' ? payload.server.command : payload.server.url;
      const current = existing.transport === 'stdio' ? existing.command : existing.url;
      return `existing=${current} incoming=${incoming}`;
    }
    case 'modelProvider': {
      const existing = cfg.model.providers.find((p) => p.id === payload.provider.id);
      return existing ? `existing=${existing.type} incoming=${payload.provider.type}` : undefined;
    }
    case 'modelProfile': {
      const existing = cfg.model.profiles.find((p) => p.alias === payload.profile.alias);
      return existing
        ? `existing=${existing.routes.chat.provider}/${existing.routes.chat.modelId} incoming=${payload.profile.routes.chat.provider}/${payload.profile.routes.chat.modelId}`
        : undefined;
    }
    case 'agent': {
      const existing = cfg.agent.agents.find((a) => a.name === payload.name);
      return existing ? `existing=${existing.dir ?? existing.name} incoming=${payload.name}` : undefined;
    }
    default:
      return undefined;
  }
}

function planConflicts(parsed: ParsedImport, cfg: MonadConfig, replace: boolean): ParsedImport {
  const existingMcp = new Set(cfg.mcpServers.map((s) => s.name));
  const existingProviders = new Set(cfg.model.providers.map((p) => p.id));
  const existingProfiles = new Set(cfg.model.profiles.map((p) => p.alias));
  const existingAgents = new Set(cfg.agent.agents.map((a) => a.name));

  return {
    ...parsed,
    items: parsed.items.map((item): PlannedItem => {
      if (item.action !== 'add') return item;
      const conflict =
        (item.payload.kind === 'mcpServer' && existingMcp.has(item.payload.server.name)) ||
        (item.payload.kind === 'modelProvider' && existingProviders.has(item.payload.provider.id)) ||
        (item.payload.kind === 'modelProfile' && existingProfiles.has(item.payload.profile.alias)) ||
        (item.payload.kind === 'agent' && existingAgents.has(item.payload.name));
      if (!conflict) return item;
      return {
        ...item,
        action: replace && item.payload.kind !== 'credential' ? 'update' : 'conflict',
        reason: replace ? `${item.target} exists and --replace allows update` : `${item.target} already exists`,
        summary: summarizeConflict(item, cfg) ?? item.summary
      };
    })
  };
}

export async function previewSettingsImport(
  req: ImportSettingsRequest,
  cfg: MonadConfig
): Promise<ImportSettingsPreview> {
  const parsed = planConflicts(await parseSource(req), cfg, req.replace);
  return { ...parsed, items: parsed.items.map(publicItem) };
}

async function loadCfg(paths: MonadPaths): Promise<{ cfg: MonadConfig; auth: MonadAuth }> {
  const cfg = await loadAll(paths.config, paths.profile);
  if (!cfg) throw new Error('settings import: config.json missing');
  const auth = (await loadAuth(paths.auth)) ?? {
    version: 1 as const,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  };
  return { cfg, auth };
}

function ensureAgentDir(base: string, taken: Set<string>): string {
  const slug = toAgentDir(base);
  if (!taken.has(slug)) return slug;
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

async function validateSkillDirForImport(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir);
    for (const entry of entries) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`skill import contains symlink "${path}"`);
      if (info.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!info.isFile()) continue;
      files++;
      bytes += info.size;
      if (files > MAX_SKILL_IMPORT_FILES) {
        throw new Error(`skill import has too many files (${files}; max ${MAX_SKILL_IMPORT_FILES})`);
      }
      if (bytes > MAX_SKILL_IMPORT_BYTES) {
        throw new Error(`skill import is too large (${bytes} bytes; max ${MAX_SKILL_IMPORT_BYTES})`);
      }
    }
  }
}

export function createSettingsImportModule({ paths, configBus, mcpReconnect }: SettingsImportDeps) {
  async function preview(req: ImportSettingsRequest): Promise<ImportSettingsPreview> {
    const { cfg } = await loadCfg(paths);
    return previewSettingsImport(req, cfg);
  }

  async function apply(req: ImportSettingsApplyRequest): Promise<ImportSettingsApplyResult> {
    const { cfg, auth } = await loadCfg(paths);
    const parsed = planConflicts(await parseSource(req), cfg, req.replace);
    const selectedIds = new Set(req.select);
    const selected = parsed.items.filter((item) =>
      req.allSafe ? item.action === 'add' && item.risk === 'low' : selectedIds.has(item.id)
    );
    const applied: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const reconnectMcp: string[] = [];
    let wroteSystem = false;
    let wroteProfile = false;
    let wroteAuth = false;
    const takenAgentDirs = new Set(cfg.agent.agents.map((a) => a.dir ?? toAgentDir(a.name)));

    for (const item of selected) {
      const expectedHash = req.hashes[item.id];
      if (!expectedHash) {
        skipped.push({ id: item.id, reason: 'missing preview hash for selected item' });
        continue;
      }
      if (expectedHash !== itemHash(item)) {
        skipped.push({ id: item.id, reason: 'preview item changed since selection' });
        continue;
      }
      if (item.action !== 'add' && item.action !== 'update') {
        skipped.push({ id: item.id, reason: `item action is ${item.action}` });
        continue;
      }
      try {
        const payload = item.payload;
        switch (payload.kind) {
          case 'mcpServer':
            cfg.mcpServers = [...cfg.mcpServers.filter((s) => s.name !== payload.server.name), payload.server];
            reconnectMcp.push(payload.server.name);
            wroteSystem = true;
            break;
          case 'modelProvider':
            cfg.model.providers = [
              ...cfg.model.providers.filter((p) => p.id !== payload.provider.id),
              payload.provider
            ];
            wroteProfile = true;
            break;
          case 'modelProfile':
            cfg.model.profiles = [
              ...cfg.model.profiles.filter((p) => p.alias !== payload.profile.alias),
              payload.profile
            ];
            if (payload.makeDefault) {
              cfg.model.profiles = [
                ...cfg.model.profiles.filter((p) => p.alias !== 'default'),
                { ...payload.profile, alias: 'default' }
              ];
              cfg.model.default = 'default';
            }
            wroteProfile = true;
            break;
          case 'modelRoles':
            applyModelRolesToConfiguredDefaultProfile(cfg, payload.roles);
            wroteProfile = true;
            break;
          case 'credential':
            auth.credentialPool[payload.providerId] ??= [];
            auth.credentialPool[payload.providerId]?.push({
              id: newId('cred'),
              label: payload.label,
              authType: payload.authType ?? 'api_key',
              priority: auth.credentialPool[payload.providerId]?.length ?? 0,
              source: 'import',
              accessToken: payload.accessToken,
              lastStatus: 'unknown',
              lastStatusAt: null,
              lastErrorCode: null,
              lastErrorReason: null,
              lastErrorMessage: null,
              lastErrorResetAt: null,
              requestCount: 0
            });
            wroteAuth = true;
            break;
          case 'skill':
            await validateSkillDirForImport(payload.dir);
            await installSkillFromDir(paths.skills, payload.dir, { overwrite: req.replace });
            break;
          case 'sandbox':
            cfg.agent.sandbox.mode = payload.mode;
            wroteSystem = true;
            break;
          case 'agent': {
            const existingIndex = cfg.agent.agents.findIndex((a) => a.name === payload.name);
            const existing = existingIndex === -1 ? undefined : cfg.agent.agents[existingIndex];
            const defaultDir = existing?.dir ?? toAgentDir(payload.name);
            const uniqueDir =
              existing?.dir ??
              (() => {
                if (existingIndex === -1) return ensureAgentDir(payload.name, takenAgentDirs);
                const withoutCurrent = new Set(takenAgentDirs);
                withoutCurrent.delete(defaultDir);
                return ensureAgentDir(payload.name, withoutCurrent);
              })();
            const stableDir = uniqueDir;
            const agent: AgentConfig = {
              id: existing?.id ?? newId('agt'),
              name: payload.name,
              dir: uniqueDir,
              description: payload.description,
              model: payload.model,
              framework: payload.framework,
              capabilities: [],
              declaredScopes: [],
              atoms: { mode: 'inherit', allow: [], deny: [] },
              visibility: { subagentCallable: false, public: false }
            };
            if (existingIndex === -1) {
              cfg.agent.agents.push(agent);
            } else {
              cfg.agent.agents[existingIndex] = agent;
            }
            await mkdir(join(paths.agents, stableDir), { recursive: true });
            await writeAgentBody(
              paths.agents,
              stableDir,
              { name: agent.name, description: agent.description },
              payload.prompt
            );
            takenAgentDirs.add(stableDir);
            wroteProfile = true;
            break;
          }
          default:
            skipped.push({ id: item.id, reason: 'manual item cannot be applied' });
            continue;
        }
        applied.push(item.id);
      } catch (err) {
        skipped.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (wroteSystem && wroteProfile) await saveAll(paths.config, paths.profile, cfg);
    else if (wroteSystem) await saveSystemConfig(paths.config, cfg);
    else if (wroteProfile) await saveAll(paths.config, paths.profile, cfg);
    if (wroteAuth) {
      auth.updatedAt = new Date().toISOString();
      await saveAuth(paths.auth, auth);
    }
    if (configBus && (wroteProfile || wroteAuth || wroteSystem)) await configBus.publish({ cfg, auth });
    for (const name of reconnectMcp) await mcpReconnect?.(name);

    return {
      preview: { ...parsed, items: parsed.items.map(publicItem) },
      applied,
      skipped
    };
  }

  return { preview, apply };
}
