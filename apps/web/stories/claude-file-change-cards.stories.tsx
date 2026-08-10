import type { AgentObservationEvent } from '@monad/protocol';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  CodexFileChangeCard,
  claudeFileChangeView
} from '../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/codex-file-change-card.tsx';

function claudeFileChange(tool: 'Write' | 'Edit' | 'MultiEdit', input: Record<string, unknown>) {
  const call = {
    id: `call_${tool}`,
    kind: 'tool-call',
    provenance: { contractEvents: [] },
    streaming: false,
    tool: { name: tool, input }
  } satisfies AgentObservationEvent;
  const result = {
    id: `result_${tool}`,
    kind: 'tool-result',
    provenance: { contractEvents: [] },
    streaming: false,
    tool: { name: tool, output: 'Completed.', status: 'completed' }
  } satisfies AgentObservationEvent;
  const view = claudeFileChangeView(call, result);
  if (!view) throw new Error(`Expected ${tool} file change story`);
  return view;
}

const views = {
  Write: claudeFileChange('Write', {
    file_path: '/workspace/src/new-file.ts',
    content: 'export const ready = true;\n'
  }),
  Edit: claudeFileChange('Edit', {
    file_path: '/workspace/src/existing-file.ts',
    old_string: 'const ready = false;',
    new_string: 'const ready = true;'
  }),
  MultiEdit: claudeFileChange('MultiEdit', {
    file_path: '/workspace/src/multiple-edits.ts',
    edits: [
      { old_string: 'const first = false;', new_string: 'const first = true;' },
      { old_string: 'const second = 0;', new_string: 'const second = 1;' }
    ]
  })
};

const meta = {
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mx-auto w-full max-w-3xl">
          <Story />
        </div>
      </div>
    )
  ],
  parameters: { layout: 'fullscreen' },
  title: 'Chat/Claude File Change Cards'
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllTools: Story = {
  render: () => (
    <div className="grid gap-5">
      {Object.entries(views).map(([tool, view]) => (
        <CodexFileChangeCard
          key={tool}
          view={view}
        />
      ))}
    </div>
  )
};
export const Write: Story = { render: () => <CodexFileChangeCard view={views.Write} /> };
export const Edit: Story = { render: () => <CodexFileChangeCard view={views.Edit} /> };
export const MultiEdit: Story = { render: () => <CodexFileChangeCard view={views.MultiEdit} /> };
