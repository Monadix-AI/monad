import type { SessionMemberBinding } from '@monad/protocol';
import type { ProjectMemberTemplateView } from '@monad/sdk-atom';
import type { ProductIconId } from '@monad/ui/components/ProductIcon';
import type { Node, NodeProps } from '@xyflow/react';
import type { Root } from 'react-dom/client';

import { MemberIdentity } from '@monad/ui/components/MemberIdentity';
import { isProductIconId, ProductIcon } from '@monad/ui/components/ProductIcon';
import { Background, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import flowStyles from '@xyflow/react/dist/style.css' with { type: 'text' };
import { type DragEvent, type SyntheticEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  canDropTask,
  canStartTask,
  createStageNodes,
  DEFAULT_VIEWPORT,
  decodeDragPayload,
  type KanbanClientTask,
  type KanbanDragPayload,
  kanbanDocumentRows,
  MEMBER_DRAG_MIME,
  REACT_FLOW_OPTIONS,
  STAGES,
  type StageNodeData,
  TASK_DRAG_MIME
} from './client-logic.ts';
import { CLIENT_STYLES } from './client-styles.ts';
import { Inspector, type TaskPanel } from './inspector.tsx';
import { MemberPalette } from './member-palette.tsx';

export {
  canDropTask,
  canStartTask,
  createStageNodes,
  DEFAULT_VIEWPORT,
  decodeDragPayload,
  kanbanDocumentRows,
  MEMBER_DRAG_MIME,
  REACT_FLOW_OPTIONS,
  TASK_DRAG_MIME
} from './client-logic.ts';

const UPDATE_EVENT = 'monad-workplace-experience:update';

interface HostApi {
  apiBaseUrl: string;
  snapshot: { projectId?: string };
  actions?: { openProjectSession?: (sessionId: string) => void };
}

interface StageViewData extends StageNodeData {
  allTasks: KanbanClientTask[];
  pendingTaskIds: Set<string>;
  templates: ProjectMemberTemplateView[];
  onAddMember(task: KanbanClientTask, templateId: string, role: 'host' | 'member'): void;
  onCreate(): void;
  onMove(task: KanbanClientTask, destination: KanbanClientTask['stage']): void;
  onOpen(task: KanbanClientTask): void;
  onRemoveMember(task: KanbanClientTask, memberId: string): void;
  onStart(task: KanbanClientTask): void;
}

function dragPayload(event: DragEvent, mime: string): KanbanDragPayload | null {
  return decodeDragPayload(event.dataTransfer.getData(mime));
}

export function memberCardPresentation(
  member: SessionMemberBinding,
  templates: readonly ProjectMemberTemplateView[]
): { avatarUrl?: string; name: string; productIcon?: ProductIconId } {
  const template = templates.find((candidate) => candidate.id === member.member.profileId);
  const productIcon = template?.presentation?.icon ?? template?.presentation?.provider;
  return {
    ...(template?.presentation?.avatarUrl ? { avatarUrl: template.presentation.avatarUrl } : {}),
    name: member.member.displayName,
    ...(isProductIconId(productIcon) ? { productIcon } : {})
  };
}

function TaskCard({ task, data }: { task: KanbanClientTask; data: StageViewData }) {
  const pending = data.pendingTaskIds.has(task.id);
  const next = STAGES[STAGES.findIndex((stage) => stage.id === task.stage) + 1];
  const start = canStartTask(task) && !pending;
  const move = Boolean(task.availableActions.moveNext && next && !pending);
  const assigned = [task.host, ...task.members];
  const memberDrop = (role: 'host' | 'member') => (event: DragEvent<HTMLElement>) => {
    const payload = dragPayload(event, MEMBER_DRAG_MIME);
    if (payload?.kind !== 'member-template' || pending || (role === 'host' && task.host)) return;
    event.preventDefault();
    event.stopPropagation();
    if (assigned.some((member) => member?.member.profileId === payload.templateId)) return;
    data.onAddMember(task, payload.templateId, role);
  };
  const memberChip = (member: NonNullable<KanbanClientTask['host']>) => {
    const presentation = memberCardPresentation(member, data.templates);
    return (
      <span
        className="member-chip"
        key={member.member.id}
        title={presentation.name}
      >
        <MemberIdentity
          agent={{ avatarUrl: presentation.avatarUrl, name: presentation.name }}
          avatarSize={22}
          badge={
            presentation.productIcon ? (
              <ProductIcon
                background="none"
                product={presentation.productIcon}
                size={12}
              />
            ) : undefined
          }
          className="member-chip-identity"
          nameStyle={{ fontSize: 10, fontWeight: 650 }}
        />
        <button
          aria-label={`Remove ${presentation.name}`}
          className="member-remove nodrag"
          disabled={pending}
          draggable={false}
          onClick={() => data.onRemoveMember(task, member.member.id)}
          type="button"
        >
          ×
        </button>
      </span>
    );
  };
  return (
    <article
      aria-busy={pending}
      className="task-card nodrag nopan nowheel"
      data-pending={pending}
      data-task-id={task.id}
      draggable={move}
      onDragStart={(event) => {
        const payload: KanbanDragPayload = { kind: 'task', taskId: task.id, sourceStage: task.stage };
        event.dataTransfer.setData(TASK_DRAG_MIME, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button
        className="task-main"
        onClick={() => data.onOpen(task)}
        type="button"
      >
        <span className="task-title">{task.title}</span>
        <span className="task-state">
          <span
            className="status-dot"
            data-state={task.displayState}
          />
          {task.displayState.replaceAll('_', ' ')}
        </span>
      </button>
      <div className="member-slots">
        <fieldset
          className="member-slot"
          data-filled={Boolean(task.host)}
          onDragOver={(event) => {
            if (!pending && !task.host && event.dataTransfer.types.includes(MEMBER_DRAG_MIME)) event.preventDefault();
          }}
          onDrop={memberDrop('host')}
        >
          <legend className="member-slot-label">Host</legend>
          <div className="members">
            {task.host ? memberChip(task.host) : <span className="member-empty">Drop one host</span>}
          </div>
        </fieldset>
        <fieldset
          className="member-slot"
          data-filled={task.members.length > 0}
          onDragOver={(event) => {
            if (!pending && event.dataTransfer.types.includes(MEMBER_DRAG_MIME)) event.preventDefault();
          }}
          onDrop={memberDrop('member')}
        >
          <legend className="member-slot-label">Members</legend>
          <div className="members">
            {task.members.length ? task.members.map(memberChip) : <span className="member-empty">Drop members</span>}
          </div>
        </fieldset>
      </div>
      <section className="task-documents">
        <div className="task-documents-heading">
          <span>Stage documents</span>
          <small>Host maintained</small>
        </div>
        <div className="task-document-list">
          {kanbanDocumentRows(task.documents).map((row) => (
            <div
              className="task-document"
              data-published={Boolean(row.document)}
              key={row.stage}
            >
              <span className="task-document-stage">{row.label}</span>
              {row.document ? (
                <span
                  className="task-document-name"
                  title={row.document.path}
                >
                  {row.document.name}
                </span>
              ) : (
                <span className="task-document-missing">Not published</span>
              )}
            </div>
          ))}
        </div>
      </section>
      <div className="card-actions">
        <button
          className="primary"
          disabled={!start}
          onClick={() => data.onStart(task)}
          type="button"
        >
          Start
        </button>
        {next && task.availableActions.moveNext ? (
          <button
            disabled={!move}
            onClick={() => data.onMove(task, next.id)}
            type="button"
          >
            Move to {next.title}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function StageNode({ data }: NodeProps<Node<StageViewData>>) {
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const payload = dragPayload(event, TASK_DRAG_MIME);
    if (payload?.kind !== 'task' || !canDropTask(payload.sourceStage, data.stage.id)) return;
    const task = data.allTasks.find((candidate) => candidate.id === payload.taskId);
    if (!task?.availableActions.moveNext) return;
    event.preventDefault();
    data.onMove(task, data.stage.id);
  };
  return (
    <section
      aria-label={`${data.stage.title} tasks`}
      className="stage-node"
      data-stage={data.stage.id}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(TASK_DRAG_MIME)) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <header className="stage-header">
        <div>
          <h2 className="stage-title">{data.stage.title}</h2>
          <p className="stage-description">{data.stage.description}</p>
        </div>
        <div className="stage-actions">
          <span className="count">{data.tasks.length}</span>
          {data.stage.id === 'product_design' ? (
            <button
              className="new-button nodrag"
              onClick={data.onCreate}
              type="button"
            >
              New
            </button>
          ) : null}
        </div>
      </header>
      <div className="card-list nodrag nowheel">
        {data.tasks.length ? (
          data.tasks.map((task) => (
            <TaskCard
              data={data}
              key={task.id}
              task={task}
            />
          ))
        ) : (
          <p className="empty">No sessions in this stage</p>
        )}
      </div>
    </section>
  );
}

const NODE_TYPES = { stage: StageNode } as const;

function Canvas({ host }: { host: HostApi }) {
  const projectId = host.snapshot.projectId ?? '';
  const [tasks, setTasks] = useState<KanbanClientTask[]>([]);
  const [templates, setTemplates] = useState<ProjectMemberTemplateView[]>([]);
  const [pendingTaskIds, setPendingTaskIds] = useState(new Set<string>());
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<TaskPanel>({});
  const { fitView } = useReactFlow();

  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(`${host.apiBaseUrl}${path}`, init);
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.error ?? `${path} failed: ${response.status}`));
      return payload;
    },
    [host.apiBaseUrl]
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const query = new URLSearchParams({ projectId, limit: '100' });
      const [taskPayload, templatePayload] = await Promise.all([
        request(`/tasks?${query}`),
        request(`/member-templates?${new URLSearchParams({ projectId })}`)
      ]);
      setTasks((taskPayload.tasks as KanbanClientTask[]) ?? []);
      setTemplates((templatePayload.templates as ProjectMemberTemplateView[]) ?? []);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId, request]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!tasks.some((task) => task.displayState === 'running' || task.displayState === 'scheduled')) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [load, tasks]);

  const mutate = useCallback(
    async (path: string, body: Record<string, unknown>, taskId?: string) => {
      if (taskId) setPendingTaskIds((current) => new Set(current).add(taskId));
      try {
        await request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        await load();
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (taskId) {
          setPendingTaskIds((current) => {
            const next = new Set(current);
            next.delete(taskId);
            return next;
          });
        }
      }
    },
    [load, request]
  );

  const openTask = useCallback(
    async (task: KanbanClientTask) => {
      setSelectedId(task.id);
      try {
        const query = new URLSearchParams({ projectId: task.projectId, taskId: task.id });
        setPanel((await request(`/tasks/panel?${query}`)) as TaskPanel);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [request]
  );

  const nodes = useMemo(
    () =>
      createStageNodes(tasks).map((node) => ({
        ...node,
        data: {
          ...node.data,
          allTasks: tasks,
          pendingTaskIds,
          templates,
          onAddMember: (task: KanbanClientTask, templateId: string, role: 'host' | 'member') =>
            void mutate('/tasks/members', { projectId: task.projectId, taskId: task.id, templateId, role }, task.id),
          onCreate: () => setCreating(true),
          onMove: (task: KanbanClientTask, destination: KanbanClientTask['stage']) =>
            void mutate(
              '/tasks/move',
              { projectId: task.projectId, taskId: task.id, expectedVersion: task.version, destination },
              task.id
            ),
          onOpen: (task: KanbanClientTask) => void openTask(task),
          onRemoveMember: (task: KanbanClientTask, memberId: string) =>
            void mutate('/tasks/members/remove', { projectId: task.projectId, taskId: task.id, memberId }, task.id),
          onStart: (task: KanbanClientTask) =>
            void mutate(
              '/tasks/start',
              { projectId: task.projectId, taskId: task.id, expectedVersion: task.version },
              task.id
            )
        } satisfies StageViewData
      })),
    [mutate, openTask, pendingTaskIds, tasks, templates]
  );
  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  return (
    <div className="kanban-app">
      {error ? (
        <div
          className="error-banner"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <MemberPalette
        tasks={tasks}
        templates={templates}
      />
      <div className="flow-surface">
        <ReactFlow
          {...REACT_FLOW_OPTIONS}
          defaultViewport={DEFAULT_VIEWPORT}
          edges={[]}
          nodes={nodes}
          nodeTypes={NODE_TYPES}
          onPaneClick={(event) => {
            if (event.detail === 2) void fitView({ padding: 0.04, duration: 180 });
          }}
        >
          <Background
            color="var(--border, #deded8)"
            gap={24}
            size={1}
          />
        </ReactFlow>
      </div>
      {creating ? (
        <div className="dialog-backdrop">
          <form
            className="dialog"
            onSubmit={(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
              if (!title) return;
              setCreating(false);
              void mutate('/tasks/create', {
                projectId,
                title,
                idempotencyKey: globalThis.crypto?.randomUUID?.() ?? String(Date.now())
              });
            }}
          >
            <h2>New Product Design session</h2>
            <input
              aria-label="Session title"
              name="title"
              required
            />
            <div className="dialog-actions">
              <button
                onClick={() => setCreating(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary"
                type="submit"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {selected ? (
        <Inspector
          onClose={() => setSelectedId(null)}
          onControl={(action, details = {}) =>
            void mutate(
              '/execution/control',
              { action, projectId: selected.projectId, taskId: selected.id, ...details },
              selected.id
            )
          }
          onOpenSession={() => host.actions?.openProjectSession?.(selected.sessionId)}
          onSend={(text) =>
            void mutate(
              '/messages/send',
              {
                projectId: selected.projectId,
                taskId: selected.id,
                text,
                idempotencyKey: globalThis.crypto?.randomUUID?.() ?? String(Date.now())
              },
              selected.id
            )
          }
          panel={panel}
          task={selected}
        />
      ) : null}
    </div>
  );
}

function KanbanApp({ host }: { host: HostApi }) {
  return (
    <ReactFlowProvider>
      <Canvas host={host} />
    </ReactFlowProvider>
  );
}

const HTMLElementBase: typeof HTMLElement = globalThis.HTMLElement ?? (class {} as typeof HTMLElement);

class MonadKanban extends HTMLElementBase {
  monadWorkplaceExperience?: HostApi;
  #reactRoot: Root | null = null;
  #mount: HTMLDivElement | null = null;
  #listener = (event: Event) => {
    this.monadWorkplaceExperience = (event as CustomEvent<HostApi>).detail;
    this.#render();
  };

  connectedCallback() {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    if (!this.#mount) {
      const style = document.createElement('style');
      style.textContent = `${flowStyles}\n${CLIENT_STYLES}`;
      const mount = document.createElement('div');
      mount.style.height = '100%';
      this.#mount = mount;
      shadow.append(style, mount);
      this.#reactRoot = createRoot(mount);
    }
    this.addEventListener(UPDATE_EVENT, this.#listener);
    this.#render();
  }

  disconnectedCallback() {
    this.removeEventListener(UPDATE_EVENT, this.#listener);
  }

  #render() {
    if (!this.#reactRoot || !this.monadWorkplaceExperience) return;
    this.dataset.projectId = this.monadWorkplaceExperience.snapshot.projectId ?? '';
    this.dataset.ready = 'true';
    this.#reactRoot.render(<KanbanApp host={this.monadWorkplaceExperience} />);
  }
}

if (globalThis.customElements && !globalThis.customElements.get('monad-kanban')) {
  globalThis.customElements.define('monad-kanban', MonadKanban as CustomElementConstructor);
}
