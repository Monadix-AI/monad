// ── Per-worktree dev port assignment ─────────────────────────────────────────
// The daemon binds a TCP port unconditionally (the WS push channel is TCP-only), so two worktrees
// running `bun dev` at once would both grab the default 52749/3000/6480/4983 and the second fails
// with EADDRINUSE. A stable offset derived from the worktree path gives each checkout its own ports;
// both daemon and clients read MONAD_PORT, so they stay in sync.

/** Stable 0–999 offset from a seed string (FNV-1a/32). Same path → same ports, always. */
export function portOffset(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000;
}

export interface WorktreePorts {
  MONAD_PORT: string; // 52000–52999
  WEB_PORT: string; // 3100–4099
  MONAD_KV_UI_PORT: string; // 6400–7399 (dev KV debug UI)
  AI_SDK_DEVTOOLS_PORT: string; // 7400–8399 (AI SDK DevTools)
}

export function worktreePorts(root: string): WorktreePorts {
  const offset = portOffset(root);
  return {
    MONAD_PORT: String(52000 + offset),
    WEB_PORT: String(3100 + offset),
    MONAD_KV_UI_PORT: String(6400 + offset),
    AI_SDK_DEVTOOLS_PORT: String(7400 + offset)
  };
}

/**
 * Append `KEY=value` lines for any port not already present in `envText` (a missing/blank key is
 * treated as absent, so a hand-set value is never clobbered). Returns the new text plus the list
 * of `KEY=value` strings that were added. Idempotent: a second call with the result adds nothing.
 */
export function ensurePortLines(envText: string, ports: WorktreePorts): { text: string; added: string[] } {
  const present = new Set<string>();
  for (const raw of envText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (val) present.add(key);
  }

  let text = envText;
  const added: string[] = [];
  for (const [key, value] of Object.entries(ports)) {
    if (present.has(key)) continue;
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${key}=${value}\n`;
    added.push(`${key}=${value}`);
  }
  return { text, added };
}

const xdgEnvKeys = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
const blankXdgLinePattern = new RegExp(`^\\s*(${xdgEnvKeys.join('|')})\\s*=\\s*(?:""|''|)\\s*$`);

export function removeBlankXdgLines(envText: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = envText.split('\n');
  const kept = lines.filter((line, index) => {
    if (index === lines.length - 1 && line === '' && envText.endsWith('\n')) return true;
    const match = line.match(blankXdgLinePattern);
    if (!match) return true;
    removed.push(match[1]);
    return false;
  });
  return { text: kept.join('\n'), removed };
}
