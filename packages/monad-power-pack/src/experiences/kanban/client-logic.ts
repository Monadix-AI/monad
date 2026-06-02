import type { SessionMemberBinding } from '@monad/protocol';
import type { Node } from '@xyflow/react';
import type { KanbanStage } from './domain.ts';

const STAGE_NODE_WIDTH = 300;
const STAGE_NODE_HEIGHT = 560;

export const STAGES: Array<{
  id: KanbanStage;
  title: string;
  description: string;
}> = [
  { id: 'product_design', title: 'Product Design', description: 'Shape the outcome' },
  { id: 'tech_design', title: 'Tech Design', description: 'Define delivery boundaries' },
  { id: 'implementation', title: 'Implementation', description: 'Build the approved design' },
  { id: 'verify', title: 'Verify', description: 'Validate the evidence' },
  { id: 'completed', title: 'Completed', description: 'Finished work' }
];

export interface KanbanClientTask {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  stage: KanbanStage;
  version: number;
  displayState: string;
  host: SessionMemberBinding | null;
  members: SessionMemberBinding[];
  documents: Record<'product_design' | 'tech_design', { name: string; path: string; updatedAt: string } | null>;
  availableActions: { start: boolean; moveNext: boolean };
}

export interface StageNodeData extends Record<string, unknown> {
  stage: (typeof STAGES)[number];
  tasks: KanbanClientTask[];
}

export type KanbanDragPayload =
  | { kind: 'member-template'; templateId: string }
  | { kind: 'task'; taskId: string; sourceStage: KanbanStage };

export const MEMBER_DRAG_MIME = 'application/x-monad-kanban-member';
export const TASK_DRAG_MIME = 'application/x-monad-kanban-task';

export const REACT_FLOW_OPTIONS = {
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  minZoom: 0.75,
  maxZoom: 1.25,
  panOnDrag: true,
  zoomOnDoubleClick: false
} as const;

// Keeps the first stage clear of the 240px member overlay at the initial zoom.
export const DEFAULT_VIEWPORT = { x: 69, y: 18, zoom: 0.75 } as const;

export function createStageNodes(tasks: KanbanClientTask[]): Array<Node<StageNodeData>> {
  return STAGES.map((stage, index) => ({
    id: stage.id,
    type: 'stage',
    position: { x: 260 + index * 324, y: 40 },
    draggable: false,
    selectable: false,
    width: STAGE_NODE_WIDTH,
    height: STAGE_NODE_HEIGHT,
    style: { width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT },
    data: { stage, tasks: tasks.filter((task) => task.stage === stage.id) }
  }));
}

export function canDropTask(sourceStage: string, destinationStage: string): boolean {
  const index = STAGES.findIndex((stage) => stage.id === sourceStage);
  return index >= 0 && STAGES[index + 1]?.id === destinationStage;
}

export function canStartTask(task: Pick<KanbanClientTask, 'host' | 'availableActions'>): boolean {
  return task.host !== null && task.availableActions.start;
}

export function kanbanDocumentRows(documents: KanbanClientTask['documents']): Array<{
  stage: 'product_design' | 'tech_design';
  label: string;
  document: KanbanClientTask['documents'][keyof KanbanClientTask['documents']];
}> {
  return [
    { stage: 'product_design', label: 'Product Design', document: documents.product_design },
    { stage: 'tech_design', label: 'Tech Design', document: documents.tech_design }
  ];
}

export function decodeDragPayload(value: string): KanbanDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind === 'member-template' && typeof parsed.templateId === 'string' && parsed.templateId.trim()) {
      return { kind: 'member-template', templateId: parsed.templateId };
    }
    if (
      parsed.kind === 'task' &&
      typeof parsed.taskId === 'string' &&
      parsed.taskId.trim() &&
      typeof parsed.sourceStage === 'string' &&
      STAGES.some((stage) => stage.id === parsed.sourceStage)
    ) {
      return { kind: 'task', taskId: parsed.taskId, sourceStage: parsed.sourceStage as KanbanStage };
    }
    return null;
  } catch {
    return null;
  }
}
