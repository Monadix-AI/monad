import type { WorkspaceExperienceDefinition } from '@monad/sdk-atom';

// First-party dogfood of the `web-component` delivery path: graph-view ships as a same-origin JS
// module (served by the web app from public/experiences/graph-view.js) that defines the
// `monad-graph-view` custom element and binds to the host via the event bridge — the exact path a
// third-party experience takes. It renders from `api.snapshot.graphCanvas` (participants + activity,
// stamped onto the published snapshot by the host runtime). chat-room stays `host-component`.
export const graphicViewWorkspaceExperience: WorkspaceExperienceDefinition = {
  id: 'graphic-view',
  title: 'Activity',
  icon: 'git-fork',
  entry: {
    type: 'web-component',
    module: '/experiences/graph-view.js',
    tagName: 'monad-graph-view'
  }
};
