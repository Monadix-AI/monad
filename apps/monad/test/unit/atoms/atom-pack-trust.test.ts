// Accepting an atom pack's kinds is not the same as accepting it to run an in-process workplace
// experience. These cases pin what evidence the daemon requires, and that a refused pack still
// loads its other atoms.

import type { WorkplaceExperienceDefinition } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { defineAtomPack, defineChannel, SDK_VERSION } from '@monad/sdk-atom';

import { resolveAtomPackExperienceTrust } from '#/atoms/trust.ts';
import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';

const GRANTED = ['workplace-experience'];

const CAPS = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 1000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: false
};

test('a drop-in pack with no install record is refused for workplace experiences', () => {
  expect(resolveAtomPackExperienceTrust({ atomPackId: 'px' })).toEqual({
    trusted: false,
    reasons: ['no install record — drop-in packs are not accepted for this kind']
  });
});

test('an install whose recorded consent omits the kind is refused', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: { sourceKind: 'local', grantedAtoms: ['channel', 'provider'] }
    })
  ).toEqual({
    trusted: false,
    reasons: ['the recorded install consent does not cover the "workplace-experience" atom kind']
  });
});

test('a local install that consented to the kind is accepted', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: { sourceKind: 'local', grantedAtoms: GRANTED }
    })
  ).toEqual({
    trusted: true,
    reasons: []
  });
});

test('a remote install is accepted only once its bundle is pinned by a recorded hash', () => {
  const unpinned = resolveAtomPackExperienceTrust({
    atomPackId: 'px',
    record: { sourceKind: 'github', commit: 'main', grantedAtoms: GRANTED }
  });
  const pinned = resolveAtomPackExperienceTrust({
    atomPackId: 'px',
    record: { sourceKind: 'github', commit: 'main', integrity: 'sha256-abc', grantedAtoms: GRANTED }
  });

  expect(unpinned).toEqual({
    trusted: false,
    reasons: ['installed from a remote source with no recorded integrity hash']
  });
  expect(pinned).toEqual({ trusted: true, reasons: [] });
});

test('an npm install without a recorded hash is refused', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: { sourceKind: 'npm', grantedAtoms: GRANTED }
    })
  ).toEqual({
    trusted: false,
    reasons: ['installed from a remote source with no recorded integrity hash']
  });
});

test('a record written before source tracking is refused until the pack is reinstalled', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: { grantedAtoms: GRANTED }
    })
  ).toEqual({
    trusted: false,
    reasons: ['install record predates source tracking — reinstall to record an accepted source']
  });
});

const EVIDENCE = { grantedAtoms: GRANTED, sourceKind: 'local' } as const;

test('the operator review policy denies a pack whose evidence would otherwise admit it', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: EVIDENCE,
      review: { policy: 'evidence', allow: [], deny: ['px'] }
    })
  ).toEqual({ trusted: false, reasons: ['denied by the operator review policy'] });
});

test('a denied pack stays denied even when the operator also allowed it', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: EVIDENCE,
      review: { policy: 'allowlist', allow: ['px'], deny: ['px'] }
    })
  ).toEqual({ trusted: false, reasons: ['denied by the operator review policy'] });
});

test('an operator-reviewed pack is admitted despite missing install evidence', () => {
  const unreviewed = resolveAtomPackExperienceTrust({ atomPackId: 'px' });
  const reviewed = resolveAtomPackExperienceTrust({
    atomPackId: 'px',
    review: { policy: 'evidence', allow: ['px'], deny: [] }
  });

  expect(unreviewed.trusted).toBe(false);
  expect(reviewed).toEqual({ trusted: true, reasons: [] });
});

test('allowlist policy refuses a pack that is not on the list, whatever its evidence', () => {
  expect(
    resolveAtomPackExperienceTrust({
      atomPackId: 'px',
      record: EVIDENCE,
      review: { policy: 'allowlist', allow: ['other-pack'], deny: [] }
    })
  ).toEqual({
    trusted: false,
    reasons: ['the operator review policy admits only packs on its allow list']
  });
});

test('a refused pack loses its experience atoms and keeps the rest', async () => {
  const registered: WorkplaceExperienceDefinition[] = [];
  const workers: string[] = [];
  const logs: string[] = [];
  const experience: WorkplaceExperienceDefinition = {
    id: 'untrusted-canvas',
    title: 'Untrusted canvas',
    entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'untrusted-canvas' }
  };
  const pack = defineAtomPack({
    manifest: {
      name: 'untrusted',
      version: '1.0.0',
      sdkVersion: SDK_VERSION,
      atoms: ['workplace-experience', 'channel']
    },
    channels: [
      defineChannel({
        type: 'untrusted-ch',
        name: 'untrusted-ch',
        icon: { title: 'Untrusted channel', path: 'M4 4h16v16H4z' },
        capabilities: CAPS,
        create: () => ({
          type: 'untrusted-ch',
          capabilities: CAPS,
          connect: async () => {},
          disconnect: async () => {},
          send: async (chatId: string) => ({ ref: '1', chatId })
        })
      })
    ],
    workplaceExperiences: [experience],
    experienceWorkers: [
      {
        experienceId: 'untrusted-canvas',
        subscriptions: [],
        onProjectStart: async () => {},
        onEvent: async () => {},
        onWake: async () => {}
      }
    ]
  });

  const channels = await loadChannelAtomPacks([pack], {
    experienceTrustFor: () => ({ trusted: false, reasons: ['no install record'] }),
    log: (_level, msg) => logs.push(msg),
    onExperienceWorker: (worker) => workers.push(worker.experienceId),
    onWorkplaceExperience: (definition) => registered.push(definition)
  });

  expect(registered).toEqual([]);
  expect(workers).toEqual([]);
  expect(channels.has('untrusted-ch')).toBe(true);
  expect(logs).toEqual([
    'workplace experience "untrusted-canvas" from "untrusted" refused: no install record',
    'workplace experience worker for "untrusted-canvas" from "untrusted" refused: no install record'
  ]);
});
