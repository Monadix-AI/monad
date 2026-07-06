// Offline tests for the prebuilt-MCP-binary installer (services/mcp-install/binary.ts): the release
// fetch is injected, so no network. Covers platform/arch asset selection, MANDATORY SHA256 (abort on
// mismatch, before any write), default-deny consent, raw + .tar.gz extraction, and the hot config write.

import type { ReleaseAssetFetcher } from '@/capabilities/mcp/install/binary.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installMcpBinary,
  McpBinaryInstallError,
  parseChecksums,
  selectReleaseAsset
} from '@/capabilities/mcp/install/binary.ts';

let mcpDir: string;
beforeEach(async () => {
  mcpDir = await mkdtemp(join(tmpdir(), 'monad-mcpbin-'));
});
afterEach(async () => {
  await rm(mcpDir, { recursive: true, force: true });
});

const source = { owner: 'acme', repo: 'widget-mcp', tag: 'v1.0.0' };
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** A fetcher that always returns the given asset, ignoring platform/arch. */
function fixedFetch(name: string, bytes: Uint8Array): ReleaseAssetFetcher {
  return async () => ({ name, bytes });
}

// ── asset selection ──────────────────────────────────────────────────────────
test('selectReleaseAsset picks the platform+arch asset and skips checksums/sigs', () => {
  const names = [
    'widget-mcp-darwin-arm64.tar.gz',
    'widget-mcp-linux-x64.tar.gz',
    'widget-mcp-windows-x64.exe',
    'checksums.txt',
    'widget-mcp-darwin-arm64.tar.gz.sha256'
  ];
  expect(selectReleaseAsset(names, 'darwin', 'arm64')).toBe('widget-mcp-darwin-arm64.tar.gz');
  expect(selectReleaseAsset(names, 'linux', 'x64')).toBe('widget-mcp-linux-x64.tar.gz');
  expect(selectReleaseAsset(names, 'win32', 'x64')).toBe('widget-mcp-windows-x64.exe');
});

test('selectReleaseAsset matches arch aliases (aarch64, amd64)', () => {
  expect(selectReleaseAsset(['srv-linux-aarch64'], 'linux', 'arm64')).toBe('srv-linux-aarch64');
  expect(selectReleaseAsset(['srv-linux-amd64'], 'linux', 'x64')).toBe('srv-linux-amd64');
});

// ── install ──────────────────────────────────────────────────────────────────
test('installs a raw binary after verifying its SHA-256 and writes a hot config', async () => {
  const bytes = new TextEncoder().encode('#!/bin/sh\necho hi\n');
  const out = await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-darwin-arm64', bytes),
    expectedSha256: sha256(bytes),
    consent: () => true,
    platform: 'darwin',
    arch: 'arm64',
    args: ['stdio']
  });

  expect(out).toMatchObject({ name: 'widget' });
  const cfg = JSON.parse(await Bun.file(join(mcpDir, 'widget.json')).text()) as {
    mcpServers: Record<string, { command: string; args?: string[] }>;
  };
  const w = cfg.mcpServers.widget;
  if (!w) throw new Error('widget not installed');
  expect(w.command).toBe(join(mcpDir, 'widget', 'bin', 'widget-mcp'));
  expect(w.args).toEqual(['stdio']);
  expect(await Bun.file(w.command).text()).toContain('echo hi');
});

test('appends .exe to a raw Windows binary so it is launchable', async () => {
  const bytes = new TextEncoder().encode('MZ windows binary');
  await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-windows-x64', bytes), // raw asset, no extension
    expectedSha256: sha256(bytes),
    consent: () => true,
    platform: 'win32',
    arch: 'x64'
  });

  const cfg = JSON.parse(await Bun.file(join(mcpDir, 'widget.json')).text()) as {
    mcpServers: Record<string, { command: string }>;
  };
  const w = cfg.mcpServers.widget;
  if (!w) throw new Error('widget not installed');
  expect(w.command).toBe(join(mcpDir, 'widget', 'bin', 'widget-mcp.exe'));
  expect(await Bun.file(w.command).exists()).toBe(true);
});

test('does not double-append .exe when the Windows asset already has one', async () => {
  const bytes = new TextEncoder().encode('MZ windows binary');
  await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-mcp.exe', bytes),
    expectedSha256: sha256(bytes),
    consent: () => true,
    platform: 'win32',
    arch: 'x64',
    binName: 'widget-mcp.exe'
  });

  const cfg = JSON.parse(await Bun.file(join(mcpDir, 'widget.json')).text()) as {
    mcpServers: Record<string, { command: string }>;
  };
  expect(cfg.mcpServers.widget?.command).toBe(join(mcpDir, 'widget', 'bin', 'widget-mcp.exe'));
});

test('aborts on a SHA-256 mismatch before writing anything', async () => {
  const bytes = new TextEncoder().encode('binary');
  await expect(
    installMcpBinary('widget', source, {
      mcpDir,
      fetch: fixedFetch('widget-darwin-arm64', bytes),
      expectedSha256: 'deadbeef',
      consent: () => true,
      platform: 'darwin',
      arch: 'arm64'
    })
  ).rejects.toThrow(McpBinaryInstallError);
  expect(await Bun.file(join(mcpDir, 'widget.json')).exists()).toBe(false);
});

test('parseChecksums parses sha256sum-style lines', () => {
  const m = parseChecksums(`${'a'.repeat(64)}  file-a\n${'b'.repeat(64)} *file-b\n# a comment\n`);
  expect(m.get('file-a')).toBe('a'.repeat(64));
  expect(m.get('file-b')).toBe('b'.repeat(64));
  expect(m.size).toBe(2);
});

test('auto-verifies against the release SHA256SUMS when no explicit hash is given', async () => {
  const bytes = new TextEncoder().encode('verified binary');
  const checksums = new Map([['widget-darwin-arm64', sha256(bytes)]]);
  const out = await installMcpBinary('widget', source, {
    mcpDir,
    fetch: async () => ({ name: 'widget-darwin-arm64', bytes, checksums }),
    consent: () => true,
    platform: 'darwin',
    arch: 'arm64'
  });
  expect(out).toMatchObject({ name: 'widget' });
  expect(await Bun.file(join(mcpDir, 'widget.json')).exists()).toBe(true);
});

test('aborts when neither an explicit hash nor a checksums asset is available', async () => {
  await expect(
    installMcpBinary('widget', source, {
      mcpDir,
      fetch: fixedFetch('widget-darwin-arm64', new TextEncoder().encode('bin')),
      consent: () => true,
      platform: 'darwin',
      arch: 'arm64'
    })
  ).rejects.toThrow(/cannot verify/);
});

test('default-deny: consent=false writes nothing', async () => {
  const bytes = new TextEncoder().encode('binary');
  const out = await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-darwin-arm64', bytes),
    expectedSha256: sha256(bytes),
    consent: () => false,
    platform: 'darwin',
    arch: 'arm64'
  });
  expect(out.needsConsent).toBe(true);
  expect(await Bun.file(join(mcpDir, 'widget.json')).exists()).toBe(false);
});

test('extracts the binary from a .tar.gz archive', async () => {
  // Build a minimal gzipped ustar archive with one file `widget-mcp`.
  const content = new TextEncoder().encode('ELF-ish bytes');
  const tar = makeTar('widget-mcp', content);
  const gz = Bun.gzipSync(tar);

  const out = await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-darwin-arm64.tar.gz', gz),
    expectedSha256: sha256(gz),
    consent: () => true,
    platform: 'darwin',
    arch: 'arm64'
  });

  const cfg = JSON.parse(await Bun.file(join(mcpDir, `${out.name}.json`)).text()) as {
    mcpServers: Record<string, { command: string }>;
  };
  const w = cfg.mcpServers.widget;
  if (!w) throw new Error('widget not installed');
  expect(await Bun.file(w.command).text()).toBe('ELF-ish bytes');
});

test('extracts the binary from a .zip archive (Windows assets)', async () => {
  const content = new TextEncoder().encode('windows binary');
  const zip = makeStoredZip('widget-mcp.exe', content);
  const out = await installMcpBinary('widget', source, {
    mcpDir,
    fetch: fixedFetch('widget-windows-x64.zip', zip),
    expectedSha256: sha256(zip),
    consent: () => true,
    platform: 'win32',
    arch: 'x64',
    binName: 'widget-mcp.exe'
  });

  const cfg = JSON.parse(await Bun.file(join(mcpDir, `${out.name}.json`)).text()) as {
    mcpServers: Record<string, { command: string }>;
  };
  const w = cfg.mcpServers.widget;
  if (!w) throw new Error('widget not installed');
  expect(await Bun.file(w.command).text()).toBe('windows binary');
});

/** Minimal single-entry STORED (uncompressed) ZIP — enough to exercise the .zip extraction path. */
function makeStoredZip(name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const nb = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nb.length + content.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint32(18, content.length, true);
  lv.setUint32(22, content.length, true);
  lv.setUint16(26, nb.length, true);
  local.set(nb, 30);
  local.set(content, 30 + nb.length);

  const cd = new Uint8Array(46 + nb.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint32(20, content.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nb.length, true);
  cd.set(nb, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + cd.length + 22);
  out.set(local, 0);
  out.set(cd, local.length);
  out.set(eocd, local.length + cd.length);
  return out as Uint8Array<ArrayBuffer>;
}

/** Minimal single-file ustar archive (512-byte header + padded content). */
function makeTar(name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0); // name
  header.set(enc.encode('000644 '), 100); // mode
  header.set(enc.encode('000000 '), 108); // uid
  header.set(enc.encode('000000 '), 116); // gid
  header.set(enc.encode(`${content.length.toString(8).padStart(11, '0')} `), 124); // size (octal)
  header.set(enc.encode('00000000000 '), 136); // mtime
  header[156] = '0'.charCodeAt(0); // typeflag = regular file
  header.set(enc.encode('ustar'), 257);
  // checksum: spaces then sum
  header.set(enc.encode('        '), 148);
  let sum = 0;
  for (const b of header) sum += b;
  header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);

  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
  padded.set(content);
  const out = new Uint8Array(512 + padded.length + 1024); // + two zero blocks (end marker)
  out.set(header, 0);
  out.set(padded, 512);
  return out;
}
