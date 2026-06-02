import type { ProjectMemberTemplateView } from '@monad/sdk-atom';
import type { DragEvent } from 'react';
import type { KanbanClientTask, KanbanDragPayload } from './client-logic';

import { MemberIdentity } from '@monad/ui/components/MemberIdentity';
import { isProductIconId, ProductIcon } from '@monad/ui/components/ProductIcon';

import { MEMBER_DRAG_MIME } from './client-logic';

export function MemberPalette({
  templates,
  tasks
}: {
  templates: ProjectMemberTemplateView[];
  tasks: KanbanClientTask[];
}) {
  return (
    <aside className="member-panel nodrag nowheel">
      <h2>Members</h2>
      <p>Drag a template onto a session card</p>
      <div className="member-list">
        {templates.length ? (
          templates.map((template) => {
            const assigned = tasks.filter((task) =>
              [task.host, ...task.members].some((member) => member?.member.profileId === template.id)
            ).length;
            const label = template.displayName ?? template.name;
            const productIcon = template.presentation?.icon ?? template.presentation?.provider;
            return (
              <button
                className="member-template"
                data-template-id={template.id}
                draggable
                key={template.id}
                onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                  const payload: KanbanDragPayload = { kind: 'member-template', templateId: template.id };
                  event.dataTransfer.setData(MEMBER_DRAG_MIME, JSON.stringify(payload));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                type="button"
              >
                <MemberIdentity
                  agent={{
                    avatarUrl: template.presentation?.avatarUrl,
                    name: label
                  }}
                  badge={
                    isProductIconId(productIcon) ? (
                      <ProductIcon
                        background="none"
                        product={productIcon}
                        size={14}
                      />
                    ) : undefined
                  }
                  className="member-identity"
                  nameStyle={{ fontWeight: 650 }}
                />
                {assigned ? <span className="assigned-count">{assigned}</span> : null}
              </button>
            );
          })
        ) : (
          <p className="empty">No member templates</p>
        )}
      </div>
    </aside>
  );
}
