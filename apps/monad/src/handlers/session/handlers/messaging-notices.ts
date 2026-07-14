import type { ChannelResponseNextTarget } from '@monad/protocol';
import type { ManagedExternalAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';

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

export interface ManagedExternalAgentProjectMessageSender {
  kind: 'human' | 'external-agent' | 'agent' | 'system';
  name: string;
  id?: string;
}

export function externalAgentInputText(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

export function normalizeManagedExternalAgentDirectTarget(to: string): string {
  return to.startsWith('external-agent:') ? to.slice('external-agent:'.length) : to;
}

export function channelNextPrompt(target: ChannelResponseNextTarget): string {
  return CHANNEL_NEXT_PROMPT.render(target);
}

function mentionTokenValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function managedExternalAgentSenderMentionId(sender: ManagedExternalAgentProjectMessageSender): string {
  if (sender.kind === 'external-agent') {
    return sender.id?.startsWith('external-agent:') ? sender.id : `external-agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'agent') {
    return sender.id?.startsWith('agent:') ? sender.id : `agent:${sender.id ?? sender.name}`;
  }
  if (sender.kind === 'human') return sender.id ?? 'human';
  return sender.id ?? sender.name;
}

function managedExternalAgentSenderMentionToken(sender?: ManagedExternalAgentProjectMessageSender): string | null {
  if (!sender?.name) return null;
  const id = managedExternalAgentSenderMentionId(sender);
  return `@[name="${mentionTokenValue(sender.name)}" id="${mentionTokenValue(id)}"]`;
}

export function managedExternalAgentInboxNotice(
  _member: ManagedExternalAgentProjectMember,
  text: string,
  sender?: ManagedExternalAgentProjectMessageSender
): string {
  const senderMention = managedExternalAgentSenderMentionToken(sender);
  return INBOX_NOTICE_PROMPT.render({
    text,
    senderKind: sender?.kind ?? 'unknown',
    senderName: sender?.name ?? 'unknown',
    ...(sender?.id ? { senderId: sender.id } : {}),
    ...(senderMention ? { senderMention } : {})
  });
}

export function managedExternalAgentBusyInboxNotice(
  _member: ManagedExternalAgentProjectMember,
  sender?: ManagedExternalAgentProjectMessageSender
): string {
  const senderMention = managedExternalAgentSenderMentionToken(sender);
  return BUSY_INBOX_NOTICE_PROMPT.render({
    senderKind: sender?.kind ?? 'unknown',
    senderName: sender?.name ?? 'unknown',
    ...(sender?.id ? { senderId: sender.id } : {}),
    ...(senderMention ? { senderMention } : {})
  });
}

export function managedExternalAgentDirectNotice({
  member: _member,
  fromAgentName,
  text
}: {
  member: ManagedExternalAgentProjectMember;
  fromAgentName: string;
  text: string;
}): string {
  return DIRECT_NOTICE_PROMPT.render({ fromAgentName, text });
}

export function managedExternalAgentResumeRecoveryNotice(provider: string, notice: string): string {
  void provider;
  return RESUME_RECOVERY_NOTICE_PROMPT.render({ notice });
}
