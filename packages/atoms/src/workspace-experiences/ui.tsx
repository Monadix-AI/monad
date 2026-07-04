import type { ReactElement } from 'react';
import type { ProjectExperienceRuntime } from './runtime.ts';

import { createElement } from 'react';

import { configureWorkspaceAttachmentClient } from './chat-room/components/attachment-chip.tsx';
import { type ChatRoomExperienceHostActions, ChatRoomExperienceView } from './chat-room/components/view.tsx';
import { configureChatRoomComposerClient } from './chat-room/composer-client.ts';
import { configureChatRoomNativeCliClient } from './chat-room/native-cli-observation-client.ts';
import { GraphViewExperienceView } from './graph-view/components/view.tsx';
import { builtinWorkspaceExperiences } from './registry.ts';
import { createProjectExperienceRuntime } from './runtime.ts';

type ProjectExperienceViewLike = {
  runtime: unknown;
};

export type BuiltinWorkspaceExperienceHostActions = ChatRoomExperienceHostActions;

export type BuiltinWorkspaceExperienceClient = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openModelSettings?: () => void;
};

export function configureBuiltinWorkspaceExperienceClients(client: BuiltinWorkspaceExperienceClient): void {
  configureWorkspaceAttachmentClient(client);
  configureChatRoomComposerClient(client);
  configureChatRoomNativeCliClient(client);
}

export function renderBuiltinWorkspaceExperience(args: {
  component: string;
  host: BuiltinWorkspaceExperienceHostActions;
  view: ProjectExperienceViewLike;
}): ReactElement | null {
  const runtime = args.view.runtime as ProjectExperienceRuntime;
  if (args.component === 'chat-room') {
    const view = runtime.views['chat-room'];
    return createElement(ChatRoomExperienceView, {
      host: args.host,
      runtime: {
        canvas: view.canvas,
        composer: view.composer
      }
    });
  }
  if (args.component === 'graphic-view') {
    return createElement(GraphViewExperienceView, { canvas: runtime.views['graphic-view'].canvas });
  }
  return null;
}

export { builtinWorkspaceExperiences, createProjectExperienceRuntime };
