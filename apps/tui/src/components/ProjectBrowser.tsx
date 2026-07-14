import type { ProjectId, SessionId, WorkplaceProjectMemberTemplate } from '@monad/protocol';

import {
  acpAgentSelectors,
  externalAgentSelectors,
  projectSessionSelectors,
  useCreateProjectSessionMutation,
  useCreateWorkplaceProjectMutation,
  useDeleteSessionMutation,
  useDeleteWorkplaceProjectMutation,
  useListAcpAgentsQuery,
  useListExternalAgentsQuery,
  useListProjectSessionsQuery,
  useListWorkplaceProjectsQuery,
  useUpdateSessionMutation,
  useUpdateWorkplaceProjectMutation,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { openUrl } from '@monad/home';
import { skipToken } from '@reduxjs/toolkit/query';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { safeErrorMessage } from '../shell/view-model.ts';
import {
  addProjectMemberTemplate,
  confirmDestructive,
  projectCreateRequest,
  projectSessionCreateRequest,
  projectUpdateRequest,
  removeProjectMemberTemplate
} from '../shell/workspace-model.ts';
import { TUI_THEME } from './theme.ts';

type ProjectMode =
  | 'projects'
  | 'sessions'
  | 'new-project-name'
  | 'new-project-cwd'
  | 'rename-project'
  | 'edit-project-cwd'
  | 'new-session'
  | 'rename-session'
  | 'members'
  | 'add-member';

export function ProjectBrowser({
  active,
  baseUrl,
  onOpen
}: {
  active: boolean;
  baseUrl: string;
  onOpen: (id: SessionId, projectId: ProjectId) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const projectsQuery = useListWorkplaceProjectsQuery({ archived: showArchived, limit: 100 });
  const projects = projectsQuery.data ? workplaceProjectSelectors.selectAll(projectsQuery.data.projects) : [];
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const [mode, setMode] = useState<ProjectMode>('projects');
  const [cursor, setCursor] = useState(0);
  const sessionsQuery = useListProjectSessionsQuery(
    projectId ? { limit: 100, projectId } : skipToken,
    projectId ? undefined : { skip: true }
  );
  const sessions = sessionsQuery.data ? projectSessionSelectors.selectAll(sessionsQuery.data.sessions) : [];
  const acpAgentsQuery = useListAcpAgentsQuery();
  const acpAgents = acpAgentsQuery.data ? acpAgentSelectors.selectAll(acpAgentsQuery.data) : [];
  const externalAgentsQuery = useListExternalAgentsQuery();
  const externalAgents = externalAgentsQuery.data ? externalAgentSelectors.selectAll(externalAgentsQuery.data) : [];
  const memberCandidates = [
    { type: 'monad' as const, name: 'monad', label: 'Monad' },
    ...acpAgents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        type: 'acp' as const,
        name: agent.name,
        label: `ACP · ${agent.name}`,
        cwd: agent.cwd,
        osSandbox: agent.osSandbox,
        forwardMcp: agent.forwardMcp
      })),
    ...externalAgents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        type: 'external-agent' as const,
        name: agent.name,
        label: `External · ${agent.name}`,
        defaultLaunchMode: agent.defaultLaunchMode,
        provider: agent.provider,
        productIcon: agent.productIcon
      }))
  ];
  const rowCount =
    mode === 'projects'
      ? projects.length
      : mode === 'members'
        ? (currentProject?.memberTemplates.length ?? 0)
        : mode === 'add-member'
          ? memberCandidates.length
          : sessions.length;
  const [createProject] = useCreateWorkplaceProjectMutation();
  const [updateProject] = useUpdateWorkplaceProjectMutation();
  const [deleteProject] = useDeleteWorkplaceProjectMutation();
  const [createSession] = useCreateProjectSessionMutation();
  const [updateSession] = useUpdateSessionMutation();
  const [deleteSession] = useDeleteSessionMutation();
  const [draft, setDraft] = useState('');
  const [pendingProjectName, setPendingProjectName] = useState('');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => setCursor((value) => Math.min(value, Math.max(0, rowCount - 1))), [rowCount]);

  const fail = (cause: unknown) => setStatus(safeErrorMessage(cause));

  const submitForm = async () => {
    try {
      if (mode === 'new-project-name') {
        const name = draft.trim();
        if (!name) return;
        setPendingProjectName(name);
        setDraft('');
        setMode('new-project-cwd');
        return;
      }
      if (mode === 'new-project-cwd') {
        const request = projectCreateRequest(pendingProjectName, draft);
        if (!request) return;
        const id = await createProject(request).unwrap();
        setProjectId(id);
        setMode('sessions');
        setDraft('');
        setStatus('Project created.');
        return;
      }
      if (!currentProject) return;
      if (mode === 'rename-project' || mode === 'edit-project-cwd') {
        const request = projectUpdateRequest(mode === 'rename-project' ? 'title' : 'cwd', draft);
        if (!request) return;
        await updateProject({ id: currentProject.id, ...request }).unwrap();
        setMode('sessions');
        setStatus(mode === 'rename-project' ? 'Project renamed.' : 'Project working directory updated.');
        return;
      }
      if (mode === 'new-session') {
        const request = projectSessionCreateRequest(draft);
        if (!request) return;
        const id = await createSession({ projectId: currentProject.id, ...request }).unwrap();
        setMode('sessions');
        setDraft('');
        setStatus('Project session created.');
        onOpen(id, currentProject.id);
        return;
      }
      if (mode === 'rename-session') {
        const session = sessions[cursor];
        const title = draft.trim();
        if (!session || !title) return;
        await updateSession({ id: session.id, title }).unwrap();
        setMode('sessions');
        setStatus('Project session renamed.');
      }
    } catch (cause) {
      fail(cause);
    }
  };

  const removeProject = async () => {
    const project = mode === 'projects' ? projects[cursor] : currentProject;
    if (!project) return;
    const confirmation = confirmDestructive(armedDelete, project.id);
    setArmedDelete(confirmation.armedId);
    if (!confirmation.confirmed) {
      setStatus(`Press x again to delete Project “${project.title}”.`);
      return;
    }
    try {
      await deleteProject(project.id).unwrap();
      setProjectId(null);
      setMode('projects');
      setCursor(0);
      setStatus('Project deleted.');
    } catch (cause) {
      fail(cause);
    }
  };

  const removeSession = async () => {
    const session = sessions[cursor];
    if (!session) return;
    const confirmation = confirmDestructive(armedDelete, session.id);
    setArmedDelete(confirmation.armedId);
    if (!confirmation.confirmed) {
      setStatus(`Press x again to delete session “${session.title}”.`);
      return;
    }
    try {
      await deleteSession(session.id).unwrap();
      setStatus('Project session deleted.');
    } catch (cause) {
      fail(cause);
    }
  };

  const updateMembers = async (members: WorkplaceProjectMemberTemplate[]) => {
    if (!currentProject) return;
    await updateProject({ id: currentProject.id, memberTemplates: members }).unwrap();
  };

  const addMember = async () => {
    if (!currentProject) return;
    const candidate = memberCandidates[cursor];
    if (!candidate) return;
    const result = addProjectMemberTemplate(currentProject.memberTemplates, candidate);
    if (!result.added) {
      setStatus(`${candidate.label} is already a Project member.`);
      setMode('members');
      return;
    }
    try {
      await updateMembers(result.members);
      setStatus(`${candidate.label} added.`);
      setMode('members');
      setCursor(Math.max(0, result.members.length - 1));
    } catch (cause) {
      fail(cause);
    }
  };

  const removeMember = async () => {
    if (!currentProject) return;
    const member = currentProject.memberTemplates[cursor];
    if (!member) return;
    const confirmation = confirmDestructive(armedDelete, member.id);
    setArmedDelete(confirmation.armedId);
    if (!confirmation.confirmed) {
      setStatus(`Press x again to remove “${member.displayName ?? member.name}”.`);
      return;
    }
    try {
      await updateMembers(removeProjectMemberTemplate(currentProject.memberTemplates, member.id));
      setStatus('Project member removed.');
    } catch (cause) {
      fail(cause);
    }
  };

  const openProjectSettings = () => {
    if (!currentProject) return;
    const url = `${baseUrl.replace(/\/$/, '')}/workspace/${currentProject.id}/settings`;
    setStatus(openUrl(url) ? 'Opened advanced Project settings in Web.' : `Unable to open browser. Copy: ${url}`);
  };

  const isForm = [
    'new-project-name',
    'new-project-cwd',
    'rename-project',
    'edit-project-cwd',
    'new-session',
    'rename-session'
  ].includes(mode);

  useInput(
    (input, key) => {
      if (isForm) {
        if (key.escape) {
          setMode(projectId ? 'sessions' : 'projects');
          setDraft('');
        } else if (key.return) void submitForm();
        else if (key.backspace) setDraft((value) => value.slice(0, -1));
        else if (!key.ctrl && !key.meta && input) setDraft((value) => value + input);
        return;
      }
      if (mode === 'members' || mode === 'add-member') {
        if (key.escape) {
          setMode(mode === 'add-member' ? 'members' : 'sessions');
          setCursor(0);
          setArmedDelete(null);
        } else if (key.upArrow || input === 'k') {
          setArmedDelete(null);
          setCursor((value) => Math.max(0, value - 1));
        } else if (key.downArrow || input === 'j') {
          setArmedDelete(null);
          setCursor((value) => Math.min(Math.max(0, rowCount - 1), value + 1));
        } else if (mode === 'add-member' && key.return) {
          void addMember();
        } else if (mode === 'members' && input === 'a') {
          setMode('add-member');
          setCursor(0);
        } else if (mode === 'members' && input === 'x') {
          void removeMember();
        } else if (mode === 'members' && input === 'o') {
          openProjectSettings();
        }
        return;
      }
      if (key.escape && mode === 'sessions') {
        setProjectId(null);
        setMode('projects');
        setCursor(0);
        setArmedDelete(null);
      } else if (key.upArrow || input === 'k') {
        setArmedDelete(null);
        setCursor((value) => Math.max(0, value - 1));
      } else if (key.downArrow || input === 'j') {
        setArmedDelete(null);
        setCursor((value) => Math.min(Math.max(0, rowCount - 1), value + 1));
      } else if (key.return) {
        if (mode === 'sessions' && currentProject) {
          const session = sessions[cursor];
          if (session) onOpen(session.id, currentProject.id);
        } else {
          const project = projects[cursor];
          if (project) {
            setProjectId(project.id);
            setMode('sessions');
            setCursor(0);
          }
        }
      } else if (input === 'n') {
        setDraft('');
        setMode(mode === 'projects' ? 'new-project-name' : 'new-session');
      } else if (input === 'e') {
        if (mode === 'projects') {
          const project = projects[cursor];
          if (project) {
            setDraft(project.title);
            setProjectId(project.id);
            setMode('rename-project');
          }
        } else {
          const session = sessions[cursor];
          if (session) {
            setDraft(session.title);
            setMode('rename-session');
          }
        }
      } else if (input === 'c' && currentProject) {
        setDraft(currentProject.cwd ?? '');
        setMode('edit-project-cwd');
      } else if (input === 'a' && currentProject) {
        const request = projectUpdateRequest('archived', !currentProject.archived);
        if (request)
          void updateProject({ id: currentProject.id, ...request })
            .unwrap()
            .then(() => {
              setProjectId(null);
              setMode('projects');
              setStatus(currentProject.archived ? 'Project restored.' : 'Project archived.');
            })
            .catch(fail);
      } else if (input === 'm' && currentProject) {
        setCursor(0);
        setMode('members');
      } else if (input === 'x') {
        if (mode === 'projects') void removeProject();
        else void removeSession();
      } else if (input === 'r') {
        if (mode === 'sessions') sessionsQuery.refetch();
        else projectsQuery.refetch();
      } else if (input === 'v' && mode === 'projects') {
        setShowArchived((value) => !value);
        setCursor(0);
      }
    },
    { isActive: active }
  );

  const formTitle: Partial<Record<ProjectMode, string>> = {
    'edit-project-cwd': 'Project working directory (empty clears)',
    'new-project-cwd': 'Project working directory (optional)',
    'new-project-name': 'Project name',
    'new-session': 'Project session title',
    'rename-project': 'Rename Project',
    'rename-session': 'Rename Project session'
  };

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
        {mode === 'projects'
          ? showArchived
            ? 'Projects · Archived'
            : 'Projects'
          : `Project · ${currentProject?.title ?? projectId ?? 'missing'}`}
      </Text>
      {isForm ? (
        <>
          <Text>{formTitle[mode]}</Text>
          <Text color={TUI_THEME.accent}>{draft}█</Text>
          <Text color={TUI_THEME.dim}>Enter continue/save · Esc cancel</Text>
        </>
      ) : mode === 'members' ? (
        <ProjectMembers
          active={active}
          armedDelete={armedDelete}
          cursor={cursor}
          members={currentProject?.memberTemplates ?? []}
        />
      ) : mode === 'add-member' ? (
        <ProjectMemberCandidates
          active={active}
          candidates={memberCandidates}
          cursor={cursor}
          loading={acpAgentsQuery.isLoading || externalAgentsQuery.isLoading}
        />
      ) : (
        <>
          {(mode === 'projects' ? projectsQuery.isLoading : sessionsQuery.isLoading) ? (
            <Text color={TUI_THEME.dim}>Loading…</Text>
          ) : null}
          {(mode === 'projects' ? projects : sessions).map((row, index) => (
            <Text
              color={active && cursor === index ? TUI_THEME.accent : undefined}
              key={row.id}
            >
              {active && cursor === index ? '› ' : '  '}
              {row.title}{' '}
              <Text color={TUI_THEME.dim}>
                {row.state}
                {'cwd' in row && row.cwd ? ` · ${row.cwd}` : ''}
              </Text>
            </Text>
          ))}
          {(mode === 'projects' ? projects : sessions).length === 0 ? (
            <Text color={TUI_THEME.dim}>
              {mode === 'projects' ? 'No projects. Press n to create one.' : 'No sessions.'}
            </Text>
          ) : null}
          <Text color={TUI_THEME.dim}>
            {mode === 'projects'
              ? '↑↓ move · Enter sessions · n new · e rename · x delete · v active/archive · r refresh'
              : '↑↓ move · Enter open · n new · e rename · x delete · c cwd · a archive · m members · Esc projects'}
          </Text>
        </>
      )}
      {status ? <Text color={armedDelete ? TUI_THEME.warning : TUI_THEME.dim}>{status}</Text> : null}
      <Text color={TUI_THEME.warning}>Text chat only; Experience extensions remain Web-only.</Text>
    </Box>
  );
}

function ProjectMembers({
  active,
  armedDelete,
  cursor,
  members
}: {
  active: boolean;
  armedDelete: string | null;
  cursor: number;
  members: readonly WorkplaceProjectMemberTemplate[];
}) {
  return (
    <>
      <Text color={TUI_THEME.dim}>Agent templates inherited by this Project's conversations.</Text>
      {members.map((member, index) => (
        <Text
          color={active && cursor === index ? TUI_THEME.accent : undefined}
          key={member.id}
        >
          {active && cursor === index ? '› ' : '  '}
          {member.displayName ?? member.name}{' '}
          <Text color={TUI_THEME.dim}>
            {member.type}
            {member.settings?.cwd ? ` · ${member.settings.cwd}` : ''}
          </Text>
          {armedDelete === member.id ? <Text color={TUI_THEME.warning}> · press x again</Text> : null}
        </Text>
      ))}
      {members.length === 0 ? <Text color={TUI_THEME.dim}>No members. Press a to add one.</Text> : null}
      <Text color={TUI_THEME.dim}>↑↓ move · a add · x remove · o advanced Web settings · Esc sessions</Text>
    </>
  );
}

function ProjectMemberCandidates({
  active,
  candidates,
  cursor,
  loading
}: {
  active: boolean;
  candidates: ReadonlyArray<{ label: string; name: string; type: string }>;
  cursor: number;
  loading: boolean;
}) {
  return (
    <>
      <Text bold>Add Project member</Text>
      {loading ? <Text color={TUI_THEME.dim}>Loading configured agents…</Text> : null}
      {candidates.map((candidate, index) => (
        <Text
          color={active && cursor === index ? TUI_THEME.accent : undefined}
          key={`${candidate.type}:${candidate.name}`}
        >
          {active && cursor === index ? '› ' : '  '}
          {candidate.label}
        </Text>
      ))}
      <Text color={TUI_THEME.dim}>↑↓ move · Enter add · Esc members</Text>
    </>
  );
}
