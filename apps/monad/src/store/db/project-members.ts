import type {
  ProjectMember,
  ProjectMemberLaunchOverrides,
  ProjectMemberLifecycle,
  WorkplaceProjectMemberType
} from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { projectMemberLaunchOverridesSchema, projectMemberSchema } from '@monad/protocol';
import { and, asc, eq } from 'drizzle-orm';

import { projectMembers } from './schema.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;
type ProjectMemberRow = typeof projectMembers.$inferSelect;

export interface ProjectMemberPatch {
  type?: WorkplaceProjectMemberType;
  displayName?: string;
  customPrompt?: string | null;
  launchOverrides?: ProjectMemberLaunchOverrides;
  workingDirectoryOverride?: string | null;
  lifecycle?: ProjectMemberLifecycle;
  updatedAt: string;
}

function rowToProjectMember(row: ProjectMemberRow): ProjectMember {
  return projectMemberSchema.parse({
    id: row.id,
    projectId: row.projectId,
    profileId: row.profileId,
    type: row.type,
    displayName: row.displayName,
    customPrompt: row.customPrompt,
    launchOverrides: projectMemberLaunchOverridesSchema.parse(JSON.parse(row.launchOverrides)),
    workingDirectoryOverride: row.workingDirectoryOverride,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

export function insertProjectMember(db: Db, input: ProjectMember): void {
  const member = projectMemberSchema.parse(input);
  db.insert(projectMembers)
    .values({
      projectId: member.projectId,
      id: member.id,
      profileId: member.profileId,
      type: member.type,
      displayName: member.displayName,
      customPrompt: member.customPrompt,
      launchOverrides: JSON.stringify(member.launchOverrides),
      workingDirectoryOverride: member.workingDirectoryOverride,
      lifecycle: member.lifecycle,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt
    })
    .run();
}

export function getProjectMember(db: Db, projectId: string, memberId: string): ProjectMember | null {
  const row = db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.id, memberId)))
    .get();
  return row ? rowToProjectMember(row) : null;
}

export function listProjectMembers(db: Db, projectId: string): ProjectMember[] {
  return db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.id))
    .all()
    .map(rowToProjectMember);
}

export function updateProjectMember(
  db: Db,
  projectId: string,
  memberId: string,
  patch: ProjectMemberPatch
): ProjectMember | null {
  const values: Partial<ProjectMemberRow> = { updatedAt: patch.updatedAt };
  if (patch.type !== undefined) values.type = patch.type;
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.customPrompt !== undefined) values.customPrompt = patch.customPrompt;
  if (patch.launchOverrides !== undefined) {
    values.launchOverrides = JSON.stringify(projectMemberLaunchOverridesSchema.parse(patch.launchOverrides));
  }
  if (patch.workingDirectoryOverride !== undefined) {
    values.workingDirectoryOverride = patch.workingDirectoryOverride;
  }
  if (patch.lifecycle !== undefined) values.lifecycle = patch.lifecycle;
  db.update(projectMembers)
    .set(values)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.id, memberId)))
    .run();
  return getProjectMember(db, projectId, memberId);
}
