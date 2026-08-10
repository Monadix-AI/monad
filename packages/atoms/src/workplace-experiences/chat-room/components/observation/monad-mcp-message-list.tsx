import type { MonadMcpMessage } from './monad-mcp-projection.ts';

import { entityAvatarUrl } from '@monad/protocol';
import { formatMessageTimestamp } from '@monad/ui';
import { AgentIdentity, Avatar, resolveProductIcon } from '@monad/ui/components/AgentAvatar';

import { avatarForAgent } from '../../../experience/project-projection.ts';
import { MonadMcpAttachmentList } from './monad-mcp-attachment-card.tsx';
import { MonadMcpLongText } from './monad-mcp-long-text.tsx';

export function MonadMcpMessageList({
  agentFallback,
  emptyLabel,
  locale,
  messages,
  userFallback
}: {
  agentFallback: string;
  emptyLabel: string;
  locale: string;
  messages: readonly MonadMcpMessage[];
  userFallback: string;
}) {
  if (messages.length === 0) return <span className="text-muted-foreground">{emptyLabel}</span>;
  return (
    <div
      className="divide-y divide-border/60"
      data-slot="monad-mcp-message-list"
    >
      {messages.map((message) => {
        const agent = message.role === 'assistant';
        const name = message.name ?? (message.role === 'user' ? userFallback : agentFallback);
        const icon = agent ? resolveProductIcon({ icon: message.agentName, name }) : undefined;
        const time = formatMessageTimestamp(message.createdAt, locale);
        return (
          <article
            className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 py-3 first:pt-0 last:pb-0"
            data-slot="monad-mcp-message"
            key={message.id}
          >
            <Avatar
              av={agent ? avatarForAgent(name) : name.slice(0, 2).toUpperCase()}
              avatarUrl={entityAvatarUrl(`${agent ? 'mesh-agent' : 'user'}:${name}`)}
              bordered={false}
              icon={icon}
              kind={agent ? 'agent' : 'human'}
              size={28}
            />
            <div className="min-w-0">
              <header
                className="flex min-w-0 items-center gap-2"
                data-slot="monad-mcp-message-header"
              >
                <AgentIdentity
                  className="min-w-0 font-medium text-foreground"
                  icon={icon}
                  name={name}
                />
                {time ? (
                  <time
                    className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                    dateTime={message.createdAt}
                    title={message.createdAt}
                  >
                    {time}
                  </time>
                ) : null}
              </header>
              {message.text.trim() ? (
                <MonadMcpLongText
                  className="mt-1"
                  dataSlot="monad-mcp-message-body"
                  disclosureKey={`message/${message.id}`}
                  text={message.text}
                />
              ) : null}
              <MonadMcpAttachmentList
                attachments={message.attachments}
                locale={locale}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}
