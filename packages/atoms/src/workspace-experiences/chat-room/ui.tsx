import type { ReactElement } from 'react';
import type { ChatRoomExperienceRuntime } from './runtime.ts';

import { createElement } from 'react';

import { ChatRoomExperienceView } from './components/view.tsx';

export function renderChatRoomWorkspaceExperience(args: { runtime: ChatRoomExperienceRuntime }): ReactElement {
  return createElement(ChatRoomExperienceView, { runtime: args.runtime });
}
