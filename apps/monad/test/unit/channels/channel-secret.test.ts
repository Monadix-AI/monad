import { expect, test } from 'bun:test';
import { channelInstanceSchema } from '@monad/environment';
import { setChannelCredentialRequestSchema } from '@monad/protocol';

test('channel credential is stored directly and secret-reference syntax is rejected', () => {
  expect(
    channelInstanceSchema.parse({
      id: 'chn_TESTCHANNEL0',
      type: 'telegram',
      label: 'Test',
      credential: { token: 'direct-token', extra: { account: 'primary' } }
    }).credential
  ).toEqual({ token: 'direct-token', extra: { account: 'primary' } });
  expect(
    channelInstanceSchema.safeParse({
      id: 'chn_TESTCHANNEL0',
      type: 'telegram',
      label: 'Test',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: rejection test uses the literal legacy syntax
      credential: { token: '${secret:channel/test/token}' }
    }).success
  ).toBe(false);
});

test('channel credential writes distinguish replace and remove', () => {
  expect(
    setChannelCredentialRequestSchema.parse({
      action: 'replace',
      value: { token: 'direct-token', extra: { account: 'primary' } }
    })
  ).toEqual({
    action: 'replace',
    value: { token: 'direct-token', extra: { account: 'primary' } }
  });
  expect(setChannelCredentialRequestSchema.parse({ action: 'remove' })).toEqual({ action: 'remove' });
});
