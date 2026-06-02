import { expect, test } from 'bun:test';

test('channel settings uses the base plural key for chat counts', async () => {
  const source = await Bun.file(new URL('../../components/ChannelsSettings.tsx', import.meta.url)).text();

  expect(source).toContain('i18nKey="web.ch.chats"');
  expect(source).not.toContain('web.ch.chats_one');
  expect(source).not.toContain('web.ch.chats_other');
});
