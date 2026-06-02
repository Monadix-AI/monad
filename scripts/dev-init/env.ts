export function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    map.set(key, val);
  }
  return map;
}

/**
 * True when this install is not an interactive local-dev one: CI (`CI` is set by GitHub Actions and
 * most CI providers), an explicit opt-out, or a production install. In those contexts `postinstall`
 * must be a no-op — the dev bootstrap below pokes Docker, builds native sprites, and scaffolds a seed
 * config holding secrets, none of which belong in CI or a release/image build.
 */
export function shouldSkipDevInit(): boolean {
  return Boolean(process.env.CI || process.env.MONAD_SKIP_SETUP || process.env.NODE_ENV === 'production');
}
