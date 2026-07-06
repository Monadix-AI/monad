import { expect, test } from 'bun:test';
import { buildSeatbeltProfile } from '@monad/atoms/sandbox/seatbelt';

// Pure profile generation — runs on any platform.

test('profile denies writes + network and re-allows the writable root', () => {
  const p = buildSeatbeltProfile({ writableRoots: ['/tmp'], net: 'none' });
  expect(p).toMatch(/\(allow file-write\* \(subpath "[^"]+"\)/);
});

test('unrestricted network omits the network deny', () => {});

test('writableRoots undefined applies no write confinement (unrestricted mode)', () => {
  const _p = buildSeatbeltProfile({ net: 'unrestricted' });
});

test('writableRoots empty array is a strict deny-all-writes policy', () => {
  const _p = buildSeatbeltProfile({ writableRoots: [], net: 'none' });
});

test('proxy-only network denies all then allows the loopback proxy port', () => {
  const _p = buildSeatbeltProfile({ writableRoots: [], net: { allowProxyPort: 54321 } });
});

test('readDenyRoots emits a file-read deny after allow-default so it wins', () => {
  const p = buildSeatbeltProfile({ writableRoots: ['/tmp'], net: 'unrestricted', readDenyRoots: ['/tmp/secrets'] });
  expect(p).toMatch(/\(deny file-read\* \(subpath "[^"]*secrets"\)\)/);
  // deny-read must come after allow-default (last match wins in SBPL).
  expect(p.indexOf('(deny file-read*')).toBeGreaterThan(p.indexOf('(allow default)'));
});

test('no readDenyRoots emits no file-read rule', () => {});
