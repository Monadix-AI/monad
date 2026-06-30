import type { ProjectExperienceView } from '../types';

import { AgentTasksRail } from '../../AgentTasksRail';
import { Composer } from '../../Composer';
import { ProjectHeader } from '../../ProjectHeader';
import { graphPreset } from '../../presets/graph/GraphPreset';

export function GraphicViewExperienceView({
  embedded,
  project,
  runtime,
  t
}: ProjectExperienceView): React.ReactElement {
  return (
    <>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ProjectHeader
          embedded={embedded}
          project={project}
        />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {graphPreset.render({ canvas: runtime.snapshot, embedded, t })}
        </div>
        <Composer room={project} />
      </div>

      <AgentTasksRail room={project} />
    </>
  );
}
