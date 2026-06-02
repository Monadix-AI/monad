import type { KanbanClientTask } from './client-logic.ts';

import { useMemo } from 'react';

import { STAGES } from './client-logic.ts';

export interface TaskPanel {
  messages?: Array<{ id: string; role: string; text: string; createdAt: string }>;
  observations?: Array<{ id: string; kind: string; text: string; createdAt: string }>;
  approvals?: Array<{ id: string; summary: string }>;
  nextCursor?: string | null;
}

type ChatItem =
  | { id: string; type: 'message'; role: string; text: string; createdAt: string }
  | { id: string; type: 'observation'; kind: string; text: string; createdAt: string };

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function initial(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? 'A';
}

function ChatTimeline({ items, agentName }: { items: ChatItem[]; agentName: string }) {
  if (!items.length) {
    return (
      <div className="chat-empty">
        <span className="chat-empty-mark">{initial(agentName)}</span>
        <strong>No messages yet</strong>
        <span>Continue the session below.</span>
      </div>
    );
  }

  return (
    <div className="chat-timeline">
      {items.map((item) => {
        if (item.type === 'observation') {
          return (
            <article
              className="system-event"
              key={`observation:${item.id}`}
            >
              <span className="system-event-kind">{item.kind}</span>
              <span className="system-event-text">{item.text}</span>
              <time dateTime={item.createdAt}>{messageTime(item.createdAt)}</time>
            </article>
          );
        }

        const human = item.role === 'user' || item.role === 'human';
        const author = human ? 'You' : agentName;
        const avatar = (
          <span
            aria-hidden="true"
            className="chat-avatar"
            data-author={human ? 'human' : 'agent'}
          >
            {initial(author)}
          </span>
        );
        const content = (
          <div className="chat-message-stack">
            <div className="chat-message-header">
              <strong>{author}</strong>
              <time dateTime={item.createdAt}>{messageTime(item.createdAt)}</time>
            </div>
            <div className="chat-message-bubble">{item.text}</div>
          </div>
        );

        return (
          <article
            className="chat-message"
            data-author={human ? 'human' : 'agent'}
            key={`message:${item.id}`}
          >
            {human ? content : avatar}
            {human ? avatar : content}
          </article>
        );
      })}
      <div
        className="chat-end"
        key={`end:${items.at(-1)?.id ?? 'empty'}`}
        ref={(node) => node?.scrollIntoView({ block: 'end' })}
      />
    </div>
  );
}

export function Inspector({
  panel,
  task,
  onClose,
  onControl,
  onOpenSession,
  onSend
}: {
  panel: TaskPanel;
  task: KanbanClientTask;
  onClose(): void;
  onControl(action: 'pause' | 'cancel' | 'resolve-approval', details?: Record<string, string>): void;
  onOpenSession(): void;
  onSend(text: string): void;
}) {
  const items = useMemo<ChatItem[]>(
    () =>
      [
        ...(panel.messages ?? []).map((item) => ({ ...item, type: 'message' as const })),
        ...(panel.observations ?? []).map((item) => ({ ...item, type: 'observation' as const }))
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [panel.messages, panel.observations]
  );
  const agentName = task.host?.member.displayName ?? 'Agent';

  return (
    <aside
      aria-label="Task details"
      className="inspector"
    >
      <header className="inspector-header">
        <div className="inspector-title">
          <span className="stage-pill">{STAGES.find((stage) => stage.id === task.stage)?.title}</span>
          <h2>{task.title}</h2>
        </div>
        <div className="inspector-header-actions">
          <button
            className="open-session-button"
            onClick={onOpenSession}
            type="button"
          >
            Open session
          </button>
          <button
            aria-label="Close task details"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </div>
      </header>
      <div className="session-controls">
        <span>
          Chatting with <strong>{agentName}</strong>
        </span>
        <div className="row">
          <button
            onClick={() => onControl('pause')}
            type="button"
          >
            Pause
          </button>
          <button
            onClick={() => onControl('cancel')}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
      <div className="chat-scroll">
        {(panel.approvals ?? []).map((approval) => (
          <article
            className="approval"
            key={approval.id}
          >
            <div>
              <strong>Approval required</strong>
              <span>{approval.summary}</span>
            </div>
            <div className="row">
              <button
                className="primary"
                onClick={() => onControl('resolve-approval', { approvalId: approval.id, decision: 'approved' })}
                type="button"
              >
                Approve
              </button>
              <button
                onClick={() => onControl('resolve-approval', { approvalId: approval.id, decision: 'denied' })}
                type="button"
              >
                Deny
              </button>
            </div>
          </article>
        ))}
        <ChatTimeline
          agentName={agentName}
          items={items}
        />
      </div>
      <div className="composer-dock">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = String(form.get('message') ?? '').trim();
            if (!text) return;
            onSend(text);
            event.currentTarget.reset();
          }}
        >
          <textarea
            aria-label="Message"
            name="message"
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="Continue this session…"
            required
          />
          <div className="composer-toolbar">
            <span>Shift + Enter for a new line</span>
            <button
              aria-label="Send message"
              className="composer-send"
              type="submit"
            >
              <svg
                aria-hidden="true"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path d="M12 19V5m0 0-5 5m5-5 5 5" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
