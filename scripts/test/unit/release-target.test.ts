import { describe, expect, test } from 'bun:test';

import {
  distTargetFromReleaseTarget,
  releaseTargetFromDistTarget,
  releaseTargetSuffix
} from '../../lib/release-target.ts';

describe('dist release target adapter', () => {
  test.each([
    ['aarch64-apple-darwin', 'darwin-arm64'],
    ['x86_64-apple-darwin', 'darwin-x64'],
    ['aarch64-unknown-linux-gnu', 'linux-arm64'],
    ['x86_64-unknown-linux-gnu', 'linux-x64'],
    ['aarch64-unknown-linux-musl', 'linux-arm64-musl'],
    ['x86_64-unknown-linux-musl', 'linux-x64-musl'],
    ['aarch64-pc-windows-msvc', 'windows-arm64'],
    ['x86_64-pc-windows-msvc', 'windows-x64']
  ] as const)('maps %s to release suffix %s', (distTarget, suffix) => {
    const target = releaseTargetFromDistTarget(distTarget);
    expect({ suffix: releaseTargetSuffix(target), distTarget: distTargetFromReleaseTarget(target) }).toEqual({
      suffix,
      distTarget
    });
  });

  test('rejects targets the release builder cannot produce', () => {
    expect(() => releaseTargetFromDistTarget('i686-pc-windows-msvc')).toThrow('Unsupported dist target');
  });
});
