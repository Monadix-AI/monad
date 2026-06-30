import type { ProjectExperienceView } from '../types';

import { AgentTasksRail } from '../../activity/AgentTasksRail';
import { Composer } from '../../Composer';
import { chatPreset } from '../../presets/chat/ChatPreset';
import { ProjectHeader } from '../../project-shell/ProjectHeader';

export function ChatRoomExperienceView({ embedded, project, runtime, t }: ProjectExperienceView): React.ReactElement {
  return (
    <>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ProjectHeader
          embedded={embedded}
          project={project}
        />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {chatPreset.render({ canvas: runtime.snapshot, embedded, t })}
        </div>
        <Composer room={project} />
      </div>

      <AgentTasksRail room={project} />
    </>
  );
}
