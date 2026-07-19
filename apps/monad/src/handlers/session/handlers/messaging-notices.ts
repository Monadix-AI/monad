import type { ChannelResponseNextTarget } from '@monad/protocol';
import type { ManagedMeshAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';

import { definePrompt } from '#/agent/prompt-template.ts';
import channelNextPath from '../prompts/channel-next-user.prompt.md' with { type: 'file' };
import busyInboxNoticePath from '../prompts/managed-busy-inbox-user.prompt.md' with { type: 'file' };
import directNoticePath from '../prompts/managed-direct-user.prompt.md' with { type: 'file' };
import inboxNoticePath from '../prompts/managed-inbox-user.prompt.md' with { type: 'file' };
import resumeRecoveryNoticePath from '../prompts/managed-resume-recovery-user.prompt.md' with { type: 'file' };

const CHANNEL_NEXT_PROMPT = await definePrompt<ChannelResponseNextTarget>({
  id: 'channel.next.user',
  sourcePath: channelNextPath
});
type SenderPromptData = { senderId?: string; senderKind: string; senderMention?: string; senderName: string };
const INBOX_NOTICE_PROMPT = await definePrompt<SenderPromptData & { text: string }>({
  id: 'managed.inbox.user',
  sourcePath: inboxNoticePath
});
const BUSY_INBOX_NOTICE_PROMPT = await definePrompt<SenderPromptData>({
  id: 'managed.busy-inbox.user',
  sourcePath: busyInboxNoticePath
});
const DIRECT_NOTICE_PROMPT = await definePrompt<{ fromAgentName: string; text: string }>({
  id: 'managed.direct.user',
  sourcePath: directNoticePath
});
const RESUME_RECOVERY_NOTICE_PROMPT = await definePrompt<{ notice: string }>({
  id: 'managed.resume-recovery.user',
  sourcePath: resumeRecoveryNoticePath
});

export interface ManagedMeshAgentProjectMessageSender {
  kind: 'human' | 'mesh-agent' | 'agent' | 'system';
  name: string;
  id?: string;
}

export function meshAgentInputText(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

export function normalizeManagedMeshAgentDirectTarget(to: string): string {
  return to.startsWith('mesh-agent:') ? to.slice('mesh-agent:'.length) : to;
}

export function channelNextPrompt(target: ChannelResponseNextTarget): string {
  return CHANNEL_NEXT_PROMPT.render(target);
}

function mentionTokenValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function managedMeshAgentSenderMentionId(sender: ManagedMeshAgentProjectMessageSender): string {
  if (sender.kind === 'mesh-agent') {
    return sender.id?.startsWith('mesh-agent:') ? sender.id : `mesh-agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'agent') {
    return sender.id?.startsWith('agent:') ? sender.id : `agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'human') return sender.id ?? 'human';
  return sender.id ?? sender.name;
}

function managedMeshAgentSenderMentionToken(sender?: ManagedMeshAgentProjectMessageSender): string | null {
  if (!sender?.name) return null;
  const id = managedMeshAgentSenderMentionId(sender);
  return `@[name="${mentionTokenValue(sender.name)}" id="${mentionTokenValue(id)}"]`;
}

export function managedMeshAgentInboxNotice(
  _member: ManagedMeshAgentProjectMember,
  text: string,
  sender?: ManagedMeshAgentProjectMessageSender
): string {
  const senderMention = managedMeshAgentSenderMentionToken(sender);
  return INBOX_NOTICE_PROMPT.render({
    text,
    senderKind: sender?.kind ?? 'unknown',
    senderName: sender?.name ?? 'unknown',
    ...(sender?.id ? { senderId: sender.id } : {}),
    ...(senderMention ? { senderMention } : {})
  });
}

export function managedMeshAgentBusyInboxNotice(
  _member: ManagedMeshAgentProjectMember,
  sender?: ManagedMeshAgentProjectMessageSender
): string {
  const senderMention = managedMeshAgentSenderMentionToken(sender);
  return BUSY_INBOX_NOTICE_PROMPT.render({
    senderKind: sender?.kind ?? 'unknown',
    senderName: sender?.name ?? 'unknown',
    ...(sender?.id ? { senderId: sender.id } : {}),
    ...(senderMention ? { senderMention } : {})
  });
}

export function managedMeshAgentDirectNotice({
  member: _member,
  fromAgentName,
  text
}: {
  member: ManagedMeshAgentProjectMember;
  fromAgentName: string;
  text: string;
}): string {
  return DIRECT_NOTICE_PROMPT.render({ fromAgentName, text });
}

export function managedMeshAgentResumeRecoveryNotice(provider: string, notice: string): string {
  void provider;
  return RESUME_RECOVERY_NOTICE_PROMPT.render({ notice });
}
