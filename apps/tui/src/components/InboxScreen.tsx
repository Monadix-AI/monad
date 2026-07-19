import type { ApprovalInboxItem, InboxItem, ProjectId, SessionId } from '@monad/protocol';

import { useApproveMeshSessionMutation, useApproveToolMutation, useListMentionInboxQuery } from '@monad/client-rtk';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { safeErrorMessage } from '../shell/view-model.ts';
import { inboxOpenTarget } from '../shell/workspace-model.ts';
import { TUI_THEME } from './theme.ts';

type PendingResolution = {
  allow: boolean;
  editingReason: boolean;
  item: ApprovalInboxItem;
  reason: string;
};

export function InboxScreen({
  active,
  approvalsOnly = false,
  onOpen
}: {
  active: boolean;
  approvalsOnly?: boolean;
  onOpen: (id: SessionId, projectId: ProjectId | null) => void;
}) {
  const query = useListMentionInboxQuery({ limit: 100 });
  const items = (query.data?.items ?? []).filter((item) => !approvalsOnly || item.kind === 'approval');
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState<PendingResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveTool] = useApproveToolMutation();
  const [approveMeshAgent] = useApproveMeshSessionMutation();
  useEffect(() => setCursor((value) => Math.min(value, Math.max(0, items.length - 1))), [items.length]);

  const resolve = async (resolution: PendingResolution) => {
    setError(null);
    const { allow, item } = resolution;
    try {
      if (item.approvalKind === 'mesh-agent' && item.meshSessionId) {
        await approveMeshAgent({
          allow,
          id: item.meshSessionId,
          requestId: item.id,
          transcriptTargetId: item.sessionId,
          ...(allow || !resolution.reason.trim() ? {} : { reason: resolution.reason.trim() })
        }).unwrap();
      } else {
        const result = await approveTool({
          allow,
          requestId: item.id,
          scope: 'once',
          ...(allow || !resolution.reason.trim() ? {} : { reason: resolution.reason.trim() })
        }).unwrap();
        if (!result.ok) throw new Error('The approval is no longer pending.');
      }
      setPending(null);
      await query.refetch();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    }
  };

  useInput(
    (input, key) => {
      if (pending) {
        if (pending.editingReason) {
          if (key.escape || key.return) setPending({ ...pending, editingReason: false });
          else if (key.backspace) setPending({ ...pending, reason: pending.reason.slice(0, -1) });
          else if (!key.ctrl && !key.meta && input) setPending({ ...pending, reason: pending.reason + input });
        } else if (key.escape) setPending(null);
        else if (!pending.allow && input === 'e') setPending({ ...pending, editingReason: true });
        else if (key.return) void resolve(pending);
        return;
      }
      if (key.upArrow || input === 'k') setCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow || input === 'j') setCursor((value) => Math.min(items.length - 1, value + 1));
      else if (key.return) {
        const item = items[cursor];
        if (item) {
          const target = inboxOpenTarget(item);
          onOpen(target.sessionId, target.projectId);
        }
      } else if ((input === 'a' || input === 'x') && items[cursor]?.kind === 'approval') {
        setPending({ allow: input === 'a', editingReason: false, item: items[cursor], reason: '' });
      } else if (input === 'r') query.refetch();
    },
    { isActive: active }
  );

  if (pending) return <ApprovalDetail resolution={pending} />;
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {approvalsOnly ? 'Approvals' : 'Inbox'}
      </Text>
      {error ? <Text color={TUI_THEME.danger}>{error}</Text> : null}
      {query.isLoading ? <Text color={TUI_THEME.dim}>Loading inbox…</Text> : null}
      {query.error ? <Text color={TUI_THEME.danger}>Unable to load inbox. Press r to retry.</Text> : null}
      {items.length === 0 && !query.isLoading ? <Text color={TUI_THEME.dim}>Nothing needs your attention.</Text> : null}
      {items.map((item, index) => (
        <InboxRow
          item={item}
          key={item.id}
          selected={active && cursor === index}
        />
      ))}
      <Text color={TUI_THEME.dim}>↑↓ move · Enter open · a approve detail · x reject detail · r refresh</Text>
    </Box>
  );
}

function InboxRow({ item, selected }: { item: InboxItem; selected: boolean }) {
  const context = item.projectName ?? item.sessionTitle ?? item.sessionId;
  const preview =
    item.kind === 'mention' ? item.message.text : (item.text ?? item.tool ?? item.provider ?? item.approvalKind);
  return (
    <Text color={selected ? TUI_THEME.accent : undefined}>
      {selected ? '› ' : '  '}[{item.kind}] {context} · {preview}
    </Text>
  );
}

function ApprovalDetail({ resolution }: { resolution: PendingResolution }) {
  const { item, allow } = resolution;
  return (
    <Box
      borderColor={allow ? TUI_THEME.glow : TUI_THEME.danger}
      borderStyle="double"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold>{allow ? 'Confirm approval' : 'Confirm rejection'}</Text>
      <Text>{item.text ?? item.tool ?? item.provider ?? item.approvalKind}</Text>
      {item.input !== undefined ? <Text color={TUI_THEME.dim}>{safeJson(item.input)}</Text> : null}
      {!allow ? (
        <Text color={resolution.editingReason ? TUI_THEME.accent : TUI_THEME.dim}>
          Reason (optional): {resolution.reason || '—'}
          {resolution.editingReason ? '█' : ''}
        </Text>
      ) : null}
      <Text color={TUI_THEME.warning}>Enter confirms this one-time decision · Esc cancels</Text>
      {!allow ? <Text color={TUI_THEME.dim}>e edit optional rejection reason</Text> : null}
    </Box>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
