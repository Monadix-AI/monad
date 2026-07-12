import { expect, test } from 'bun:test';

import { hostImageTarget, type ImageTarget, resolveImageArtifact } from '../../src/image.ts';

const TARGET: ImageTarget = { arch: 'aarch64', platform: 'applehv', format: 'raw.gz', decompress: 'gzip', ext: '.img' };
const QEMU_TARGET: ImageTarget = {
  arch: 'x86_64',
  platform: 'qemu',
  format: 'qcow2.xz',
  decompress: 'xz',
  ext: '.qcow2'
};

// A trimmed CoreOS `stream.json` — resolveImageArtifact must dig the right disk out of the nested tree.
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
    },
    x86_64: {
      artifacts: {
        qemu: {
          formats: { 'qcow2.xz': { disk: { location: 'https://example/fcos-qemu.x86_64.qcow2.xz', sha256: 'beef' } } }
        }
      }
    }
  }
};

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

test('hostImageTarget picks applehv on darwin, qemu on linux', () => {
  const t = hostImageTarget();
  if (process.platform === 'darwin') expect(t.platform).toBe('applehv');
  else if (process.platform === 'linux') expect(t.platform).toBe('qemu');
});

test('resolveImageArtifact pulls the qemu x86_64 qcow2.xz disk for a Linux target', async () => {
  const a = await resolveImageArtifact(QEMU_TARGET, fakeFetch(STREAM));
  expect(a.location).toBe('https://example/fcos-qemu.x86_64.qcow2.xz');
  expect(a.sha256).toBe('beef');
});

test('resolveImageArtifact pulls the applehv aarch64 raw.gz disk from stream metadata', async () => {
  const a = await resolveImageArtifact(TARGET, fakeFetch(STREAM));
  expect(a.location).toBe('https://example/fedora-coreos-applehv.aarch64.raw.gz');
  expect(a.sha256).toBe('deadbeef');
  expect(a.uncompressedSha256).toBe('cafef00d');
});

test('resolveImageArtifact throws when the applehv raw.gz artifact is missing', async () => {
  await expect(
    resolveImageArtifact(TARGET, fakeFetch({ architectures: { aarch64: { artifacts: {} } } }))
  ).rejects.toThrow(/no applehv/);
});

test('resolveImageArtifact throws on a failed metadata fetch', async () => {
  await expect(resolveImageArtifact(TARGET, fakeFetch({}, false))).rejects.toThrow(/stream metadata/);
});
