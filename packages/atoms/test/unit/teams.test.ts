import { expect, test } from 'bun:test';

import { normalizeTeamsActivity } from '../../src/channels/teams.ts';

test('TM1: message activity → inbound keyed by conversation; personal → dm', () => {
  const ev = normalizeTeamsActivity({
    type: 'message',
    id: 'a1',
    text: 'hi',
    from: { id: 'u1', name: 'Al' },
    conversation: { id: 'c1', conversationType: 'personal' },
    recipient: { id: 'bot' }
  });
  expect(ev).toMatchObject({ chatId: 'c1', userId: 'u1', text: 'hi', chatType: 'dm', senderDisplay: 'Al' });
});

test('TM2: channel conversation → group; mentionedSelf from mention entity', () => {
  const ev = normalizeTeamsActivity({
    type: 'message',
    text: 'hey',
    conversation: { id: 'c1', conversationType: 'channel' },
    recipient: { id: 'bot' },
    entities: [{ type: 'mention', mentioned: { id: 'bot' } }]
  });
  expect(ev).toMatchObject({ chatType: 'group', mentionedSelf: true });
});

test('TM3: non-message / no conversation → null', () => {
  expect(normalizeTeamsActivity({ type: 'typing', conversation: { id: 'c' } })).toBe(null);
  expect(normalizeTeamsActivity({ type: 'message', text: 'x' })).toBe(null);
});

import { isAllowedTeamsServiceUrl } from '../../src/channels/teams.ts';

test('TM4: serviceUrl SSRF allowlist accepts Bot Framework hosts, rejects others', () => {
  expect(isAllowedTeamsServiceUrl('https://smba.trafficmanager.net/amer/')).toBe(true);
  expect(isAllowedTeamsServiceUrl('https://europe.botframework.com/')).toBe(true);
  expect(isAllowedTeamsServiceUrl('https://attacker.example.com/')).toBe(false);
  expect(isAllowedTeamsServiceUrl('http://169.254.169.254/')).toBe(false); // metadata SSRF
  expect(isAllowedTeamsServiceUrl('not a url')).toBe(false);
});
