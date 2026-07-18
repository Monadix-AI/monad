import { statSync } from 'node:fs';
import { join } from 'node:path';

const SHARD_ARG_PREFIX = '--monad-shards=';
const AUTO_SHARD_CAP = 4;
const TEST_FILE_GLOB = '**/*.test.{ts,tsx}';
const NAME_FILTER_FLAGS = new Set(['-t', '--test-name-pattern']);

export interface MonadTestShardArgs {
  args: string[];
  shards: number;
}

export interface ShardedFileResult {
  file: string;
  exitCode: number;
  output: string;
  junitPath: string;
}

export function parseMonadTestShardArgs(input: string[], cpuCount: number): MonadTestShardArgs {
  const args: string[] = [];
  let shards = 1;

  for (const arg of input) {
    if (!arg.startsWith(SHARD_ARG_PREFIX)) {
      args.push(arg);
      continue;
    }
    const value = arg.slice(SHARD_ARG_PREFIX.length);
    if (value === 'auto') {
      // Wall time floors at the slowest single file long before the pool saturates, so the cap stays
      // low: more concurrent daemon processes only add memory pressure for no measured gain.
      shards = Math.max(1, Math.min(AUTO_SHARD_CAP, cpuCount - 2));
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid shard count: ${value}`);
    shards = parsed;
  }

  return { args, shards };
}

/** Sharding replays Bun's own file selection, so it only engages for the shape that selection is
 *  unambiguous for: plain directory targets with no name filter. Anything else runs unsharded. */
export function shardableTargets(args: string[]): string[] | undefined {
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (NAME_FILTER_FLAGS.has(arg)) return undefined;
    if (arg.startsWith('--test-name-pattern=')) return undefined;
    if (arg.startsWith('-')) continue;
    if (i > 0 && args[i - 1] === '--path-ignore-patterns') continue;
    targets.push(arg);
  }
  if (targets.length === 0) return undefined;
  for (const target of targets) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return undefined;
  }
  return targets;
}

export async function collectTestFiles(targets: string[], ignorePatterns: string[]): Promise<string[]> {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  const ignore = ignorePatterns.map((pattern) => ({
    full: new Bun.Glob(pattern),
    bare: new Bun.Glob(pattern.replace(/^\*\*\//, ''))
  }));
  const files = new Set<string>();
  for (const target of targets) {
    for await (const relativePath of glob.scan({ cwd: target })) {
      const path = join(target, relativePath);
      if (ignore.some((entry) => entry.full.match(path) || entry.bare.match(relativePath))) continue;
      files.add(path);
    }
  }
  return [...files].sort();
}

/** Runs one `bun test` process per file across a fixed worker pool. Per-file isolation is what makes
 *  this safe: `scripts/test-setup.ts` keys MONAD_HOME by pid and `serveTransport` binds port 0 plus a
 *  pid-scoped socket path, so concurrent shards cannot collide on home state, ports, or sockets. */
export async function runShardedTestFiles(options: {
  files: string[];
  shards: number;
  junitDir: string;
  buildCommand: (file: string, junitPath: string) => string[];
  env: Record<string, string | undefined>;
  onResult: (result: ShardedFileResult) => void;
}): Promise<number> {
  const queue = [...options.files];
  let nextJunitId = 0;
  let exitCode = 0;

  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const junitPath = join(options.junitDir, `junit-${nextJunitId++}.xml`);
      const proc = Bun.spawn(options.buildCommand(file, junitPath), {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: options.env
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      if (code !== 0) exitCode = code;
      options.onResult({ file, exitCode: code, output: `${stdout}${stderr}`, junitPath });
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.shards, queue.length) }, worker));
  return exitCode;
}
