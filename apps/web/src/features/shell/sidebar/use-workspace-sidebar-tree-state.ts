import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type WorkspaceSectionId = 'pinned' | 'projects' | 'chats';

function createOpenSections(): Record<WorkspaceSectionId, boolean> {
  return {
    chats: false,
    pinned: false,
    projects: false
  };
}

function toggleSectionState(
  sections: Record<WorkspaceSectionId, boolean>,
  section: WorkspaceSectionId
): Record<WorkspaceSectionId, boolean> {
  return {
    ...sections,
    [section]: !sections[section]
  };
}

export function useWorkspaceSidebarTreeState({
  activeProjectId,
  projectIds
}: {
  activeProjectId: string | null;
  projectIds: string[];
}) {
  const [collapsedSections, setCollapsedSections] = useState(createOpenSections);
  const previousProjectIdsRef = useRef<Set<string>>(new Set(projectIds));
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set(projectIds));
  const allProjectsExpanded = useMemo(
    () => projectIds.length > 0 && projectIds.every((projectId) => expandedProjectIds.has(projectId)),
    [expandedProjectIds, projectIds]
  );

  const toggleAllProjectsExpanded = useCallback(() => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      const allExpanded = projectIds.length > 0 && projectIds.every((projectId) => next.has(projectId));
      if (allExpanded) {
        for (const projectId of projectIds) next.delete(projectId);
      } else {
        for (const projectId of projectIds) next.add(projectId);
      }
      return next;
    });
    setCollapsedSections((sections) => ({ ...sections, projects: false }));
  }, [projectIds]);

  const toggleSection = useCallback((section: WorkspaceSectionId) => {
    setCollapsedSections((sections) => toggleSectionState(sections, section));
  }, []);

  const expandProject = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => new Set(current).add(projectId));
  }, []);

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => new Set(current).add(activeProjectId));
  }, [activeProjectId]);

  useEffect(() => {
    const previousProjectIds = previousProjectIdsRef.current;
    const newProjectIds = projectIds.filter((projectId) => !previousProjectIds.has(projectId));
    previousProjectIdsRef.current = new Set(projectIds);
    if (newProjectIds.length === 0) return;
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      for (const projectId of newProjectIds) next.add(projectId);
      return next;
    });
  }, [projectIds]);

  return {
    allProjectsExpanded,
    collapsedSections,
    expandProject,
    expandedProjectIds,
    toggleAllProjectsExpanded,
    toggleProjectExpanded,
    toggleSection
  };
}
