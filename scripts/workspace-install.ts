import { join } from 'node:path';

/** Install only the workspace closure a CI job actually needs. `bun install --filter` takes
 *  explicit workspace names and offers no dependency-relationship syntax, so the closure is
 *  computed here from the package manifests — a hand-maintained list would rot the first time a
 *  workspace gains a dependency. The root package rides along for the repo-level tooling
 *  (turbo, the quiet-run wrapper) every job invokes. */

const root = join(import.meta.dir, '..');
const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write('usage: bun scripts/workspace-install.ts <workspace-name> [...]\n');
  process.exit(1);
}

const rootManifest = (await Bun.file(join(root, 'package.json')).json()) as {
  name: string;
  workspaces: string[];
};

const manifests = new Map<string, { dir: string; workspaceDeps: string[] }>();
for (const pattern of rootManifest.workspaces) {
  for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
    const manifest = (await Bun.file(join(root, match)).json()) as Record<string, unknown> & { name: string };
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
      Object.keys((manifest[field] as Record<string, string> | undefined) ?? {})
    );
    manifests.set(manifest.name, { dir: match, workspaceDeps: declared });
  }
}

const closure = new Set<string>([rootManifest.name]);
const queue = [...targets];
while (queue.length > 0) {
  const name = queue.shift();
  if (!name || closure.has(name)) continue;
  const entry = manifests.get(name);
  if (!entry) {
    if (targets.includes(name)) {
      process.stderr.write(`unknown workspace: ${name}\n`);
      process.exit(1);
    }
    continue;
  }
  closure.add(name);
  queue.push(...entry.workspaceDeps.filter((dep) => manifests.has(dep)));
}

process.stderr.write(`[workspace-install] ${closure.size} of ${manifests.size + 1} workspaces\n`);
const proc = Bun.spawn(['bun', 'install', '--frozen-lockfile', ...[...closure].flatMap((name) => ['--filter', name])], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'ignore'
});
process.exit(await proc.exited);
