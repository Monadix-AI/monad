import { expect, test } from 'bun:test';

import { installGitSkill } from '#/capabilities/skills/install/git.ts';

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

test('still accepts a well-formed https source (fails later at the network clone, not the guard)', async () => {
  // A safe URL passes the guard; it then fails at the actual clone against a non-resolving host.
  // The point is the rejection is NOT a "Refusing git" guard error.
  await expect(installGitSkill('git+https://monad.invalid/does-not-exist.git', deps)).rejects.not.toThrow(
    /Refusing git/
  );
});
