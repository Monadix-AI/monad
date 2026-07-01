import { expect, test } from 'bun:test';
import { SKILL_MARKETPLACE_SOURCES } from '@monad/protocol';

import { generateStaticParams } from '../../app/(shell)/studio/[section]/[[...trail]]/page';

test('studio section route statically exports every known section', () => {
  // Each bare section carries an explicit empty `trail` so the optional catch-all's root case is
  // enumerated for `output: export` (see the page's generateStaticParams comment). The section list
  // stays hardcoded as a guard against accidental additions/removals in STUDIO_SECTION_IDS.
  const sections = [
    'agents',
    'orchestration',
    'models',
    'atoms',
    'skills',
    'mcpServers',
    'channels',
    'thirdPartyAgents',
    'acpAgents',
    'nativeCliAgents',
    'capabilities',
    'tools',
    'api',
    'approvals',
    'memory',
    'graph',
    'mem0',
    'hooks',
    'mcpAtoms',
    'sandbox',
    'usage'
  ];
  expect(generateStaticParams()).toEqual([
    ...sections.map((section) => ({ section, trail: [] })),
    ...SKILL_MARKETPLACE_SOURCES.map((entry) => ({ section: 'skills', trail: ['marketplace', entry.source] }))
  ]);
});
