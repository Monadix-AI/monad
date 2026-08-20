/** Which platforms each `*.<suffix>.test.ts` file is meant to run on. Files with no platform suffix
 *  run everywhere. This table is the single source of truth for both the exclusion patterns handed
 *  to `bun test` and the applicability predicate used when a runner enumerates files itself. */
const SUFFIX_PLATFORMS: Record<string, NodeJS.Platform[]> = {
  unix: ['darwin', 'linux'],
  macos: ['darwin'],
  linux: ['linux'],
  windows: ['win32']
};

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const CONTAINER_SUFFIX = /\.container(?:\.[^.]+)?\.test\./;

export interface PlatformTestFileOptions {
  containerDeps?: boolean;
}

export function ignoredTestPathPatterns(
  platform: NodeJS.Platform,
  { containerDeps = false }: PlatformTestFileOptions = {}
): string[] {
  const patterns = Object.entries(SUFFIX_PLATFORMS)
    .filter(([, platforms]) => !platforms.includes(platform))
    .map(([suffix]) => `**/*.${suffix}.test.ts`);
  if (!containerDeps) patterns.push('**/*.container.test.ts', '**/*.container.*.test.ts');
  return patterns;
}

export function testFileAppliesToPlatform(
  name: string,
  platform: NodeJS.Platform,
  { containerDeps = false }: PlatformTestFileOptions = {}
): boolean {
  if (!TEST_FILE.test(name)) return false;
  if (!containerDeps && CONTAINER_SUFFIX.test(name)) return false;
  const suffix = Object.keys(SUFFIX_PLATFORMS).find((candidate) => name.includes(`.${candidate}.test.`));
  return suffix === undefined || (SUFFIX_PLATFORMS[suffix] as NodeJS.Platform[]).includes(platform);
}
