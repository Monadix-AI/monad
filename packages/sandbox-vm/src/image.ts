// The guest base image: Fedora CoreOS `applehv` aarch64 `raw.gz`. vfkit only accepts raw disks
// (its binary literally contains "vfkit does not support qcow2 image format"), and CoreOS is the one
// mainstream distro that publishes a purpose-built applehv raw image with native Ignition support.
//
// Discovery goes through the CoreOS stream metadata (a rolling release, so we don't hard-code a single
// URL): stable.json → architectures.aarch64.artifacts.applehv.formats["raw.gz"].{location,sha256}.
// The image is downloaded once to <vmDir>/images/<sha>.img (base, read-only); each VM APFS-clones it.
//
// First download is gated on an explicit confirmation callback: rather than a silent multi-hundred-MB
// pull, monad tells the user the source/size/path and waits for a yes (observability-first).

import { chmodSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { vmDir } from './toolchain.ts';
import { sha256OfFile } from './util.ts';

const STREAM_URL = 'https://builds.coreos.fedoraproject.org/streams/stable.json';

/** The CoreOS artifact coordinates for a host: arch key, VMM platform, and disk format (which also
 *  fixes the compression + output extension). */
export interface ImageTarget {
  arch: 'aarch64' | 'x86_64';
  platform: 'applehv' | 'qemu' | 'hyperv';
  format: 'raw.gz' | 'qcow2.xz' | 'vhdx.zip';
  decompress: 'gzip' | 'xz' | 'zip';
  ext: '.img' | '.qcow2' | '.vhdx';
}

/** The image target for the current host OS + arch. CoreOS publishes a purpose-built artifact per
 *  VMM platform: applehv raw (vfkit), qemu qcow2, and hyperv vhdx (both x86_64 and aarch64). */
export function hostImageTarget(): ImageTarget {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
  if (process.platform === 'darwin')
    return { arch, platform: 'applehv', format: 'raw.gz', decompress: 'gzip', ext: '.img' };
  if (process.platform === 'win32')
    return { arch, platform: 'hyperv', format: 'vhdx.zip', decompress: 'zip', ext: '.vhdx' };
  return { arch, platform: 'qemu', format: 'qcow2.xz', decompress: 'xz', ext: '.qcow2' };
}

export interface ImageArtifact {
  location: string;
  sha256: string;
  /** The uncompressed disk sha256 (CoreOS provides `uncompressed-sha256`). */
  uncompressedSha256?: string;
}

type StreamJson = {
  architectures?: Record<
    string,
    {
      artifacts?: Record<
        string,
        {
          formats?: Record<
            string,
            Record<string, { location: string; signature?: string; sha256?: string; 'uncompressed-sha256'?: string }>
          >;
        }
      >;
    }
  >;
};

/** Resolve the disk artifact for a target from the CoreOS stream metadata. */
export async function resolveImageArtifact(
  target: ImageTarget = hostImageTarget(),
  fetchImpl: typeof fetch = fetch
): Promise<ImageArtifact> {
  const res = await fetchImpl(STREAM_URL);
  if (!res.ok) throw new Error(`vm image: stream metadata fetch failed ${res.status}`);
  const stream = (await res.json()) as StreamJson;
  const fmt = stream.architectures?.[target.arch]?.artifacts?.[target.platform]?.formats?.[target.format];
  const disk = fmt?.disk;
  if (!disk?.location || !disk.sha256) {
    throw new Error(`vm image: no ${target.platform} ${target.arch} ${target.format} in CoreOS stream metadata`);
  }
  return { location: disk.location, sha256: disk.sha256, uncompressedSha256: disk['uncompressed-sha256'] };
}

export function imagesDir(): string {
  return join(vmDir(), 'images');
}

/** Decompress `src` into `dest` with the host's system tool, streaming (never a multi-GB in-memory
 *  buffer). gzip/xz use the POSIX tools (mac/linux hosts); zip (the hyperv vhdx) is extracted with
 *  bsdtar — `tar.exe` ships with Windows 10 1803+ and reads zip archives; `-xOf` streams the entry
 *  to stdout so we never need an extraction directory. */
async function decompressTo(kind: ImageTarget['decompress'], src: string, dest: string): Promise<void> {
  if (kind === 'zip') {
    // `tar -xO` streams EVERY archive member concatenated — if the zip ever ships a sidecar
    // (checksum/README) alongside the vhdx, the output would be a corrupt disk. Assert a single
    // member first so that failure is loud, not a silently-broken image.
    const list = Bun.spawn(['tar', '-tf', src], { stdout: 'pipe', stderr: 'pipe' });
    const names = (await new Response(list.stdout).text()).split('\n').filter((l) => l.trim() !== '');
    if ((await list.exited) !== 0) {
      throw new Error(`vm image: cannot list zip members: ${await new Response(list.stderr).text()}`);
    }
    if (names.length !== 1) {
      throw new Error(`vm image: expected exactly one member in ${src}, found ${names.length}: ${names.join(', ')}`);
    }
    const dec = Bun.spawn(['tar', '-xOf', src], { stdout: Bun.file(dest), stderr: 'pipe' });
    if ((await dec.exited) !== 0) {
      throw new Error(`vm image: decompress failed: ${await new Response(dec.stderr).text()}`);
    }
    return;
  }
  const dec = Bun.spawn(
    ['sh', '-c', `${kind === 'xz' ? 'unxz -c' : 'gunzip -c'} ${JSON.stringify(src)} > ${JSON.stringify(dest)}`],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  if ((await dec.exited) !== 0) {
    throw new Error(`vm image: decompress failed: ${await new Response(dec.stderr).text()}`);
  }
}

/** Called before a first download; returns true to proceed. The daemon wires this to a user prompt. */
export type ImageConsent = (info: { url: string; sha256: string; dest: string }) => Promise<boolean>;

/** Ensure the base image is present and verified. Returns its on-disk path. Downloads (with consent)
 *  and decompresses on first use; a cached image is re-verified by sha256 before reuse (every VM
 *  clones this base, so one poisoned cache file would compromise all guests — never trust it on
 *  filename alone). */
export async function ensureBaseImage(consent: ImageConsent, fetchImpl: typeof fetch = fetch): Promise<string> {
  const target = hostImageTarget();
  const artifact = await resolveImageArtifact(target, fetchImpl);
  const stamp = artifact.uncompressedSha256 ?? artifact.sha256;
  const dest = join(imagesDir(), `${stamp.slice(0, 16)}${target.ext}`);
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
  const cprPath = `${dest}.cmp.partial`;
  const res = await fetchImpl(artifact.location);
  if (!res.ok) throw new Error(`vm image: download failed ${res.status}`);
  await Bun.write(cprPath, res);

  // Verify the compressed artifact before decompressing.
  const gotCmp = await sha256OfFile(cprPath);
  if (gotCmp !== artifact.sha256) {
    throw new Error(`vm image: compressed sha256 mismatch (expected ${artifact.sha256}, got ${gotCmp})`);
  }

  // Decompress with the system tool (streams; no full in-memory buffer of a multi-GB disk).
  const rawPartial = `${dest}.partial`;
  await decompressTo(target.decompress, cprPath, rawPartial);

  if (artifact.uncompressedSha256) {
    const gotRaw = await sha256OfFile(rawPartial);
    if (gotRaw !== artifact.uncompressedSha256) {
      throw new Error(`vm image: disk sha256 mismatch (expected ${artifact.uncompressedSha256}, got ${gotRaw})`);
    }
  }

  const { rename, rm } = await import('node:fs/promises');
  await rename(rawPartial, dest);
  await rm(cprPath, { force: true });
  chmodSync(dest, 0o444); // base image is read-only; VMs clone it
  return dest;
}
