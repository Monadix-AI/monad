import type { ReactElement } from 'react';
import type { ChatRoomExperienceRuntime } from './runtime.ts';

import { createElement } from 'react';

import { configureWorkspaceAttachmentClient } from './components/attachment-chip.tsx';
import { type ChatRoomExperienceHostActions, ChatRoomExperienceView } from './components/view.tsx';
import { configureChatRoomComposerClient } from './composer-client.ts';
import { configureChatRoomNativeCliClient } from './native-cli-observation-client.ts';

export type ChatRoomExperienceClient = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openModelSettings?: () => void;
};

export function configureChatRoomExperienceClients(client: ChatRoomExperienceClient): void {
  configureWorkspaceAttachmentClient(client);
  configureChatRoomComposerClient(client);
  configureChatRoomNativeCliClient(client);
}

export function renderChatRoomWorkspaceExperience(args: {
  host: ChatRoomExperienceHostActions;
  runtime: ChatRoomExperienceRuntime;
}): ReactElement {
  return createElement(ChatRoomExperienceView, {
    host: args.host,
    runtime: args.runtime
  });
}
