import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installDevCliShim } from '../../dev-init/cli-shim.ts';
import { removeDirectory } from '../../test-fs.ts';

const directory = await mkdtemp(join(tmpdir(), 'monad-cli-shim-'));
afterAll(() => removeDirectory(directory));

test('the installed CLI shim runs the entry point of the worktree it sits in, not the one that wrote it', async () => {
  const authoring = join(directory, 'authoring-worktree');
  const inherited = join(directory, 'inherited-worktree');
  for (const [root, marker] of [
    [authoring, 'authoring'],
    [inherited, 'inherited']
  ] as const) {
    await Bun.write(
      join(root, 'apps/cli/src/bin.ts'),
      `process.stdout.write('${marker} ' + Bun.argv.slice(2).join(','));`
    );
  }

  const shimPath = await installDevCliShim(authoring);
  // A shim inherited by another checkout — the copy that used to run the authoring worktree's source.
  await Bun.write(join(inherited, '.dev/bin/monad'), await Bun.file(shimPath).text());
  await chmod(join(inherited, '.dev/bin/monad'), 0o755);

  const run = async (root: string): Promise<string> => {
    const child = Bun.spawn([join(root, '.dev/bin/monad'), 'session', 'list'], { stderr: 'pipe', stdout: 'pipe' });
    await child.exited;
    return await new Response(child.stdout).text();
  };

  expect({ authoring: await run(authoring), inherited: await run(inherited) }).toEqual({
    authoring: 'authoring session,list',
    inherited: 'inherited session,list'
  });
});
