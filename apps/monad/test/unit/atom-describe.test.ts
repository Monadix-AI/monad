import { expect, test } from 'bun:test';
import builtinAtomPack from '@monad/atoms';
import { monadPowerPack } from '@monad/monad-power-pack';

import { describeAtomPack } from '#/atoms/describe.ts';

test('describeAtomPack enumerates each individual atom of the built-in pack', async () => {
  const atoms = await describeAtomPack(builtinAtomPack);

  expect([...new Set(atoms.map((atom) => atom.kind))]).toEqual([
    'channel',
    'command',
    'provider',
    'agent-adapter',
    'workplace-experience'
  ]);

  // Concrete atoms are identified, not just their kind.
  const channelIds = atoms.filter((a) => a.kind === 'channel').map((a) => a.id);
  expect(channelIds).toContain('telegram');
  expect(channelIds.length).toBeGreaterThan(1);

  const slack = atoms.find((atom) => atom.kind === 'channel' && atom.id === 'slack');
  expect({
    kind: slack?.kind,
    id: slack?.id,
    name: slack?.name,
    icon: slack?.icon
      ? {
          title: slack.icon.title,
          hex: slack.icon.hex,
          officialLayerCount: slack.icon.layers?.length
        }
      : null,
    channel: slack?.channel
      ? {
          envVars: slack.channel.envVars,
          icon: slack.channel.icon
            ? {
                title: slack.channel.icon.title,
                hex: slack.channel.icon.hex,
                officialLayerCount: slack.channel.icon.layers?.length
              }
            : null
        }
      : null
  }).toEqual({
    kind: 'channel',
    id: 'slack',
    name: 'Slack',
    icon: { title: 'Slack', hex: undefined, officialLayerCount: 8 },
    channel: {
      envVars: [
        {
          name: 'SLACK_BOT_TOKEN',
          description: 'Bot token (xoxb-…) for Web API calls',
          required: true,
          secret: true,
          credentialKey: 'token'
        },
        {
          name: 'SLACK_APP_TOKEN',
          description: 'App-level token (xapp-…) for Socket Mode',
          required: true,
          secret: true,
          credentialKey: 'appToken'
        }
      ],
      icon: { title: 'Slack', hex: undefined, officialLayerCount: 8 }
    }
  });

  const google = atoms.find((atom) => atom.kind === 'provider' && atom.id === 'google');
  const mistral = atoms.find((atom) => atom.kind === 'provider' && atom.id === 'mistral');
  const openai = atoms.find((atom) => atom.kind === 'provider' && atom.id === 'openai');
  const antigravity = atoms.find((atom) => atom.kind === 'agent-adapter' && atom.id === 'antigravity');
  const codex = atoms.find((atom) => atom.kind === 'agent-adapter' && atom.id === 'codex');
  const openclaw = atoms.find((atom) => atom.kind === 'agent-adapter' && atom.id === 'openclaw');
  const summarizeIcon = (atom: typeof google) => ({
    kind: atom?.kind,
    id: atom?.id,
    name: atom?.name,
    icon: atom?.icon
      ? {
          title: atom.icon.title,
          viewBox: atom.icon.viewBox,
          pathHash: new Bun.CryptoHasher('sha256').update(atom.icon.path).digest('hex'),
          layerCount: atom.icon.layers?.length ?? 1,
          gradientIds: atom.icon.gradients?.map((gradient) => gradient.id) ?? []
        }
      : null
  });
  expect({
    google: summarizeIcon(google),
    mistral: summarizeIcon(mistral),
    openai: summarizeIcon(openai),
    antigravity: summarizeIcon(antigravity),
    codex: summarizeIcon(codex),
    openclaw: summarizeIcon(openclaw)
  }).toEqual({
    google: {
      kind: 'provider',
      id: 'google',
      name: 'Google Gemini',
      icon: {
        title: 'Google Gemini',
        viewBox: [0, 0, 192, 192],
        pathHash: '97de878ea7c5c5264a362e1098f422b14e6ecc4591d8369f4ceee7ebb3cbb5fc',
        layerCount: 2,
        gradientIds: ['gemini-base', 'gemini-warm']
      }
    },
    mistral: {
      kind: 'provider',
      id: 'mistral',
      name: 'Mistral',
      icon: {
        title: 'Mistral AI',
        viewBox: [0, 0, 7, 5],
        pathHash: '8ba4b7661f4d71f887968ef14fa61fecb92487ca2eeb216348f047bb171614cc',
        layerCount: 5,
        gradientIds: []
      }
    },
    openai: {
      kind: 'provider',
      id: 'openai',
      name: 'OpenAI',
      icon: {
        title: 'OpenAI',
        viewBox: undefined,
        pathHash: '3fae9b38d571a5ab5aa662bc279dcda580855d6ca6b35330e4b4ba171367ffb1',
        layerCount: 1,
        gradientIds: []
      }
    },
    antigravity: {
      kind: 'agent-adapter',
      id: 'antigravity',
      name: 'Antigravity',
      icon: {
        title: 'Google Antigravity',
        viewBox: [0, 0, 112, 113],
        pathHash: 'b257709cd929dd22ff07c249e6216838171dd0bdb3558d2da427079d39a1e022',
        layerCount: 2,
        gradientIds: ['antigravity-base', 'antigravity-warm']
      }
    },
    codex: {
      kind: 'agent-adapter',
      id: 'codex',
      name: 'Codex',
      icon: {
        title: 'OpenAI Codex',
        viewBox: [0, 0, 24, 24],
        pathHash: 'e0088c47fa0449bd92614d7ca3390a2b9bb0a63b3597e55bf30fcf379957edd5',
        layerCount: 4,
        gradientIds: ['codex-base', 'codex-highlight']
      }
    },
    openclaw: {
      kind: 'agent-adapter',
      id: 'openclaw',
      name: 'OpenClaw',
      icon: {
        title: 'OpenClaw',
        viewBox: [0, 0, 120, 120],
        pathHash: 'd71305e5195b88c2b638a3c9587799824b576e4fbb00643cea935596db87876b',
        layerCount: 5,
        gradientIds: ['openclaw-lobster']
      }
    }
  });

  // Commands carry their human description.
  const newCommand = atoms.find((a) => a.kind === 'command' && a.id === 'new');
  expect(newCommand).toEqual({ kind: 'command', id: 'new', description: 'Start a new conversation' });
});

test('describeAtomPack enumerates the power pack sandbox launchers', async () => {
  const atoms = await describeAtomPack(monadPowerPack);

  expect(atoms.filter((atom) => atom.kind === 'sandbox')).toEqual([
    {
      kind: 'sandbox',
      id: 'docker',
      name: 'Docker / Podman',
      description: 'Runs each command in an isolated local container.'
    },
    {
      kind: 'sandbox',
      id: 'e2b',
      name: 'E2B',
      description: 'Runs commands in a reusable remote micro-VM.'
    }
  ]);
});
