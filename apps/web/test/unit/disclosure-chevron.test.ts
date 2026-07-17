import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const disclosureSources = [
  '../../src/components/ToastProvider.tsx',
  '../../src/features/session/SessionTranscript.tsx',
  '../../src/features/shell/sidebar/workspace-section.tsx',
  '../../src/features/studio/capabilities-settings/McpServersSubsection.tsx',
  '../../src/features/studio/channels-settings/index.tsx',
  '../../src/features/studio/memory-settings/FactsView.tsx',
  '../../src/features/studio/memory-settings/LawsView.tsx',
  '../../src/features/studio/third-party-agents/AcpAgentsSettings.tsx',
  '../../../../packages/atoms/src/workspace-experiences/chat-room/components/observation/timeline.tsx',
  '../../../../packages/ui/src/components/AIElements.tsx',
  '../../../../packages/ui/src/components/ObservationCard.tsx'
] as const;

test('disclosure controls use the shared down-up morph without rotation or right chevrons', () => {
  for (const path of disclosureSources) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');

    expect(source, path).toContain('MorphChevron');
    expect(source, path).not.toMatch(/(?:-rotate-90|rotate-180|rotate\(-90deg\)|group-open:rotate)/);
    expect(source, path).not.toMatch(/(?:ChevronRightIcon|ArrowRight01Icon)/);
  }
});
