// The guest base image: Fedora CoreOS `applehv` aarch64 `raw.gz`. vfkit only accepts raw disks
// (its binary literally contains "vfkit does not support qcow2 image format"), and CoreOS is the one
// mainstream distro that publishes a purpose-built applehv raw image with native Ignition support.
//
// Discovery goes through the CoreOS stream metadata (a rolling release, so we don't hard-code a single
// URL): stable.json → architectures.aarch64.artifacts.applehv.formats["raw.gz"].{location,sha256}.
// The image is downloaded once to <vmDir>/images/<sha>.img (base, read-only); each VM APFS-clones it.
//
// First download is gated on an explicit confirmation callback — unlike Cowork's silent multi-hundred-MB
// pull, monad tells the user the source/size/path and waits for a yes (observability-first).

import { chmodSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { vmDir } from './toolchain.ts';
import { sha256OfFile } from './util.ts';

const STREAM_URL = 'https://builds.coreos.fedoraproject.org/streams/stable.json';

export interface ImageArtifact {
  location: string;
  sha256: string;
  /** The uncompressed disk sha256 (CoreOS provides `uncompressed-sha256`). */
  uncompressedSha256?: string;
}

/** Resolve the applehv aarch64 raw.gz artifact from the CoreOS stream metadata. */
export async function resolveImageArtifact(fetchImpl: typeof fetch = fetch): Promise<ImageArtifact> {
  const res = await fetchImpl(STREAM_URL);
  if (!res.ok) throw new Error(`vm image: stream metadata fetch failed ${res.status}`);
  const stream = (await res.json()) as {
    architectures?: {
      aarch64?: {
        artifacts?: {
          applehv?: {
            formats?: Record<
              string,
              Record<string, { location: string; signature?: string; sha256?: string; 'uncompressed-sha256'?: string }>
            >;
          };
        };
      };
    };
  };
  const fmt = stream.architectures?.aarch64?.artifacts?.applehv?.formats?.['raw.gz'];
  const disk = fmt?.disk;
  if (!disk?.location || !disk.sha256) {
    throw new Error('vm image: no applehv aarch64 raw.gz in CoreOS stream metadata');
  }
  return { location: disk.location, sha256: disk.sha256, uncompressedSha256: disk['uncompressed-sha256'] };
}

export function imagesDir(): string {
  return join(vmDir(), 'images');
}

/** Called before a first download; returns true to proceed. The daemon wires this to a user prompt. */
export type ImageConsent = (info: { url: string; sha256: string; dest: string }) => Promise<boolean>;

/** Ensure the base image is present and verified. Returns its on-disk path. Downloads (with consent)
 *  and decompresses on first use; a cached image is re-verified by sha256 before reuse (every VM
 *  clones this base, so one poisoned cache file would compromise all guests — never trust it on
 *  filename alone). */
export async function ensureBaseImage(consent: ImageConsent, fetchImpl: typeof fetch = fetch): Promise<string> {
  const artifact = await resolveImageArtifact(fetchImpl);
  const stamp = artifact.uncompressedSha256 ?? artifact.sha256;
  const dest = join(imagesDir(), `${stamp.slice(0, 16)}.img`);
  if (existsSync(dest)) {
    // Re-hash the cache against the expected uncompressed digest when CoreOS publishes one; a
    // mismatch means tampering/corruption → delete and re-download rather than boot a poisoned base.
    if (artifact.uncompressedSha256) {
      const got = await sha256OfFile(dest);
      if (got === artifact.uncompressedSha256) return dest;
      const { rm } = await import('node:fs/promises');
      await rm(dest, { force: true });
    } else {
      return dest;
    }
  }

  const ok = await consent({ url: artifact.location, sha256: artifact.sha256, dest });
  if (!ok) throw new Error('vm image: download declined by user');

  await mkdir(imagesDir(), { recursive: true });
  const gzPath = `${dest}.gz.partial`;
  const res = await fetchImpl(artifact.location);
  if (!res.ok) throw new Error(`vm image: download failed ${res.status}`);
  await Bun.write(gzPath, res);

  // Verify the compressed artifact before decompressing.
  const gotGz = await sha256OfFile(gzPath);
  if (gotGz !== artifact.sha256) {
    throw new Error(`vm image: raw.gz sha256 mismatch (expected ${artifact.sha256}, got ${gotGz})`);
  }

  // Decompress with the system gunzip (streams; no full in-memory buffer of a multi-GB disk).
  const rawPartial = `${dest}.partial`;
  const gunzip = Bun.spawn(['sh', '-c', `gunzip -c ${JSON.stringify(gzPath)} > ${JSON.stringify(rawPartial)}`], {
    stdout: 'ignore',
    stderr: 'pipe'
  });
  if ((await gunzip.exited) !== 0) {
    const err = await new Response(gunzip.stderr).text();
    throw new Error(`vm image: decompress failed: ${err}`);
  }

  if (artifact.uncompressedSha256) {
    const gotRaw = await sha256OfFile(rawPartial);
    if (gotRaw !== artifact.uncompressedSha256) {
      throw new Error(`vm image: raw sha256 mismatch (expected ${artifact.uncompressedSha256}, got ${gotRaw})`);
    }
  }

  const { rename, rm } = await import('node:fs/promises');
  await rename(rawPartial, dest);
  await rm(gzPath, { force: true });
  chmodSync(dest, 0o444); // base image is read-only; VMs clone it
  return dest;
}
