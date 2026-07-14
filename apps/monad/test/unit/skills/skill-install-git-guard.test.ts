import { expect, test } from 'bun:test';

import { assertSafeGitRef, installGitSkill } from '#/capabilities/skills/install/git.ts';

// The git+ skill source is attacker-controllable and reaches `git clone` before any consent/scan
// gate. git's remote-helper transports (ext::, fd::) execute code at clone time, so a malicious
// source would be RCE on the daemon host. These cases must be rejected by assertSafeGitRef *before*
// any git process is spawned — deps are intentionally bogus to prove no clone/staging work happens.
const deps = {
  skillsDir: '/nonexistent/skills',
  skillsLock: '/nonexistent/skills.lock',
  consent: () => true
};

test.each([
  ['ext:: remote helper (code exec)', 'git+ext::sh -c "touch /tmp/monad-pwned"'],
  ['fd:: remote helper', 'git+fd::7'],
  ['file: local transport', 'git+file:///etc/passwd'],
  ['disallowed scheme', 'git+gopher://evil.example/repo'],
  ['option-injection branch', 'git+https://example.com/r@-upload-pack=touch']
])('rejects a dangerous git source before cloning: %s', async (_label, source) => {
  await expect(installGitSkill(source, deps)).rejects.toThrow(/Refusing git/);
});

test('accepts a well-formed https source without depending on a network clone', () => {
  expect(() => assertSafeGitRef('https://example.com/owner/repo.git')).not.toThrow();
});
