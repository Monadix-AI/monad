import { expect, test } from 'bun:test';

import { buildIgnition } from '../../src/ignition.ts';
import { mountsFor } from '../../src/index.ts';

// ── mount-mapping security guards (srt-style: fail closed on ambiguous confinement) ────────────────

test('writable roots map to rw mounts, readable to ro — the write-confine surface', () => {
  const mounts = mountsFor({ writableRoots: ['/ws'], readableRoots: ['/lib'] });
  expect(mounts).toEqual([
    { tag: 'w0', path: '/ws', readOnly: false },
    { tag: 'r0', path: '/lib', readOnly: true }
  ]);
});

test('readDenyRoot NESTED under a mounted root is rejected (would be exposed by the subtree mount)', () => {
  // Mirrors srt's inode-vs-path deny-bypass concern: a denied path under an allowed root can't be
  // subtracted by virtio-fs, so we fail closed rather than silently leak it.
  expect(() => mountsFor({ readableRoots: ['/Users/x'], readDenyRoots: ['/Users/x/.ssh'] })).toThrow(/nested under/);
  expect(() => mountsFor({ writableRoots: ['/Users/x'], readDenyRoots: ['/Users/x'] })).toThrow(/nested under/);
});

test('readDenyRoot OUTSIDE every mounted root is fine (it is simply never mounted → absent in guest)', () => {
  // /Users/x/.aws is not under /work, so it is never mounted and cannot be read — no rejection needed.
  const mounts = mountsFor({ writableRoots: ['/work'], readDenyRoots: ['/Users/x/.aws'] });
  expect(mounts).toEqual([{ tag: 'w0', path: '/work', readOnly: false }]);
  // A sibling that shares a path PREFIX string but not a path boundary must not false-match.
  expect(() => mountsFor({ writableRoots: ['/work'], readDenyRoots: ['/work-secrets'] })).not.toThrow();
});

test('net:none produces a drop-all firewall (fail-closed egress)', () => {
  const cfg = buildIgnition({ agentBinaryB64: 'QQ==', mounts: [], egress: { mode: 'none' } });
  const nft = cfg.storage.files.find((f) => (f as { path?: string }).path === '/etc/monad/nftables.conf') as
    | { contents: { source: string } }
    | undefined;
  const rules = Buffer.from((nft?.contents.source ?? '').replace(/^data:;base64,/, ''), 'base64').toString('utf8');
  expect(rules).toContain('policy drop;');
  expect(rules).not.toContain('dport 53'); // no DNS, no proxy — nothing leaves
});
