import { expect, test } from 'bun:test';

import { resolveImageArtifact } from '../../src/image.ts';

// A trimmed CoreOS `stable.json` — resolveImageArtifact must dig the applehv aarch64 raw.gz disk out
// of the nested stream metadata.
const STREAM = {
  architectures: {
    aarch64: {
      artifacts: {
        applehv: {
          formats: {
            'raw.gz': {
              disk: {
                location: 'https://example/fedora-coreos-applehv.aarch64.raw.gz',
                sha256: 'deadbeef',
                'uncompressed-sha256': 'cafef00d'
              }
            }
          }
        }
      }
    }
  }
};

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

test('resolveImageArtifact pulls the applehv aarch64 raw.gz disk from stream metadata', async () => {
  const a = await resolveImageArtifact(fakeFetch(STREAM));
  expect(a.location).toBe('https://example/fedora-coreos-applehv.aarch64.raw.gz');
  expect(a.sha256).toBe('deadbeef');
  expect(a.uncompressedSha256).toBe('cafef00d');
});

test('resolveImageArtifact throws when the applehv raw.gz artifact is missing', async () => {
  await expect(resolveImageArtifact(fakeFetch({ architectures: { aarch64: { artifacts: {} } } }))).rejects.toThrow(
    /no applehv/
  );
});

test('resolveImageArtifact throws on a failed metadata fetch', async () => {
  await expect(resolveImageArtifact(fakeFetch({}, false))).rejects.toThrow(/stream metadata/);
});
