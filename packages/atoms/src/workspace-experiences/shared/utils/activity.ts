import type { UIItem } from '@monad/protocol';
import type { ActivityRow } from '../../experience/types.ts';

import { avatarForAgent, summarizeTool } from '../../experience/project-projection.ts';

export function activityRowsFromTools(liveTools: readonly Extract<UIItem, { kind: 'tool' }>[]): ActivityRow[] {
  return liveTools.map((s) => ({
    id: s.id,
    av:
      typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
        ? avatarForAgent((s.input as { agent: string }).agent)
        : 'MO',
    ...(typeof (s.input as { agent?: unknown } | undefined)?.agent === 'string'
      ? { agentName: (s.input as { agent: string }).agent }
      : {}),
    tool: s.tool,
    detail: summarizeTool(s.tool, s.input),
    ...(s.output ? { output: s.output } : {}),
    status: s.status
  }));
}
