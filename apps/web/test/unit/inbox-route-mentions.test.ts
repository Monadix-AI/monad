import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Inbox mention items render through the shared MentionText capsule renderer', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/features/inbox/InboxRoute.tsx'), 'utf8');

  expect(source).toContain("import { MentionText } from '@monad/ui/components/MentionText'");
  expect(source).toContain('<MentionText text={item.message.text} />');
});
