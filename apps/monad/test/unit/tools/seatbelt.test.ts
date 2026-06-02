import { expect, test } from 'bun:test';

import { buildSeatbeltProfile } from '../../../../../packages/atoms/src/sandbox/seatbelt.ts';

// Pure profile generation — runs on any platform.

test('profile denies writes + network and re-allows the writable root', () => {
  const p = buildSeatbeltProfile({ writableRoots: ['/tmp'], net: 'none' });
  expect(p).toContain('(allow default)');
  expect(p).toContain('(deny network*)');
  expect(p).toContain('(deny file-write*)');
  expect(p).toMatch(/\(allow file-write\* \(subpath "[^"]+"\)/);
  expect(p).toContain('(literal "/dev/null")');
});

test('unrestricted network omits the network deny', () => {
  expect(buildSeatbeltProfile({ writableRoots: [], net: 'unrestricted' })).not.toContain('network');
});

test('writableRoots undefined applies no write confinement (unrestricted mode)', () => {
  const p = buildSeatbeltProfile({ net: 'unrestricted' });
  expect(p).not.toContain('file-write');
});

test('writableRoots empty array is a strict deny-all-writes policy', () => {
  const p = buildSeatbeltProfile({ writableRoots: [], net: 'none' });
  expect(p).toContain('(deny file-write*)');
  expect(p).toContain('(literal "/dev/null")');
});

test('proxy-only network denies all then allows the loopback proxy port', () => {
  const p = buildSeatbeltProfile({ writableRoots: [], net: { allowProxyPort: 54321 } });
  expect(p).toContain('(deny network*)');
  expect(p).toContain('localhost:54321');
});

test('readDenyRoots emits a file-read deny after allow-default so it wins', () => {
  const p = buildSeatbeltProfile({ writableRoots: ['/tmp'], net: 'unrestricted', readDenyRoots: ['/tmp/secrets'] });
  expect(p).toMatch(/\(deny file-read\* \(subpath "[^"]*secrets"\)\)/);
  // deny-read must come after allow-default (last match wins in SBPL).
  expect(p.indexOf('(deny file-read*')).toBeGreaterThan(p.indexOf('(allow default)'));
});

test('no readDenyRoots emits no file-read rule', () => {
  expect(buildSeatbeltProfile({ writableRoots: [], net: 'none' })).not.toContain('file-read');
});
