import { expect, test } from 'bun:test';

import {
  isUpgradeAvailable,
  monadUpdaterPath,
  releaseChannelOfVersion,
  resolveRelease,
  resolveReleaseTag,
  shouldInstallRelease
} from '../src/release-update.ts';

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test('stable resolves the latest GitHub release', async () => {
  const release = await resolveRelease('stable', {
    fetch: (async () => response({ tag_name: 'v1.2.3', body: 'notes' })) as unknown as typeof fetch
  });

  expect(release).toEqual({ tag: 'v1.2.3', version: '1.2.3', notes: 'notes' });
});

test('stable falls back to the latest redirect when the API is unavailable', async () => {
  const release = await resolveRelease('stable', {
    fetch: (async (input: string | URL | Request) => {
      if (String(input).includes('api.github.com')) return response({}, 403);
      return new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/Monadix-AI/monad/releases/tag/v2.0.0' }
      });
    }) as unknown as typeof fetch
  });

  expect(release).toEqual({ tag: 'v2.0.0', version: '2.0.0', notes: null });
});

test('beta excludes nightly and chooses the newest beta tag', async () => {
  const release = await resolveRelease('beta', {
    fetch: (async () =>
      response([
        { tag_name: 'v9.0.0-nightly.1', prerelease: true },
        { tag_name: 'v2.0.0-beta.2', prerelease: true },
        { tag_name: 'v2.0.0-beta.10', prerelease: true },
        { tag_name: 'v3.0.0-beta.1', prerelease: true, draft: true },
        { tag_name: 'v4.0.0-beta.1', prerelease: false }
      ])) as unknown as typeof fetch
  });

  expect(release?.tag).toBe('v2.0.0-beta.10');
});

test('nightly only selects exact nightly tags', async () => {
  const release = await resolveRelease('nightly', {
    fetch: (async () =>
      response([
        { tag_name: 'v1.0.0-beta.9', prerelease: true },
        { tag_name: 'v1.1.0-nightly.20260810', prerelease: true }
      ])) as unknown as typeof fetch
  });

  expect(release?.version).toBe('1.1.0-nightly.20260810');
});

test('an exact release tag resolves independently of the latest channel', async () => {
  const seen: string[] = [];
  const release = await resolveReleaseTag('1.2.3-beta.4', {
    fetch: (async (input: string | URL | Request) => {
      seen.push(String(input));
      return response({ tag_name: 'v1.2.3-beta.4', body: 'exact notes' });
    }) as unknown as typeof fetch
  });

  expect(seen[0]).toEndWith('/releases/tags/v1.2.3-beta.4');
  expect(release).toEqual({ tag: 'v1.2.3-beta.4', version: '1.2.3-beta.4', notes: 'exact notes' });
});

test('an exact nightly tag accepts the build metadata emitted by the release workflow', async () => {
  const tag = 'v1.2.3-nightly.20260810+abc1234';
  const seen: string[] = [];
  const release = await resolveReleaseTag(tag, {
    fetch: (async (input: string | URL | Request) => {
      seen.push(String(input));
      return response({ tag_name: tag });
    }) as unknown as typeof fetch
  });

  expect(seen[0]).toEndWith('/releases/tags/v1.2.3-nightly.20260810%2Babc1234');
  expect(release?.tag).toBe(tag);
});

test('an invalid exact release tag is rejected without a network request', async () => {
  let fetched = false;
  const release = await resolveReleaseTag('../latest', {
    fetch: (async () => {
      fetched = true;
      return response({});
    }) as unknown as typeof fetch
  });

  expect(release).toBeNull();
  expect(fetched).toBe(false);
});

test('release channels are inferred from exact prerelease identifiers', () => {
  expect(releaseChannelOfVersion('1.0.0')).toBe('stable');
  expect(releaseChannelOfVersion('v1.0.0-beta.2')).toBe('beta');
  expect(releaseChannelOfVersion('1.0.0-nightly.20260810+abc')).toBe('nightly');
});

test('same-channel updates must be newer while explicit channel switches may cross versions', () => {
  expect(shouldInstallRelease('1.0.0-beta.1', '1.0.0-beta.2', 'beta', false)).toBe(true);
  expect(shouldInstallRelease('1.0.0-beta.2', '1.0.0-beta.1', 'beta', false)).toBe(false);
  expect(shouldInstallRelease('2.0.0-nightly.1', '1.9.0', 'stable', true)).toBe(true);
  expect(shouldInstallRelease('1.0.0', '1.0.0', 'stable', true)).toBe(false);
});

test('upgrade availability never treats older or cross-channel releases as automatic updates', () => {
  expect(isUpgradeAvailable('0.1.3', '0.1.2')).toBe(false);
  expect(isUpgradeAvailable('1.0.0-beta.10', '1.0.0-beta.9')).toBe(false);
  expect(isUpgradeAvailable('1.0.0-beta.9', '1.0.0-beta.10')).toBe(true);
  expect(isUpgradeAvailable('1.0.0-beta.1', '1.0.1')).toBe(false);
  expect(isUpgradeAvailable('1.0.0-nightly.2', '1.0.0-beta.3')).toBe(false);
});

test('updater path is a sibling of the monad executable', () => {
  expect(monadUpdaterPath('/opt/monad/bin/monad', 'linux')).toBe('/opt/monad/bin/monad-update');
  expect(monadUpdaterPath('C:\\Monad\\monad.exe', 'win32')).toBe('C:\\Monad\\monad-update.exe');
});
