import { describe, expect, test } from 'bun:test';

import { releaseTargetFromDistTarget, releaseTargetSuffix } from '../../lib/release-target.ts';

describe('dist release target adapter', () => {
  test.each([
    ['aarch64-apple-darwin', 'darwin-arm64'],
    ['x86_64-apple-darwin', 'darwin-x64'],
    ['aarch64-unknown-linux-gnu', 'linux-arm64'],
    ['x86_64-unknown-linux-gnu', 'linux-x64'],
    ['aarch64-unknown-linux-musl', 'linux-arm64-musl'],
    ['x86_64-unknown-linux-musl', 'linux-x64-musl'],
    ['x86_64-pc-windows-msvc', 'windows-x64']
  ])('maps %s to the existing release suffix %s', (distTarget, suffix) => {
    expect(releaseTargetSuffix(releaseTargetFromDistTarget(distTarget))).toBe(suffix);
  });

  test('rejects targets the existing release builder cannot produce', () => {
    expect(() => releaseTargetFromDistTarget('aarch64-pc-windows-msvc')).toThrow('Unsupported dist target');
  });
});
