import type { ResearchMemberSummary } from '../client-logic.ts';
import type { SourceRef, SourceVisibility } from '../domain/index.ts';

import { toggledVisibilityRule, visibleSourceIds } from '../client-logic.ts';

export function VisibilityMatrix({
  members,
  onClose,
  onSetRule,
  pendingMemberIds,
  scope,
  sources,
  visibility
}: {
  members: readonly ResearchMemberSummary[];
  onClose(): void;
  onSetRule(memberId: string, sourceIds: string[] | null): Promise<void>;
  pendingMemberIds: ReadonlySet<string>;
  scope: string;
  sources: readonly SourceRef[];
  visibility: SourceVisibility;
}) {
  const researchMembers = members.filter((member) => member.role !== 'other');
  const allowedIds = (memberId: string): string[] => visibleSourceIds(visibility, memberId, sources);

  return (
    <aside
      aria-label="Member source visibility"
      className="mesh-drawer visibility-panel"
    >
      <header className="mesh-drawer-header">
        <div>
          <h2>Who reads what</h2>
          <p>{scope}</p>
        </div>
        <button
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </header>
      {sources.length && researchMembers.length ? (
        <div className="visibility-table-wrap">
          <table className="visibility-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                {researchMembers.map((member) => {
                  const allVisible = allowedIds(member.memberId).length === sources.length;
                  return (
                    <th
                      key={member.memberId}
                      scope="col"
                    >
                      <span>{member.displayName}</span>
                      <small>{member.role.replace('-', ' ')}</small>
                      <label className="visibility-all">
                        <input
                          checked={allVisible}
                          disabled={pendingMemberIds.has(member.memberId)}
                          onChange={(event) => void onSetRule(member.memberId, event.currentTarget.checked ? null : [])}
                          type="checkbox"
                        />
                        All sources
                      </label>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <th scope="row">
                    <span>{source.title}</span>
                    <small>{source.type}</small>
                  </th>
                  {researchMembers.map((member) => {
                    const current = allowedIds(member.memberId);
                    const checked = current.includes(source.id);
                    return (
                      <td key={member.memberId}>
                        <label>
                          <span className="sr-only">
                            {member.displayName} can read {source.title}
                          </span>
                          <input
                            checked={checked}
                            disabled={pendingMemberIds.has(member.memberId)}
                            onChange={(event) => {
                              void onSetRule(
                                member.memberId,
                                toggledVisibilityRule(
                                  visibility,
                                  member.memberId,
                                  sources,
                                  source.id,
                                  event.currentTarget.checked
                                )
                              );
                            }}
                            type="checkbox"
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mesh-empty-state">
          <h3>The matrix needs members and sources</h3>
          <p>Add a Researcher or Evidence Engineer and at least one source before setting reading access.</p>
        </div>
      )}
    </aside>
  );
}
