import type { ReactElement } from 'react';
import type { GraphicViewExperienceRuntime } from './runtime.ts';

import { createElement } from 'react';

import { GraphViewExperienceView } from './components/view.tsx';

export function renderGraphViewWorkspaceExperience(runtime: GraphicViewExperienceRuntime): ReactElement {
  return createElement(GraphViewExperienceView, { canvas: runtime.canvas });
}
