import { expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(path).text();

test('native agent HTTP controller delegates project and direct capability behavior', async () => {
  const source = await read('apps/monad/src/transports/http/native-agent.ts');

  for (const forbidden of [
    'completeManagedNativeCliProjectMessage',
    'beginProjectQaWallMessage',
    'completeProjectQaWallMessage',
    'notifyManagedNativeCliProjectMembers',
    'notifyManagedNativeCliDirectMessage',
    'insertNativeAgentDirectMessage',
    'listNativeAgentDirectMessages',
    'listNativeCliInbox',
    'markNativeCliInboxVisible',
    'markNativeCliInboxConsumed'
  ]) {
    expect(source.includes(forbidden)).toBe(false);
  }
  expect(source.includes('createDefaultNativeAgentCapabilities')).toBe(true);
});

test('native agent base registry has no project-experience import', async () => {
  const source = await read('apps/monad/src/services/native-agent/capabilities.ts');
  expect(source.includes('/services/chatroom/')).toBe(false);
  expect(source.includes('@/services/chatroom/')).toBe(false);
});

test('native CLI host substrate does not import project-experience capability modules', async () => {
  const files = [
    'apps/monad/src/services/native-cli/host.ts',
    'apps/monad/src/services/native-cli/managed-project.ts',
    'apps/monad/src/services/native-cli/types.ts'
  ];
  const sources = await Promise.all(files.map(read));
  for (const source of sources) {
    expect(source.includes('/services/chatroom/')).toBe(false);
    expect(source.includes('@/services/chatroom/')).toBe(false);
  }
});

test('native CLI lifecycle does not own project Q&A wall projection', async () => {
  const files = [
    'apps/monad/src/handlers/session/handlers/managed-native-cli-messages.ts',
    'apps/monad/src/handlers/session/handlers/managed-native-cli-delivery.ts',
    'apps/monad/src/handlers/session/handlers/messaging.ts'
  ];
  const sources = await Promise.all(files.map(read));
  for (const source of sources) {
    expect(source.includes('beginProjectQaWallMessage')).toBe(false);
    expect(source.includes('completeProjectQaWallMessage')).toBe(false);
    expect(source.includes("kind: 'project-qa'")).toBe(false);
  }
});
