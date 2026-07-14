import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createPlatformModulePlugin, type ReleasePlatform } from '../../lib/platform-modules.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function fixture(): Promise<string> {
  const dir = join(import.meta.dir, `.platform-modules-${crypto.randomUUID()}`);
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'entry.ts'), "import { value } from './platform.ts'; console.log(value);\n"),
    writeFile(join(dir, 'platform.ts'), "export const value = 'development-all-platforms';\n"),
    writeFile(join(dir, 'platform.darwin.ts'), "export const value = 'selected-darwin';\n"),
    writeFile(join(dir, 'platform.linux.ts'), "export const value = 'selected-linux';\n"),
    writeFile(join(dir, 'platform.windows.ts'), "export const value = 'selected-windows';\n")
  ]);
  return dir;
}

function targets(dir: string): Record<ReleasePlatform, string> {
  return {
    darwin: join(dir, 'platform.darwin.ts'),
    linux: join(dir, 'platform.linux.ts'),
    windows: join(dir, 'platform.windows.ts')
  };
}

for (const platform of ['darwin', 'linux', 'windows'] as const) {
  test(`release resolves the stable seam to ${platform} only`, async () => {
    const dir = await fixture();
    const platformModules = createPlatformModulePlugin({
      platform,
      rules: [{ seam: join(dir, 'platform.ts'), targets: targets(dir) }]
    });

    const result = await Bun.build({
      entrypoints: [join(dir, 'entry.ts')],
      plugins: [platformModules.plugin],
      target: 'bun'
    });

    expect(result.success).toBe(true);
    const [artifact] = result.outputs;
    if (!artifact) throw new Error('fixture build produced no output');
    const output = await artifact.text();
    expect(output).toContain(`selected-${platform}`);
    expect(output).not.toContain('development-all-platforms');
    expect(() => platformModules.assertResolved()).not.toThrow();
  });
}

test('audit fails when a configured seam was not imported', async () => {
  const dir = await fixture();
  const platformModules = createPlatformModulePlugin({
    platform: 'darwin',
    rules: [{ seam: join(dir, 'platform.ts'), targets: targets(dir) }]
  });

  expect(() => platformModules.assertResolved()).toThrow(/platform\.ts/);
});

test('construction rejects duplicate seams', async () => {
  const dir = await fixture();
  const rule = { seam: join(dir, 'platform.ts'), targets: targets(dir) };

  expect(() => createPlatformModulePlugin({ platform: 'linux', rules: [rule, rule] })).toThrow(/duplicate/i);
});

test('construction rejects a missing target file', async () => {
  const dir = await fixture();
  const mapped = targets(dir);
  mapped.windows = join(dir, 'missing.windows.ts');

  expect(() =>
    createPlatformModulePlugin({
      platform: 'windows',
      rules: [{ seam: join(dir, 'platform.ts'), targets: mapped }]
    })
  ).toThrow(/missing\.windows\.ts/);
});
