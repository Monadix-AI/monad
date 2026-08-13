import { expect, test } from 'bun:test';

import {
  atomDescriptorSchema,
  atomPackManifestSchema,
  createSkillRequestSchema,
  installAtomPackRequestSchema,
  installedAtomPackSchema,
  installSkillRequestSchema,
  updateAtomPackRequestSchema,
  uploadSkillQuerySchema
} from '../src/atom-pack.ts';

const installedPack = {
  name: 'example-pack',
  displayName: 'Example Pack',
  version: '1.2.3',
  atoms: ['channel'] as const,
  enabled: true,
  source: 'github:example/pack@abc123'
};

test('connector is not an Atom Pack kind', () => {
  expect(() =>
    atomPackManifestSchema.parse({
      name: 'legacy-connector',
      version: '1.0.0',
      sdkVersion: '0',
      atoms: ['connector']
    })
  ).toThrow();
});

test('installed atom packs carry daemon-owned update eligibility with a backward-compatible default', () => {
  expect({
    updateable: installedAtomPackSchema.parse({ ...installedPack, canUpdate: true }),
    legacy: installedAtomPackSchema.parse(installedPack)
  }).toEqual({
    updateable: { ...installedPack, atoms: ['channel'], canUpdate: true, atomDetails: [] },
    legacy: { ...installedPack, atoms: ['channel'], canUpdate: false, atomDetails: [] }
  });
});

test('channel atom descriptors carry a validated declarative setup guide', () => {
  const descriptor = {
    kind: 'channel' as const,
    id: 'telegram',
    channel: {
      connectionMode: 'pairing' as const,
      setup: {
        summary: 'Connect a Telegram bot.',
        steps: ['Create a bot.', 'Paste its token.'],
        docsUrl: 'https://core.telegram.org/bots/tutorial'
      }
    }
  };

  expect(atomDescriptorSchema.parse(descriptor)).toEqual({
    ...descriptor,
    channel: { envVars: [], ...descriptor.channel }
  });
  expect(() =>
    atomDescriptorSchema.parse({
      ...descriptor,
      channel: { setup: { ...descriptor.channel.setup, docsUrl: 'javascript:alert(1)' } }
    })
  ).toThrow();
});

test('Atom Pack installs accept only GitHub repositories and local development directories', () => {
  expect([
    installAtomPackRequestSchema.parse({ source: 'github:example/pack@main' }).source,
    installAtomPackRequestSchema.parse({ source: 'local:/tmp/example-pack' }).source
  ]).toEqual(['github:example/pack@main', 'local:/tmp/example-pack']);
  expect(() => installAtomPackRequestSchema.parse({ source: 'npm:example-pack@1.0.0' })).toThrow();
});

test('Atom Pack updates require confirmation of the checked revision', () => {
  expect(updateAtomPackRequestSchema.parse({ confirm: true, revision: 'abc123' })).toEqual({
    confirm: true,
    revision: 'abc123'
  });
  expect(() => updateAtomPackRequestSchema.parse({ confirm: true })).toThrow();
});

test('skill mutations accept an Agent target without changing workspace requests', () => {
  const agentId = 'agt_100000000000';

  expect({
    installAgent: installSkillRequestSchema.parse({
      source: 'github:example/skills@main',
      target: { kind: 'agent', agentId }
    }),
    installWorkspace: installSkillRequestSchema.parse({ source: 'github:example/skills@main' }),
    createAgent: createSkillRequestSchema.parse({
      name: 'private-skill',
      content: '---\nname: private-skill\ndescription: Private\n---\n',
      target: { kind: 'agent', agentId }
    }),
    uploadAgent: uploadSkillQuerySchema.parse({ filename: 'skill.zip', agentId })
  }).toEqual({
    installAgent: {
      source: 'github:example/skills@main',
      consent: false,
      overwrite: false,
      target: { kind: 'agent', agentId }
    },
    installWorkspace: {
      source: 'github:example/skills@main',
      consent: false,
      overwrite: false
    },
    createAgent: {
      name: 'private-skill',
      content: '---\nname: private-skill\ndescription: Private\n---\n',
      target: { kind: 'agent', agentId }
    },
    uploadAgent: { filename: 'skill.zip', agentId }
  });

  expect(() =>
    installSkillRequestSchema.parse({
      source: 'github:example/skills@main',
      target: { kind: 'agent', agentId: '../agents/default' }
    })
  ).toThrow();
});
