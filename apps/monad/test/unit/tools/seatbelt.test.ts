import { expect, test } from 'bun:test';
import { buildSeatbeltProfile } from '@monad/sandbox/launchers/seatbelt';

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

test('maskedFiles degrade to deny — the real path joins the file-read deny set', () => {
  const p = buildSeatbeltProfile({
    writableRoots: ['/tmp'],
    net: 'unrestricted',
    maskedFiles: [{ real: '/home/u/.netrc', fake: '/tmp/mask/0.fake' }]
  });
  // SBPL can't redirect a read, so the masked file's REAL path is denied (literal, one file).
  expect(p).toMatch(/\(deny file-read\* [^)]*\(literal "[^"]*\.netrc"\)/);
  // The fake path is never named in the profile (the child simply can't read the real one).
  expect(p.includes('0.fake')).toBe(false);
  expect(p.indexOf('(deny file-read*')).toBeGreaterThan(p.indexOf('(allow default)'));
});

test('maskedFiles and readDenyRoots share one file-read deny rule', () => {
  const p = buildSeatbeltProfile({
    writableRoots: ['/tmp'],
    net: 'unrestricted',
    readDenyRoots: ['/tmp/secrets'],
    maskedFiles: [{ real: '/home/u/.netrc', fake: '/f' }]
  });
  expect(p).toMatch(/\(subpath "[^"]*secrets"\)/);
  expect(p).toMatch(/\(literal "[^"]*\.netrc"\)/);
});
