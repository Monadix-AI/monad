import type { ProjectExperienceView } from '../types';

import { AgentTasksRail } from '../../activity/AgentTasksRail';
import { ChatTranscript } from '../../activity/ChatTranscript';
import { Composer } from '../../Composer';

export function ChatRoomExperienceView({ runtime }: ProjectExperienceView): React.ReactElement {
  const room = runtime.chatRoom.canvas;
  return (
    <>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ChatTranscript room={room} />
        </div>
        <Composer room={room} />
      </div>

      <AgentTasksRail room={room} />
    </>
  );
}
