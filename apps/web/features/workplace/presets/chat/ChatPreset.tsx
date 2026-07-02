import type { PresetDefinition, ProjectView } from '../types';

import { ChatTranscript } from '../../activity/ChatTranscript';

function ChatPresetView({ canvas }: ProjectView): React.ReactElement {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ChatTranscript room={canvas} />
    </div>
  );
}

export const chatPreset: PresetDefinition = {
  id: 'chat',
  labelKey: 'web.workplace.preset.chat',
  icon: 'message-square',
  source: 'builtin',
  render: ChatPresetView
};
