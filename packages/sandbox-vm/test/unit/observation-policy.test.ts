import { expect, test } from 'bun:test';

import { observationPolicyFor } from '../../src/observation-policy.ts';

test('derives sorted writable roots and preserves nested no-write precedence', () => {
  const policy = observationPolicyFor({
    shares: [
      { tag: 'w1', hostPath: '/z', guestPath: '/z', readOnly: false },
      { tag: 'w0', hostPath: '/work', guestPath: '/work', readOnly: false },
      { tag: 'r0', hostPath: '/work/vendor', guestPath: '/work/vendor', readOnly: true },
      { tag: 'r1', hostPath: '/work/vendor-copy', guestPath: '/work/vendor', readOnly: true }
    ],
    overlays: [
      { kind: 'deny-directory', target: '/work/.ssh' },
      { kind: 'mask-file', source: '/run/monad/masks/0/token', target: '/work/token' },
      { kind: 'protect-store', source: '/run/monad/masks/0', target: '/work/.masks' }
    ]
  });

  expect(policy).toEqual({
    writableRoots: ['/work', '/z'],
    noWriteRoots: ['/work/.masks', '/work/.ssh', '/work/token', '/work/vendor']
  });
});

test('uses translated Windows guest paths without exposing host drive syntax', () => {
  const policy = observationPolicyFor({
    shares: [
      { tag: 'w0', hostPath: 'c:\\work', guestPath: '/mnt/c/work', readOnly: false },
      { tag: 'r0', hostPath: 'd:\\sdk', guestPath: '/mnt/d/sdk', readOnly: true }
    ],
    overlays: [{ kind: 'deny-file', target: '/mnt/c/work/token' }]
  });

  expect(policy).toEqual({
    writableRoots: ['/mnt/c/work'],
    noWriteRoots: ['/mnt/d/sdk', '/mnt/c/work/token']
  });
  expect(JSON.stringify(policy)).not.toContain('c:');
});
