import { expect, test } from 'bun:test';

import { generateStaticParams } from '../../app/(shell)/studio/[section]/page';

test('studio section route statically exports every known section', () => {
  expect(generateStaticParams()).toEqual([
    { section: 'agents' },
    { section: 'orchestration' },
    { section: 'models' },
    { section: 'atoms' },
    { section: 'skills' },
    { section: 'mcpServers' },
    { section: 'channels' },
    { section: 'acpAgents' },
    { section: 'nativeCliAgents' },
    { section: 'tools' },
    { section: 'api' },
    { section: 'approvals' },
    { section: 'memory' },
    { section: 'graph' },
    { section: 'mem0' },
    { section: 'hooks' },
    { section: 'mcpAtoms' },
    { section: 'sandbox' },
    { section: 'usage' }
  ]);
});
