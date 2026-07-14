import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureBaseImage,
  hostImageTarget,
  type ImageTarget,
  imageArtifactCachePath,
  resolveImageArtifact,
  streamResponseToFile
} from '../../src/image.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';

const TARGET: ImageTarget = { arch: 'aarch64', platform: 'applehv', format: 'raw.gz', decompress: 'gzip', ext: '.img' };
const QEMU_TARGET: ImageTarget = {
  arch: 'x86_64',
  platform: 'qemu',
  format: 'qcow2.xz',
  decompress: 'xz',
  ext: '.qcow2'
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  configureVmToolchain({});
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

test('hostImageTarget picks applehv on darwin, qemu on linux, hyperv on windows', () => {
  const t = hostImageTarget();
  if (process.platform === 'darwin') expect(t.platform).toBe('applehv');
  else if (process.platform === 'linux') expect(t.platform).toBe('qemu');
  else if (process.platform === 'win32') {
    expect(t.platform).toBe('hyperv');
    expect(t.format).toBe('vhdx.zip');
    expect(t.ext).toBe('.vhdx');
  }
});

test('resolveImageArtifact pulls the hyperv vhdx.zip disk for a Windows target', async () => {
  const HYPERV_STREAM = {
    architectures: {
      x86_64: {
        artifacts: {
          hyperv: {
            formats: {
              'vhdx.zip': { disk: { location: 'https://example/fcos-hyperv.x86_64.vhdx.zip', sha256: 'f00d' } }
            }
          }
        }
      }
    }
  };
  const target: ImageTarget = {
    arch: 'x86_64',
    platform: 'hyperv',
    format: 'vhdx.zip',
    decompress: 'zip',
    ext: '.vhdx'
  };
  const a = await resolveImageArtifact(target, fakeFetch(HYPERV_STREAM));
  expect(a.location).toBe('https://example/fcos-hyperv.x86_64.vhdx.zip');
  expect(a.sha256).toBe('f00d');
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

test('resolveImageArtifact retries a transient metadata connection failure', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection reset');
    return { ok: true, status: 200, json: async () => STREAM };
  }) as unknown as typeof fetch;

  const artifact = await resolveImageArtifact(TARGET, fetchImpl);

  expect(artifact.sha256).toBe('deadbeef');
  expect(attempts).toBe(2);
});

test('ensureBaseImage uses fully verified cached metadata when the stream is offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-image-cache-'));
  temporaryDirectories.push(root);
  configureVmToolchain({ vmDir: root });
  await mkdir(join(root, 'images'), { recursive: true });
  const contents = 'verified cached base image';
  const digest = new Bun.CryptoHasher('sha256').update(contents).digest('hex');
  const destination = join(root, 'images', `${digest.slice(0, 16)}.img`);
  await writeFile(destination, contents);
  await writeFile(
    imageArtifactCachePath(TARGET),
    JSON.stringify({
      location: 'https://example/fedora-coreos-applehv.aarch64.raw.gz',
      sha256: 'a'.repeat(64),
      uncompressedSha256: digest
    })
  );
  let consentCalls = 0;

  const result = await ensureBaseImage(
    async () => {
      consentCalls += 1;
      return false;
    },
    (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch
  );

  expect(result).toBe(destination);
  expect(consentCalls).toBe(0);
});

test('streamResponseToFile writes a response incrementally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-image-stream-'));
  temporaryDirectories.push(root);
  const destination = join(root, 'artifact.partial');
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode('first-'));
      else if (pulls === 2) controller.enqueue(new TextEncoder().encode('second'));
      else controller.close();
    }
  });

  await streamResponseToFile(new Response(body), destination);

  expect(await Bun.file(destination).text()).toBe('first-second');
  expect(pulls).toBe(3);
});
