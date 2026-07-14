import { expect, test } from 'bun:test';

import { buildIgnition } from '../../src/ignition.ts';
import { buildVmMountPlan, type MountPlanHost } from '../../src/mount-plan.ts';

const directories = new Set(['/ws', '/lib', '/ws/.ssh', '/Users/x', '/Users/x/.aws', '/work']);
const host: MountPlanHost = {
  platform: 'linux',
  async realpath(path) {
    if (!directories.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return path;
  },
  async kind(path) {
    return directories.has(path) ? 'directory' : 'missing';
  },
  async assertReadable() {}
};

test('writable roots map to rw shares and readable roots map to ro shares', async () => {
  const plan = await buildVmMountPlan({ writableRoots: ['/ws'], readableRoots: ['/lib'] }, host);
  expect(plan.shares).toEqual([
    { tag: 'w0', hostPath: '/ws', guestPath: '/ws', readOnly: false },
    { tag: 'r0', hostPath: '/lib', guestPath: '/lib', readOnly: true }
  ]);
});

test('a read-deny nested under a share becomes a later overlay', async () => {
  const plan = await buildVmMountPlan({ readableRoots: ['/ws'], readDenyRoots: ['/ws/.ssh'] }, host);
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: '/ws/.ssh' }]);
});

test('a read-deny outside every share remains absent without an overlay', async () => {
  const plan = await buildVmMountPlan({ writableRoots: ['/work'], readDenyRoots: ['/Users/x/.aws'] }, host);
  expect(plan.overlays).toEqual([]);
});

test('net:none produces a drop-all firewall', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    observerBinaryB64: 'QQ==',
    mounts: [],
    egress: { mode: 'none' }
  });
  const nft = cfg.storage.files.find((f) => (f as { path?: string }).path === '/etc/monad/nftables.conf') as
    | { contents: { source: string } }
    | undefined;
  const rules = Buffer.from((nft?.contents.source ?? '').replace(/^data:;base64,/, ''), 'base64').toString('utf8');
  expect(rules).toContain('policy drop;');
  expect(rules).not.toContain('dport 53');
});
