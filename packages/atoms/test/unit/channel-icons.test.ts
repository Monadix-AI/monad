import { expect, test } from 'bun:test';

import { emailChannelAtom } from '../../src/channels/email.ts';
import { feishuChannelAtom } from '../../src/channels/feishu.ts';
import { ircChannelAtom } from '../../src/channels/irc.ts';
import { qqChannelAtom } from '../../src/channels/qq.ts';
import { slackChannelAtom } from '../../src/channels/slack.ts';
import { teamsChannelAtom } from '../../src/channels/teams.ts';
import { twilioChannelAtom } from '../../src/channels/twilio.ts';
import { webhookChannelAtom } from '../../src/channels/webhook.ts';
import { wecomChannelAtom } from '../../src/channels/wecom.ts';

test('channel atoms expose the selected brand or semantic icon metadata', () => {
  const atoms = [
    emailChannelAtom,
    feishuChannelAtom,
    ircChannelAtom,
    teamsChannelAtom,
    qqChannelAtom,
    slackChannelAtom,
    twilioChannelAtom,
    webhookChannelAtom,
    wecomChannelAtom
  ];

  expect(
    atoms.map((atom) => ({
      type: atom.type,
      title: atom.icon?.title,
      hex: atom.icon?.hex ?? null,
      viewBox: atom.icon?.viewBox ?? [0, 0, 24, 24],
      pathHash: new Bun.CryptoHasher('sha256').update(atom.icon?.path ?? '').digest('hex')
    }))
  ).toEqual([
    {
      type: 'email',
      title: 'Email',
      hex: null,
      viewBox: [0, 0, 24, 24],
      pathHash: 'd2216c63e13b606e6cb6c64b8fa908738a16ccd8ca8d06cfd421078dfabee6df'
    },
    {
      type: 'feishu',
      title: 'Feishu / Lark',
      hex: null,
      viewBox: [0, 0, 700, 700],
      pathHash: 'd373d2811e9d6a057d3b49ceaf87cda19547a67556fd2f931070b9f839acc136'
    },
    {
      type: 'irc',
      title: 'IRC',
      hex: null,
      viewBox: [0, 0, 24, 24],
      pathHash: '9c741f51e67281641e9c1a3d3b4497e2382fc6c33a9c287e0eac729d887ae29b'
    },
    {
      type: 'teams',
      title: 'Microsoft Teams',
      hex: null,
      viewBox: [0, 0, 192, 192],
      pathHash: 'e0a550c9a8897a279a567dc8c11f7ba2fabdc05f00f4905bf622627017a7d5e0'
    },
    {
      type: 'qq',
      title: 'QQ',
      hex: null,
      viewBox: [800, 55, 60, 70],
      pathHash: 'b2f14b968bf8b25841f4edbd832e123bc177268778e884fedc44d13ed816deb0'
    },
    {
      type: 'slack',
      title: 'Slack',
      hex: null,
      viewBox: [0, 0, 54, 54],
      pathHash: 'e3b1f8d8f32e5c03ff27ccaff050185b836f92c5e1a009f1eeaaf9c7b4e98d19'
    },
    {
      type: 'twilio',
      title: 'Twilio',
      hex: 'F22F46',
      viewBox: [0, 0, 24, 24],
      pathHash: '639c066ffe1a39d9603bb22964ac02f6da8e78c0f5ef262b300c5e9672f2a171'
    },
    {
      type: 'webhook',
      title: 'Webhook',
      hex: null,
      viewBox: [0, 0, 24, 24],
      pathHash: '8de3dd5fee2c0eb373d1c32c50e4ec1d0b872d52e3957c1cea633e2ac55a42f8'
    },
    {
      type: 'wecom',
      title: 'WeCom',
      hex: null,
      viewBox: [0, 0, 512, 512],
      pathHash: '60d66a8a804d1a5f3c4ea966edd321c31660c77df1a091ac3a825f074896a278'
    }
  ]);

  expect(
    [teamsChannelAtom, qqChannelAtom].map((atom) => ({
      type: atom.type,
      layerCount: atom.icon?.layers?.length,
      layerHash: new Bun.CryptoHasher('sha256').update(JSON.stringify(atom.icon?.layers ?? [])).digest('hex'),
      gradientIds: atom.icon?.gradients?.map((gradient) => gradient.id) ?? []
    }))
  ).toEqual([
    {
      type: 'teams',
      layerCount: 6,
      layerHash: '1909e8d0e0ea246a08894b8dcd7eee53f44f0b5079d24c8795fb3ea8b454e077',
      gradientIds: ['teams-head', 'teams-body', 'teams-body-right', 'teams-tile']
    },
    {
      type: 'qq',
      layerCount: 9,
      layerHash: '37fcc98f5dbf538b1e506fc9525ad3ca1284ae3172be3d68c79cb0bfa61b0625',
      gradientIds: []
    }
  ]);
});
