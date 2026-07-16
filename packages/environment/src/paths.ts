import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface MonadPaths {
  home: string; // root of the data tree (single-tree: ~/.monad; XDG: $XDG_DATA_HOME/monad)
  runtime: string; // sockets + pid (single-tree: home/runtime; XDG: $XDG_RUNTIME_DIR/monad)
  configs: string; // config directory (single-tree: home/configs; XDG: $XDG_CONFIG_HOME/monad)
  config: string; // <configs>/config.json
  agentsConfig: string; // <configs>/agents.json
  mesh: string; // <configs>/mesh.json
  approvals: string; // <configs>/approvals.json — daemon-written runtime approval rules (agent+global)
  credentials: string; // ~/.monad/credentials — secrets; agent access always requires user approval
  auth: string; // <configs>/auth.json
  tls: string; // ~/.monad/credentials/tls — auto-generated TLS cert/key for remote access
  workspace: string; // <agents>/default — default agent workspace
  providers: string; // <atoms>/providers — model provider .js files
  skills: string; // <atoms>/skills — user-managed (global-tier) skill atoms
  skillsLock: string; // <atoms>/skills.lock — aggregate install record for all skills
  locales: string; // <atoms>/locales — user-managed locale packs (<lng>/<ns>.json)
  mcp: string; // <atoms>/mcp — user-managed (global-tier) MCP server atom configs (*.json)
  atoms: string; // umbrella root for every atom source (<home>/atoms): packs/, skills/, mcp/, locales/, providers/
  packs: string; // <atoms>/packs — installed atom packs (each a <pack>/ dir)
  agents: string; // per-agent configs and workspaces
  memory: string; // <home>/memory — layered-memory store; ONLY user-readable Markdown (MEMORY*.md), no binaries
  cache: string; // ephemeral runtime outputs
  logs: string; // daemon logs
  backup: string; // <home>/backup — pre-upgrade binary snapshots + pre-reset config snapshots
  bin: string; // <home>/bin — daemon-managed runtime tools (node, npx, uv, uvx); installed during `monad init`
  dbDir: string; // <home>/db — all binary databases (main sqlite, mem0 history, qdrant storage); not user-editable
  db: string; // <dbDir>/monad.sqlite — the main daemon DB
  sock: string;
  kvSock: string;
  pid: string;
}

function currentHomeDir(): string {
  return Bun.env.HOME || Bun.env.USERPROFILE || homedir();
}

/** The classic single-tree layout under one root. Used for explicit homes (MONAD_HOME / dev /
 *  custom root), on macOS/Windows, and for existing Linux ~/.monad installs. */
export function pathsForHome(home: string): MonadPaths {
  const runtime = join(home, 'runtime');
  const atoms = join(home, 'atoms');
  const configs = join(home, 'configs');
  const agents = join(home, 'agents');
  const credentials = join(home, 'credentials');
  const cache = join(home, 'cache');
  const dbDir = join(home, 'db');
  return {
    home,
    runtime,
    configs,
    config: join(configs, 'config.json'),
    agentsConfig: join(configs, 'agents.json'),
    mesh: join(configs, 'mesh.json'),
    approvals: join(configs, 'approvals.json'),
    credentials,
    auth: join(credentials, 'auth.json'),
    tls: join(credentials, 'tls'),
    workspace: join(agents, 'default'),
    providers: join(atoms, 'providers'),
    skills: join(atoms, 'skills'),
    skillsLock: join(atoms, 'skills.lock'),
    locales: join(atoms, 'locales'),
    mcp: join(atoms, 'mcp'),
    atoms,
    packs: join(atoms, 'packs'),
    agents,
    memory: join(home, 'memory'),
    cache,
    logs: join(home, 'logs'),
    backup: join(home, 'backup'),
    bin: join(home, 'bin'),
    dbDir,
    db: join(dbDir, 'monad.sqlite'),
    sock: join(runtime, 'monad.sock'),
    kvSock: join(runtime, 'kv.sock'),
    pid: join(runtime, 'monad.pid')
  };
}

/** XDG Base Directory layout (Linux, fresh installs only). Config/data/cache/state/runtime are
 *  split across the standard roots; sockets fall back to $XDG_STATE_HOME when $XDG_RUNTIME_DIR is
 *  unset (common outside a systemd login session). */
export function xdgPaths(): MonadPaths {
  const h = currentHomeDir();
  const configRoot = join(Bun.env.XDG_CONFIG_HOME || join(h, '.config'), 'monad');
  const dataRoot = join(Bun.env.XDG_DATA_HOME || join(h, '.local', 'share'), 'monad');
  const cacheRoot = join(Bun.env.XDG_CACHE_HOME || join(h, '.cache'), 'monad');
  const stateRoot = join(Bun.env.XDG_STATE_HOME || join(h, '.local', 'state'), 'monad');
  const runtimeRoot = Bun.env.XDG_RUNTIME_DIR ? join(Bun.env.XDG_RUNTIME_DIR, 'monad') : stateRoot;
  const atoms = join(dataRoot, 'atoms');
  const agents = join(dataRoot, 'agents');
  const credentials = join(configRoot, 'credentials');
  const dbDir = join(dataRoot, 'db');
  return {
    home: dataRoot,
    runtime: runtimeRoot,
    configs: configRoot,
    config: join(configRoot, 'config.json'),
    agentsConfig: join(configRoot, 'agents.json'),
    mesh: join(configRoot, 'mesh.json'),
    approvals: join(configRoot, 'approvals.json'),
    credentials,
    auth: join(configRoot, 'auth.json'),
    tls: join(credentials, 'tls'),
    workspace: join(agents, 'default'),
    providers: join(atoms, 'providers'),
    skills: join(atoms, 'skills'),
    skillsLock: join(atoms, 'skills.lock'),
    locales: join(atoms, 'locales'),
    mcp: join(atoms, 'mcp'),
    atoms,
    packs: join(atoms, 'packs'),
    agents,
    memory: join(dataRoot, 'memory'),
    cache: cacheRoot,
    logs: join(stateRoot, 'logs'),
    backup: join(dataRoot, 'backup'),
    bin: join(dataRoot, 'bin'),
    dbDir,
    db: join(dbDir, 'monad.sqlite'),
    sock: join(runtimeRoot, 'monad.sock'),
    kvSock: join(runtimeRoot, 'kv.sock'),
    pid: join(runtimeRoot, 'monad.pid')
  };
}

export function getPaths(): MonadPaths {
  // Explicit home (MONAD_HOME / dev repo home / pinned root) always wins and uses the single tree.
  const explicit = explicitHome();
  if (explicit) return pathsForHome(explicit);

  // Linux: split across XDG base directories.
  if (process.platform === 'linux') {
    return xdgPaths();
  }

  // macOS / Windows keep the single tree under the platform default.
  return pathsForHome(defaultHome());
}

export function getRootPointerPath(): string {
  if (process.platform === 'win32') {
    const appData = Bun.env.APPDATA ?? join(currentHomeDir(), 'AppData', 'Roaming');
    return join(appData, 'monad', 'root');
  }
  return join(currentHomeDir(), '.monad', 'root');
}

export async function setMonadRoot(customHome: string): Promise<void> {
  const pointerPath = getRootPointerPath();
  mkdirSync(dirname(pointerPath), { recursive: true });
  const tmp = `${pointerPath}.tmp`;
  await Bun.write(tmp, customHome);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, pointerPath);
}

/** An explicitly chosen home: MONAD_HOME, the dev repo home, or a pinned root pointer. */
function explicitHome(): string | null {
  if (Bun.env.MONAD_HOME) return Bun.env.MONAD_HOME;

  const repoDevHome = getRepoDevHome();
  if (repoDevHome) return repoDevHome;

  const pointerPath = getRootPointerPath();
  if (existsSync(pointerPath)) {
    try {
      const content = readFileSync(pointerPath, 'utf8').trim();
      // The pointer must hold an absolute path; ignore anything else (e.g. a file
      // cross-contaminated with a secret) so a malformed pointer degrades to the default.
      if (content && isAbsolute(content)) return content;
    } catch {
      // ignore corrupt pointer; fall through to defaults
    }
  }
  return null;
}

function defaultHome(): string {
  if (process.platform === 'win32') {
    const appData = Bun.env.APPDATA ?? join(currentHomeDir(), 'AppData', 'Roaming');
    return join(appData, 'monad');
  }
  return join(currentHomeDir(), '.monad');
}

function getRepoDevHome(): string | null {
  if (Bun.env.NODE_ENV !== 'development') return null;

  const repoRoot = resolve(import.meta.dir, '../../..');
  return existsSync(join(repoRoot, 'turbo.jsonc')) ? join(repoRoot, '.dev', '.monad') : null;
}
