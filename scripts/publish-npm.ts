/**
 * Builds and publishes the public `@monad/*` packages.
 *
 * The workspace deliberately keeps `exports` pointed at `src/*.ts` so in-repo consumers
 * type-check against source. Publishing therefore cannot reuse the checked-in manifest:
 * this script stages a rewritten one (dist entry points, `workspace:*` resolved to a real
 * range) next to the built output and publishes that.
 *
 * `npm publish` rather than `bun publish` is deliberate — it is the only one of the two
 * that emits a Sigstore provenance attestation, which is the point of publishing from CI.
 *
 * Usage:
 *   bun scripts/publish-npm.ts            # build + `npm publish --dry-run`
 *   bun scripts/publish-npm.ts --publish  # build + real publish (CI only)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PublishTarget {
  dir: string;
  /** Entry points to build, relative to the package dir. */
  entries: string[];
  /** Subpath exports for the published manifest, mapped to their source entry. */
  exports: Record<string, string>;
  description: string;
  /** Emit root, when the package's sources are not all under `src/`. Defaults to `src`. */
  buildRoot?: string;
  /** Path prefix the emit root leaves in `dist/`, e.g. `src/`. */
  outPrefix?: string;
  /** Overrides the manifest's `dependencies` when the published entries need fewer. */
  dependencies?: Record<string, string>;
  /** Set when the published entries do not reach the manifest's peer dependencies. */
  dropPeerDependencies?: boolean;
}

const TARGETS: PublishTarget[] = [
  {
    dir: 'packages/protocol',
    entries: ['src/index.ts'],
    exports: { '.': 'index' },
    buildRoot: '.',
    outPrefix: 'src/',
    description: "Wire and domain contracts for Monad's daemon API — zod schemas, events, and IDs."
  },
  {
    dir: 'packages/sdk-atom',
    entries: [
      'src/index.ts',
      'src/channel.ts',
      'src/command.ts',
      'src/connector.ts',
      'src/hook.ts',
      'src/locale.ts',
      'src/message-type.ts',
      'src/mesh-agent-session-runtime.ts',
      'src/model.ts',
      'src/sandbox.ts'
    ],
    exports: {
      '.': 'index',
      './channel': 'channel',
      './command': 'command',
      './connector': 'connector',
      './hook': 'hook',
      './locale': 'locale',
      './message-type': 'message-type',
      './mesh-agent-session-runtime': 'mesh-agent-session-runtime',
      './model': 'model',
      './sandbox': 'sandbox'
    },
    description: 'Authoring contract for Monad atom packs — channels, commands, hooks, providers, and sandboxes.'
  },
  {
    // Only the React-free root entry ships. `./react` re-exports @monad/client-rtk hooks and
    // is for first-party host-component experiences that render inside the web app's own
    // Redux provider; publishing it would drag client-rtk, client, RTK, and elysia into the
    // public surface for no external consumer.
    dir: 'packages/sdk-experience',
    entries: ['src/index.ts'],
    exports: { '.': 'index' },
    description: 'React-free authoring contract for Monad workplace experiences (web-component entries).',
    // The root entry imports @monad/protocol for types only and never reaches client-rtk,
    // react, or react-redux — the manifest lists those for the unpublished `./react` entry.
    dependencies: { '@monad/protocol': 'workspace:*' },
    dropPeerDependencies: true
  }
];

const REPO = {
  type: 'git',
  url: 'git+https://github.com/Monadix-AI/monad.git'
} as const;

const publish = process.argv.includes('--publish');

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed in ${cwd} (exit ${code})`);
}

/** Workspace links cannot survive publication; resolve each to the version being published. */
function resolveDependencies(
  deps: Record<string, string> | undefined,
  versions: Map<string, string>
): Record<string, string> | undefined {
  if (!deps) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (!range.startsWith('workspace:')) {
      resolved[name] = range;
      continue;
    }
    const version = versions.get(name);
    if (!version) throw new Error(`${name} is a workspace dependency but is not being published`);
    resolved[name] = `^${version}`;
  }
  return resolved;
}

const staged: { target: PublishTarget; json: Record<string, unknown> }[] = [];
const versions = new Map<string, string>();
for (const target of TARGETS) {
  const json = JSON.parse(await readFile(join(target.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  staged.push({ target, json });
  versions.set(json.name as string, json.version as string);
}

for (const { target, json } of staged) {
  const name = json.name as string;
  const dist = join(target.dir, 'dist');
  const prefix = target.outPrefix ?? '';

  process.stdout.write(`\n=== ${name}@${json.version} ===\n`);
  await rm(dist, { recursive: true, force: true });

  if ((json.scripts as Record<string, string> | undefined)?.generate) {
    await run(['bun', 'run', 'generate'], target.dir);
  }

  await run(
    [
      'bun',
      'build',
      ...target.entries,
      '--outdir=dist',
      // Without an explicit root the entry paths keep their `src/` prefix in dist.
      `--root=${target.buildRoot ?? 'src'}`,
      '--target=node',
      '--format=esm',
      '--splitting',
      '--packages=external'
    ],
    target.dir
  );
  await run(['bunx', 'tsc', '-p', 'tsconfig.build.json'], target.dir);

  const published: Record<string, unknown> = {
    name,
    version: json.version,
    description: target.description,
    license: json.license ?? 'MIT',
    author: 'Monadix Labs, Inc.',
    homepage: 'https://github.com/Monadix-AI/monad#readme',
    repository: { ...REPO, directory: target.dir },
    bugs: { url: 'https://github.com/Monadix-AI/monad/issues' },
    type: 'module',
    exports: Object.fromEntries(
      Object.entries(target.exports).map(([subpath, entry]) => [
        subpath,
        { types: `./${prefix}${entry}.d.ts`, default: `./${prefix}${entry}.js` }
      ])
    ),
    types: `./${prefix}index.d.ts`,
    dependencies: resolveDependencies(target.dependencies ?? (json.dependencies as Record<string, string>), versions),
    peerDependencies: target.dropPeerDependencies ? undefined : json.peerDependencies,
    peerDependenciesMeta: target.dropPeerDependencies ? undefined : json.peerDependenciesMeta,
    publishConfig: { access: 'public' }
  };
  for (const key of Object.keys(published)) {
    if (published[key] === undefined) delete published[key];
  }

  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);

  const readme = join(target.dir, 'README.md');
  if (await Bun.file(readme).exists()) {
    await writeFile(join(dist, 'README.md'), await readFile(readme, 'utf8'));
  }
  await writeFile(join(dist, 'LICENSE'), await readFile('LICENSE', 'utf8'));

  // `--provenance` needs a CI OIDC identity; asking for it in a local dry run just errors.
  await run(['npm', 'publish', '--access', 'public', ...(publish ? ['--provenance'] : ['--dry-run'])], dist);
}

process.stdout.write(publish ? '\nPublished.\n' : '\nDry run complete — pass --publish to release.\n');
