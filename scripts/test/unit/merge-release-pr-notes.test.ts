import { expect, test } from 'bun:test';

import { mergeReleasePrNotes } from '../../merge-release-pr-notes.ts';

test('release note updates preserve the Release Please envelope and version metadata', () => {
  const original = `:robot: I have created a release *beep* *boop*
---

## [0.1.7](https://github.com/Monadix-AI/monad/compare/v0.1.6...v0.1.7) (2026-08-20)

### Features

* stale note

---
This PR was generated with Release Please.`;

  const merged = mergeReleasePrNotes(
    original,
    '### Bug Fixes\n\n* Fix the failed release gate\n\n**Full Changelog**: compare link'
  );

  expect(merged).toEqual(`:robot: I have created a release *beep* *boop*
---

## [0.1.7](https://github.com/Monadix-AI/monad/compare/v0.1.6...v0.1.7) (2026-08-20)

### Bug Fixes

* Fix the failed release gate

**Full Changelog**: compare link

---
This PR was generated with Release Please.
`);
});

test('an unparseable release PR fails before its body can be overwritten', () => {
  expect(() => mergeReleasePrNotes('ordinary pull request', 'generated notes')).toThrow(
    'release PR body must contain Release Please delimiters'
  );
  expect(() => mergeReleasePrNotes('header\n---\nnotes\n---\nfooter', 'generated notes')).toThrow(
    'release PR body must contain a version heading'
  );
});
