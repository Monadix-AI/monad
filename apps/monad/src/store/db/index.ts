import type {
  ChatMessage,
  Event,
  GetStatsResponse,
  IdempotencyKey,
  InboxItem,
  LedgerCategory,
  MeshAgentInboxItem,
  MeshSessionId,
  MessageAttachmentRef,
  MessageId,
  MessageType,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  NativeAgentDirectMessage,
  NativeAgentPendingInboxItem,
  ProjectId,
  SearchHit,
  Session,
  SessionId,
  StatsRange,
  StreamStatus,
  TokenUsage,
  TranscriptTargetId,
  UIMessageOutlineItem,
  WorkplaceProject
} from '@monad/protocol';
import type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';

import { Database } from 'bun:sqlite';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';

import {
  type AcpDelegateRow,
  closeAcpDelegate,
  listAcpDelegatesForSession,
  listLiveAcpDelegates,
  pruneOldAcpDelegates,
  reconcileOrphanedDelegates,
  touchAcpDelegate,
  upsertAcpDelegate
} from './acp-delegates.ts';
import {
  deleteMessageAttachments,
  getMessageAttachment,
  getMessageAttachmentRefs,
  type MessageAttachmentDetail,
  type MessageAttachmentInsert,
  registerMessageAttachment,
  registerMessageAttachments
} from './attachments.ts';
import {
  clearActiveConversation,
  countActiveConversations,
  getActiveConversation,
  listActiveConversations,
  listConversationSessions,
  type SetActiveSessionArgs,
  setActiveSession,
  touchConversation
} from './channels.ts';
import { type CheckpointHandle, startWalCheckpoint, stopWalCheckpoint } from './checkpoint.ts';
import { configureSqliteConnection } from './connection.ts';
import { allocateEventSequence, type EventSequenceRange, eventSequenceWatermark } from './event-sequence.ts';
import {
  appendEvents,
  type DanglingInterrupt,
  eventAnchorStatus,
  findDanglingInterrupts,
  getClarificationResolution,
  hasEvent,
  latestEventId,
  listEvents,
  listPendingInteractionEvents,
  listRecentEventsOfTypes,
  reconcileLegacyClarificationEvents
} from './events.ts';
import {
  compareAndDeleteExperienceState,
  compareAndSwapExperienceState,
  type ExperienceStateEventRecord,
  type ExperienceStateRecord,
  getExperienceState,
  listExperienceState,
  listExperienceStateEvents
} from './experience-state.ts';
import {
  cancelExperienceWorkerWakeup,
  type ExperienceWorkerWakeupRecord,
  listDueExperienceWorkerWakeups,
  scheduleExperienceWorkerWakeup
} from './experience-worker-wakeups.ts';
import {
  clearFileObservations,
  type FileObservationRow,
  getFileObservation,
  recordFileObservation
} from './file-observations.ts';
import {
  countMeshAgentInbox,
  type EnqueueMeshAgentInboxOptions,
  enqueueMeshAgentInboxItem,
  getNativeAgentDelivery,
  hasUnconsumedMeshAgentInbox,
  listMentionInbox,
  listMeshAgentInbox,
  markMeshAgentInboxConsumed,
  markMeshAgentInboxDelivered,
  markMeshAgentInboxVisible,
  meshAgentInboxCursor
} from './mesh-agent-inbox.ts';
import {
  clearMeshSessionRef,
  closeMeshSession,
  getMeshSession,
  listLiveMeshSessions,
  listMeshSessions,
  listMeshSessionsForTranscriptTarget,
  type MeshSessionRow,
  pruneExitedMeshSessions,
  reconcileOrphanedMeshSessions,
  setMeshAgentDeliveredCursor,
  setMeshAgentVisibleCursor,
  updateMeshSessionRef,
  upsertMeshSession
} from './mesh-sessions.ts';
import { listMeshUsageOverview, replaceMeshAgentUsageSnapshot, upsertMeshSessionUsageSnapshot } from './mesh-usage.ts';
import {
  assertReplyTarget,
  type CreateMessageInput,
  createMessage,
  type FailMessageInput,
  failCanonicalMessage,
  getMessageRevision,
  getSettledMessageMutationReplay,
  type MessageListSnapshot,
  type MessageMutationResult,
  type RemoveMessageInput,
  removeCanonicalMessage,
  type SettleMessageInput,
  settleCanonicalMessage,
  type UpdateMessageInput,
  updateCanonicalMessage
} from './message-mutations.ts';
import {
  cloneMessages,
  failOrphanedStreamingMessages,
  findManagedMeshAgentStreamingMessage,
  getMemory,
  getMessage,
  getMessageText,
  insertMessage,
  type ListMessagesOptions,
  listMessages,
  listMessagesSnapshot,
  listUserMessageOutline,
  maxMessageCreatedAt,
  maxMessageSeq,
  messageIdForSeq,
  messageSeq,
  restoreMessages,
  retireManagedMeshAgentStreamingMessage,
  setGenStatus,
  setMemory,
  snapshotAgentDisplayName
} from './messages.ts';
import { hasCurrentMigration, migrate } from './migrations.ts';
import {
  type CancelNativeAgentAskInput,
  type CreateNativeAgentAskInput,
  cancelNativeAgentAsk,
  createNativeAgentAsk,
  finishNativeAgentAskRecovery,
  getNativeAgentAsk,
  getNativeAgentMemberGate,
  type NativeAgentAskRecord,
  reconcileNativeAgentAsksAfterRestart,
  type SettleNativeAgentAskInput,
  settleNativeAgentAsk,
  transitionNativeAgentMemberGate
} from './native-agent-asks.ts';
import {
  type AcknowledgeVisibleNativeAgentIngressInput,
  type AcknowledgeVisibleNativeAgentIngressResult,
  acknowledgeVisibleNativeAgentIngress,
  bindNativeAgentIngressDelivery,
  type ClaimedNativeAgentIngressBatch,
  type ClaimedNativeAgentIngressItem,
  type ClaimNativeAgentIngressBatchInput,
  claimNativeAgentIngressBatch,
  claimNextNativeAgentIngressBatch,
  consumeNativeAgentIngressBatch,
  consumeNativeAgentPendingInbox,
  type EnqueueNativeAgentIngressInput,
  enqueueNativeAgentIngressItem,
  getNativeAgentIngressForDirectMessage,
  listClaimedNativeAgentIngress,
  listNativeAgentProjectInbox,
  listPendingNativeAgentIngressTargets,
  markNativeAgentIngressBatchDelivered,
  type NativeAgentIngressItem,
  type PendingNativeAgentIngressTarget,
  reconcileNativeAgentIngressAfterRestart,
  releaseNativeAgentIngressBatch
} from './native-agent-ingress.ts';
import {
  type ReconcileNativeAgentMemberKeysResult,
  reconcileNativeAgentMemberKeys
} from './native-agent-key-reconcile.ts';
import {
  getNativeAgentDirectMessage,
  insertNativeAgentDirectMessage,
  listNativeAgentDirectMessages
} from './native-agent-messages.ts';
import {
  listOperatorInbox,
  markAllOperatorInboxRead,
  markOperatorInboxRead,
  markOperatorInboxUnread,
  operatorInboxSummary
} from './operator-inbox.ts';
import {
  getProjectMember,
  insertProjectMember,
  listProjectMembers,
  type ProjectMemberPatch,
  updateProjectMember
} from './project-members.ts';
import {
  getWorkplaceProjectOrderRevision,
  reorderWorkplaceProject as reorderWorkplaceProjectInStore
} from './project-order.ts';
import {
  clearEmbeddings,
  messagesMissingEmbedding,
  pendingEmbeddingCount,
  type SearchOptions,
  type SearchSemanticOptions,
  searchMessages,
  searchSemantic,
  staleEmbeddingCount,
  upsertEmbedding
} from './search.ts';
import {
  advanceSessionActivity,
  applySessionAttentionSource,
  consumeSessionAttention,
  listSessionAttention,
  reconcileSessionActionAttention,
  resolveSessionAttentionSource,
  type SessionAttentionSourceInput
} from './session-attention.ts';
import {
  advanceSessionBindingDeliveredCursor,
  advanceSessionBindingVisibleCursor,
  getSessionBinding,
  insertSessionBinding,
  leaveSessionBinding,
  listProjectMemberBindings,
  listSessionBindings,
  replaceSessionBindingRuntime,
  type SessionBindingInsert,
  type SessionBindingPatch,
  SessionBindingRuntimeOwnershipError,
  settleTerminalSessionBindingRuntime,
  updateSessionBinding
} from './session-bindings.ts';
import {
  deleteSessionMember,
  deleteSessionMembers,
  getSessionMember,
  getSessionMemberByTemplate,
  insertSessionMember,
  listSessionMembers,
  type SessionMember,
  type SessionMemberInsert,
  type SessionMemberPatch,
  updateSessionMember,
  updateSessionMemberData
} from './session-members.ts';
import { createSessionPlanStore } from './session-plans.ts';
import {
  addUsage,
  clearMessages,
  countSessions,
  countWorkplaceProjects,
  deleteSession,
  deleteWorkplaceProject,
  getSession,
  getWorkplaceProject,
  insertSession,
  insertWorkplaceProject,
  type ListSessionsFilter,
  listSessions,
  listWorkplaceProjects,
  type SessionPatch,
  updateSession,
  updateWorkplaceProject,
  type WorkplaceProjectPatch
} from './sessions.ts';
import {
  clearLedger,
  computeStats,
  type LedgerBreakdownRow,
  type LedgerEntry,
  ledger,
  ledgerBreakdown,
  recordLedger
} from './stats.ts';

export type { ChatMessage } from '@monad/protocol';
export type { AcpDelegateRow } from './acp-delegates.ts';
export type { ExperienceStateEventRecord, ExperienceStateRecord } from './experience-state.ts';
export type { ExperienceWorkerWakeupRecord } from './experience-worker-wakeups.ts';
export type { FileObservationRow } from './file-observations.ts';
export type { EnqueueMeshAgentInboxOptions } from './mesh-agent-inbox.ts';
export type { MeshSessionRow } from './mesh-sessions.ts';
export type { ListMessagesOptions } from './messages.ts';
export type {
  CreateNativeAgentAskInput,
  NativeAgentAskRecord,
  SettleNativeAgentAskInput
} from './native-agent-asks.ts';
export type {
  AcknowledgeVisibleNativeAgentIngressInput,
  AcknowledgeVisibleNativeAgentIngressResult,
  ClaimedNativeAgentIngressBatch,
  ClaimedNativeAgentIngressItem,
  ClaimNativeAgentIngressBatchInput,
  EnqueueNativeAgentIngressInput,
  NativeAgentIngressItem
} from './native-agent-ingress.ts';
export type { ProjectMemberPatch } from './project-members.ts';
export type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';
export type { SearchOptions } from './search.ts';
export type { SessionAttentionSourceInput } from './session-attention.ts';
export type { SessionBindingPatch } from './session-bindings.ts';
export type { SessionMember, SessionMemberInsert, SessionMemberPatch } from './session-members.ts';
export type { ListSessionsFilter } from './sessions.ts';
export type { LedgerBreakdownRow, LedgerEntry } from './stats.ts';

export { ProjectOrderConflictError } from './project-order.ts';

export interface StoreOptions {
  /** File path, or ":memory:" for an ephemeral in-process DB (the default). */
  path?: string;
}

export class Store {
  private readonly fileBacked: boolean;
  private readonly sqlite: Database;
  readonly db: BunSQLiteDatabase<Record<string, never>>;
  readonly sessionPlans: ReturnType<typeof createSessionPlanStore>;
  #checkpoint: CheckpointHandle | undefined;

  constructor(opts: StoreOptions = {}) {
    const path = opts.path ?? ':memory:';
    this.fileBacked = path !== ':memory:';
    const sqlite = new Database(path);
    let db: BunSQLiteDatabase<Record<string, never>>;
    try {
      configureSqliteConnection(sqlite, path);
      db = drizzle(sqlite);
      migrate(db);
    } catch (error) {
      sqlite.close();
      throw error;
    }
    this.sqlite = sqlite;
    this.db = db;
    this.sessionPlans = createSessionPlanStore(sqlite);
    if (this.fileBacked) {
      this.#checkpoint = startWalCheckpoint(path);
    }
  }

  hasCurrentMigration(): boolean {
    return hasCurrentMigration(this.sqlite);
  }

  getExperienceState(atomPackId: string, projectId: string, key: string): ExperienceStateRecord | null {
    return getExperienceState(this.sqlite, atomPackId, projectId, key);
  }

  listExperienceState(atomPackId: string, projectId: string, prefix: string): ExperienceStateRecord[] {
    return listExperienceState(this.sqlite, atomPackId, projectId, prefix);
  }

  compareAndSwapExperienceState(input: Parameters<typeof compareAndSwapExperienceState>[1]): boolean {
    return compareAndSwapExperienceState(this.sqlite, input);
  }

  compareAndDeleteExperienceState(input: Parameters<typeof compareAndDeleteExperienceState>[1]): boolean {
    return compareAndDeleteExperienceState(this.sqlite, input);
  }

  listExperienceStateEvents(atomPackId: string, projectId: string, key: string): ExperienceStateEventRecord[] {
    return listExperienceStateEvents(this.sqlite, atomPackId, projectId, key);
  }

  scheduleExperienceWorkerWakeup(input: Omit<ExperienceWorkerWakeupRecord, 'attempt'>): void {
    scheduleExperienceWorkerWakeup(this.sqlite, input);
  }

  cancelExperienceWorkerWakeup(atomPackId: string, experienceId: string, projectId: string, key: string): void {
    cancelExperienceWorkerWakeup(this.sqlite, atomPackId, experienceId, projectId, key);
  }

  listDueExperienceWorkerWakeups(now: string): ExperienceWorkerWakeupRecord[] {
    return listDueExperienceWorkerWakeups(this.sqlite, now);
  }

  insertSession(s: Session): void {
    insertSession(this.db, s);
  }

  listSessions(filter: ListSessionsFilter = {}): Session[] {
    return listSessions(this.db, filter);
  }

  countSessions(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    return countSessions(this.db, filter);
  }

  getSession(id: string): Session | null {
    return getSession(this.db, id);
  }

  applySessionAttentionSource(input: SessionAttentionSourceInput): void {
    applySessionAttentionSource(this.sqlite, input);
  }

  advanceSessionActivity(sessionId: SessionId, occurredAt: string): void {
    advanceSessionActivity(this.sqlite, sessionId, occurredAt);
  }

  listSessionAttention(sessionIds: readonly SessionId[]) {
    return listSessionAttention(this.sqlite, sessionIds);
  }

  reconcileSessionActionAttention(reconciledAt: string): void {
    reconcileSessionActionAttention(this.sqlite, reconciledAt);
  }

  consumeSessionAttention(sessionId: SessionId, itemKeys: readonly string[], cause: 'open' | 'visible', at: string) {
    return consumeSessionAttention(this.sqlite, sessionId, itemKeys, cause, at);
  }

  resolveSessionAttentionSource(sessionId: SessionId, sourceType: string, sourceId: string): number {
    return resolveSessionAttentionSource(this.sqlite, sessionId, sourceType, sourceId);
  }

  /** Bumps updatedAt. Returns the updated row, or null if not found. */
  updateSession(id: string, patch: SessionPatch): Session | null {
    return updateSession(this.db, id, patch);
  }

  deleteSession(id: string): boolean {
    return deleteSession(this.sqlite, id);
  }

  insertWorkplaceProject(project: WorkplaceProject): void {
    insertWorkplaceProject(this.db, project);
  }

  listWorkplaceProjects(filter: ListSessionsFilter = {}): WorkplaceProject[] {
    return listWorkplaceProjects(this.db, filter);
  }

  getWorkplaceProjectOrderRevision(): number {
    return getWorkplaceProjectOrderRevision(this.sqlite);
  }

  reorderWorkplaceProject(input: Parameters<typeof reorderWorkplaceProjectInStore>[1]) {
    return reorderWorkplaceProjectInStore(this.sqlite, input);
  }

  countWorkplaceProjects(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    return countWorkplaceProjects(this.db, filter);
  }

  getWorkplaceProject(id: string): WorkplaceProject | null {
    return getWorkplaceProject(this.db, id);
  }

  updateWorkplaceProject(id: string, patch: WorkplaceProjectPatch): WorkplaceProject | null {
    return updateWorkplaceProject(this.db, id, patch);
  }

  insertProjectMember(member: Parameters<typeof insertProjectMember>[1]): void {
    insertProjectMember(this.db, member);
  }

  getProjectMember(projectId: string, memberId: string) {
    return getProjectMember(this.db, projectId, memberId);
  }

  listProjectMembers(projectId: string) {
    return listProjectMembers(this.db, projectId);
  }

  updateProjectMember(projectId: string, memberId: string, patch: ProjectMemberPatch) {
    return updateProjectMember(this.db, projectId, memberId, patch);
  }

  insertSessionBinding(binding: Parameters<typeof insertSessionBinding>[2]): void {
    insertSessionBinding(this.sqlite, this.db, binding);
  }

  getSessionBinding(sessionId: string, projectMemberId: string) {
    return getSessionBinding(this.db, sessionId, projectMemberId);
  }

  listSessionBindings(sessionId: string) {
    return listSessionBindings(this.db, sessionId);
  }

  listProjectMemberBindings(projectId: string, projectMemberId: string) {
    return listProjectMemberBindings(this.db, projectId, projectMemberId);
  }

  updateSessionBinding(sessionId: string, projectMemberId: string, patch: SessionBindingPatch) {
    return updateSessionBinding(this.db, sessionId, projectMemberId, patch);
  }

  leaveSessionBinding(sessionId: string, projectMemberId: string, updatedAt: string) {
    return leaveSessionBinding(this.db, sessionId, projectMemberId, updatedAt);
  }

  // Atomic strangler-fig member creation (spawn, template-backed invite, or session creation):
  // the legacy SessionMember row, the canonical ProjectMember, and its initial SessionBinding all
  // commit together, so a crash or a constraint failure can never leave a half-built identity graph.
  // Runtime launch stays outside this transaction.
  createProjectSessionMember(input: {
    legacyMember: SessionMemberInsert;
    member: Parameters<typeof insertProjectMember>[1];
    binding: SessionBindingInsert;
  }): void {
    this.sqlite.transaction(() => {
      insertSessionMember(this.db, input.legacyMember);
      insertProjectMember(this.db, input.member);
      insertSessionBinding(this.sqlite, this.db, input.binding);
    })();
  }

  replaceSessionBindingRuntime(input: Parameters<typeof replaceSessionBindingRuntime>[2]) {
    return replaceSessionBindingRuntime(this.sqlite, this.db, input);
  }

  settleTerminalSessionBindingRuntime(input: Parameters<typeof settleTerminalSessionBindingRuntime>[1]) {
    return settleTerminalSessionBindingRuntime(this.db, input);
  }

  // Restart recovery for managed-project-agent runtime ownership. It MUST run after the orphan reconcile
  // (createDaemonHandlers order) has stamped every previously-live runtime terminal — a daemon restart is
  // authoritative proof the old local process exited. So it enumerates ALL managed runtimes (not just
  // live, which is empty by then) and, per runtime, in ONE transaction: backfills project_member_id
  // ownership through the single sanctioned entrance (replaceSessionBindingRuntime), catches the binding
  // cursor up to the runtime's final watermark (advance = MAX, never a rewind), then clears the binding's
  // current runtime — a terminal runtime can be OWNED but can never be a binding's authoritative current;
  // only a live runtime may. A `left` binding is recovered too (ownership + cursor) with its lifecycle
  // preserved, never revived.
  //
  // Owner authority: the runtime's persisted project_member_id wins. A legacy SessionMember row that
  // disagrees is an observable CONFLICT — but the durable owner's binding is still converged; only the
  // legacy claimant's binding is left untouched. lastHealth is written ONLY from the runtime the binding
  // is authoritatively attached to (its own current, or the legacy row that points the owner at it); a
  // historical runtime touched purely for ownership/cursor MAX must never backwash its state onto the
  // binding. Idempotent on every boot — an already-converged runtime is left byte-for-byte unchanged.
  // Returns counts for the boot caller to log.
  reconcileSessionBindingRuntimesAfterRestart(): { recovered: number; skipped: number; conflicts: number } {
    const stats = { recovered: 0, skipped: 0, conflicts: 0 };
    const now = new Date().toISOString();
    // Resolve every managed runtime's owner up front and SNAPSHOT each binding's current runtime BEFORE the
    // loop mutates any binding. Authoritative-health is judged against this immutable snapshot, never the
    // live binding.current — otherwise a historical runtime processed first clears the current pointer and
    // the true current runtime is then misclassified as non-authoritative, freezing a stale health.
    const resolved = listMeshSessions(this.sqlite)
      .filter((runtime) => runtime.runtimeRole === 'managed-project-agent')
      .map((runtime) => {
        const sessionId = runtime.transcriptTargetId;
        const legacyOwner =
          listSessionMembers(this.db, sessionId).find((member) => member.meshSessionId === runtime.id)?.memberId ??
          null;
        return { runtime, sessionId, legacyOwner, owner: runtime.projectMemberId ?? legacyOwner };
      });
    const originalCurrentByBinding = new Map<string, string | null>();
    for (const { sessionId, owner } of resolved) {
      if (!owner) continue;
      const key = `${sessionId} ${owner}`;
      if (!originalCurrentByBinding.has(key)) {
        originalCurrentByBinding.set(
          key,
          getSessionBinding(this.db, sessionId, owner)?.currentNativeRuntimeSessionId ?? null
        );
      }
    }
    for (const { runtime, sessionId, legacyOwner, owner } of resolved) {
      if (!owner) {
        stats.skipped += 1;
        continue;
      }
      // A legacy row pointing this runtime at a different member than its durable owner is a real,
      // observable conflict — but the durable owner still wins and its binding is still converged below;
      // the legacy claimant's own binding is never touched here.
      if (runtime.projectMemberId !== null && legacyOwner !== null && runtime.projectMemberId !== legacyOwner) {
        stats.conflicts += 1;
      }
      const binding = getSessionBinding(this.db, sessionId, owner);
      if (!binding) {
        stats.skipped += 1;
        continue;
      }
      // Exactly one runtime may dictate lastHealth, judged against the immutable pre-loop snapshot so
      // processing order can never misclassify it. When the binding had a current runtime at the START of
      // this reconcile, THAT runtime is the sole health authority; the legacy SessionMember link is only an
      // owner/cursor fallback, never a second authority. (A live start sets binding.current before the
      // legacy row moves, so current=NEW while the legacy link still points at a terminal OLD is a real
      // crash window; letting OLD also claim authority reintroduces order-dependent health.) The
      // legacy-linked runtime is authority ONLY when the snapshot current is null AND the binding health is
      // itself unset — it may HEAL a genuinely-null health but must never overwrite a valid terminal health,
      // so a stale legacy link can't flip an already-correct health to a different terminal state on a later
      // restart (keeping the second restart a no-op).
      const snapshotCurrent = originalCurrentByBinding.get(`${sessionId} ${owner}`) ?? null;
      const isAuthoritative =
        snapshotCurrent !== null
          ? snapshotCurrent === runtime.id
          : binding.lastHealth === null && legacyOwner === owner;
      // Idempotency: only touch a runtime that is actually out of sync — missing ownership, a cursor
      // behind the runtime's watermark, still the binding's current, or (authoritative only) a stale
      // health. An already-converged runtime is left byte-for-byte unchanged.
      const ownershipMissing = runtime.projectMemberId !== owner;
      const cursorBehind =
        binding.lastDeliveredSeq < runtime.lastDeliveredSeq || binding.lastVisibleSeq < runtime.lastVisibleSeq;
      const pointsAtTerminalRuntime = binding.currentNativeRuntimeSessionId === runtime.id;
      const healthStale = isAuthoritative && binding.lastHealth !== runtime.state;
      if (!ownershipMissing && !cursorBehind && !pointsAtTerminalRuntime && !healthStale) continue;
      const preHealth = binding.lastHealth;
      try {
        this.sqlite.transaction(() => {
          // Claim ownership (transient current never escapes this transaction), catch the cursor up, then
          // clear the current pointer — a restart proves the old local process exited, so a terminal
          // runtime can be owned but never a binding's authoritative current. lifecycle is untouched.
          replaceSessionBindingRuntime(this.sqlite, this.db, {
            sessionId,
            projectMemberId: owner,
            currentNativeRuntimeSessionId: runtime.id as MeshSessionId,
            updatedAt: now
          });
          advanceSessionBindingDeliveredCursor(this.db, sessionId, owner, runtime.lastDeliveredSeq, now);
          advanceSessionBindingVisibleCursor(this.db, sessionId, owner, runtime.lastVisibleSeq, now);
          replaceSessionBindingRuntime(this.sqlite, this.db, {
            sessionId,
            projectMemberId: owner,
            currentNativeRuntimeSessionId: null,
            updatedAt: now
          });
          // The claim above stamped lastHealth from this runtime. Only the authoritative attachment may do
          // that; a historical runtime touched only for ownership/cursor restores the prior health so it
          // never backwashes an old state onto the binding.
          if (!isAuthoritative) {
            updateSessionBinding(this.db, sessionId, owner, { lastHealth: preHealth, updatedAt: now });
          }
        })();
        stats.recovered += 1;
      } catch (error) {
        // The single transaction has already rolled back. A genuine ownership conflict is classified (a
        // defensive path — the loop resolves owner FROM the runtime, so replace never disowns it); any
        // other error is a real fault that must surface.
        if (error instanceof SessionBindingRuntimeOwnershipError) {
          stats.conflicts += 1;
        } else {
          throw error;
        }
      }
    }
    return stats;
  }

  advanceSessionBindingDeliveredCursor(sessionId: string, projectMemberId: string, seq: number, updatedAt: string) {
    return advanceSessionBindingDeliveredCursor(this.db, sessionId, projectMemberId, seq, updatedAt);
  }

  advanceSessionBindingVisibleCursor(sessionId: string, projectMemberId: string, seq: number, updatedAt: string) {
    return advanceSessionBindingVisibleCursor(this.db, sessionId, projectMemberId, seq, updatedAt);
  }

  insertSessionMember(member: SessionMemberInsert): void {
    insertSessionMember(this.db, member);
  }

  listSessionMembers(sessionId: string): SessionMember[] {
    return listSessionMembers(this.db, sessionId);
  }

  getSessionMember(sessionId: string, memberId: string): SessionMember | null {
    return getSessionMember(this.db, sessionId, memberId);
  }

  getSessionMemberByTemplate(sessionId: string, templateId: string): SessionMember | null {
    return getSessionMemberByTemplate(this.db, sessionId, templateId);
  }

  updateSessionMember(sessionId: string, memberId: string, patch: SessionMemberPatch): void {
    updateSessionMember(this.db, sessionId, memberId, patch);
  }

  updateSessionMemberData(
    sessionId: string,
    memberId: string,
    updatedAt: string,
    update: (data: Record<string, unknown>) => Record<string, unknown>
  ): SessionMember | null {
    return updateSessionMemberData(this.db, sessionId, memberId, updatedAt, update);
  }

  deleteSessionMember(sessionId: string, memberId: string): void {
    deleteSessionMember(this.db, sessionId, memberId);
  }

  deleteSessionMembers(sessionId: string): void {
    deleteSessionMembers(this.db, sessionId);
  }

  deleteWorkplaceProject(id: string): boolean {
    return deleteWorkplaceProject(this.sqlite, id);
  }

  clearMessages(id: string): number {
    return clearMessages(this.sqlite, this.db, id);
  }

  /** Spill a tool result's full pre-truncation output, keyed by (transcript target, provider
   *  tool-call id). Idempotent per key (a replayed/re-run call with the same id overwrites). */
  saveToolRawOutput(sessionId: string, toolCallId: string, output: string): void {
    this.sqlite
      .query(
        `INSERT INTO tool_raw_outputs (transcript_target_id, tool_call_id, output, created_at)
         VALUES ($sid, $tid, $out, $at)
         ON CONFLICT(transcript_target_id, tool_call_id) DO UPDATE SET output = excluded.output, created_at = excluded.created_at`
      )
      .run({ $sid: sessionId, $tid: toolCallId, $out: output, $at: new Date().toISOString() });
  }

  /** Read a spilled tool output by handle, scoped to exactly this transcript target. Branching
   *  copies spills alongside messages (see cloneToolRawOutputs) — copy semantics, matching how
   *  session branching clones history rather than sharing it by lineage. Returns null when no
   *  spill exists for that id in this transcript. */
  getToolRawOutput(sessionId: string, toolCallId: string): string | null {
    const row = this.sqlite
      .query('SELECT output FROM tool_raw_outputs WHERE transcript_target_id = ? AND tool_call_id = ?')
      .get(sessionId, toolCallId) as { output: string } | null;
    return row?.output ?? null;
  }

  /** Copy the source transcript's spilled tool outputs referenced by the given tool-call ids into a
   *  branch child — cloneMessages copies tool_call rows with their toolCallIds intact, so the child's
   *  read_tool_output handles must resolve against its own transcript id. */
  cloneToolRawOutputs(sourceId: string, targetId: string, toolCallIds: readonly string[]): void {
    if (toolCallIds.length === 0) return;
    const placeholders = toolCallIds.map(() => '?').join(', ');
    this.sqlite
      .query(
        `INSERT OR REPLACE INTO tool_raw_outputs (transcript_target_id, tool_call_id, output, created_at)
         SELECT ?, tool_call_id, output, created_at FROM tool_raw_outputs
         WHERE transcript_target_id = ? AND tool_call_id IN (${placeholders})`
      )
      .run(targetId, sourceId, ...toolCallIds);
  }
  /** Accumulate one turn's REAL usage + cost into a session (per-session, resettable). Missing
   *  fields contribute 0 (presence ≠ value — never invent). */
  addUsage(id: string, usage: TokenUsage, costUsd = 0): void {
    addUsage(this.sqlite, id, usage, costUsd);
  }

  /** Accumulate one operation into the global usage ledger (see ./stats.ts). */
  recordLedger(provider: string, model: string, category: LedgerCategory, usage: TokenUsage, costUsd = 0): void {
    recordLedger(this.sqlite, provider, model, category, usage, costUsd);
  }

  ledger(): LedgerEntry[] {
    return ledger(this.sqlite);
  }

  ledgerBreakdown(): LedgerBreakdownRow[] {
    return ledgerBreakdown(this.sqlite);
  }

  clearLedger(): void {
    clearLedger(this.sqlite);
  }

  stats(range: StatsRange = 'all'): GetStatsResponse {
    return computeStats(this.sqlite, range);
  }

  insertMessage(
    id: string,
    transcriptTargetId: string,
    text: string,
    createdAt: string,
    role: ChatMessage['role'] = 'user',
    opts: {
      type?: MessageType;
      data?: unknown;
      replyToMessageId?: MessageId;
      streamStatus?: StreamStatus;
      includeInContext?: boolean;
    } = {}
  ): void {
    insertMessage(this.db, id, transcriptTargetId, text, createdAt, role, opts);
  }

  cloneMessages(transcriptTargetId: SessionId, sourceMessages: readonly ChatMessage[]): Map<MessageId, MessageId> {
    return cloneMessages(this.sqlite, this.db, transcriptTargetId, sourceMessages);
  }

  messageSeq(transcriptTargetId: string, messageId: string): number {
    return messageSeq(this.sqlite, transcriptTargetId, messageId);
  }

  /** Advance a generative message's lifecycle, rejecting illegal/backward transitions
   * (anything leaving a terminal `complete`/`error`). Optionally set the final `text`/`data` in the
   * same write (so a `complete` transition lands the settled content atomically). Returns false if
   * the row is missing or the transition is disallowed. */
  setGenStatus(
    transcriptTargetId: string,
    messageId: string,
    next: StreamStatus,
    updatedAt: string,
    content?: { text?: string; data?: unknown; type?: MessageType; includeInContext?: boolean; createdAt?: string }
  ): boolean {
    return setGenStatus(this.sqlite, transcriptTargetId, messageId, next, updatedAt, content);
  }

  /** On daemon startup, terminally fail any rows left mid-stream by a crash/restart. Their turn is
   * dead and can never resume, so a client that sees `pending`/`streaming` would subscribe to a gone
   * stream and hang. Flipping them to `error` makes clients render from the row (terminal) instead;
   * excluding them from context keeps a half/empty turn out of later prompts. Returns the row count.
   * Safe because a freshly-started daemon has no live turns — every in-flight row is orphaned. */
  failOrphanedStreamingMessages(updatedAt: string): number {
    return failOrphanedStreamingMessages(this.sqlite, updatedAt);
  }

  createMessage(input: CreateMessageInput): MessageMutationResult {
    return createMessage(this.sqlite, input);
  }

  getSettledMessageMutationReplay(
    transcriptTargetId: TranscriptTargetId,
    idempotencyKey: IdempotencyKey
  ): ChatMessage | null {
    return getSettledMessageMutationReplay(this.sqlite, transcriptTargetId, idempotencyKey);
  }

  assertReplyTarget(transcriptTargetId: TranscriptTargetId, replyToMessageId: MessageId, messageId?: MessageId): void {
    assertReplyTarget(this.sqlite, transcriptTargetId, replyToMessageId, messageId);
  }

  updateMessage(input: UpdateMessageInput): MessageMutationResult {
    return updateCanonicalMessage(this.sqlite, input);
  }

  settleMessage(input: SettleMessageInput): MessageMutationResult {
    return settleCanonicalMessage(this.sqlite, input);
  }

  failMessage(input: FailMessageInput): MessageMutationResult {
    return failCanonicalMessage(this.sqlite, input);
  }

  removeMessage(input: RemoveMessageInput): MessageMutationResult {
    return removeCanonicalMessage(this.sqlite, input);
  }

  getMessageRevision(transcriptTargetId: TranscriptTargetId): number {
    return getMessageRevision(this.sqlite, transcriptTargetId);
  }

  listMessagesSnapshot(transcriptTargetId: TranscriptTargetId, opts: ListMessagesOptions = {}): MessageListSnapshot {
    return listMessagesSnapshot(this.sqlite, transcriptTargetId, opts);
  }

  /** Ordered by sqlite rowid (insertion order). Defaults to active (non-rewound) messages only. */
  listMessages(transcriptTargetId: SessionId, opts?: ListMessagesOptions): (ChatMessage & { sessionId: SessionId })[];
  listMessages(transcriptTargetId: ProjectId, opts?: ListMessagesOptions): (ChatMessage & { sessionId: ProjectId })[];
  listMessages(transcriptTargetId: string, opts?: ListMessagesOptions): ChatMessage[];
  listMessages(transcriptTargetId: string, opts: ListMessagesOptions = {}): ChatMessage[] {
    return listMessages(this.sqlite, transcriptTargetId, opts);
  }

  listUserMessageOutline(transcriptTargetId: TranscriptTargetId): UIMessageOutlineItem[] {
    return listUserMessageOutline(this.sqlite, transcriptTargetId);
  }

  getMessage(transcriptTargetId: SessionId, messageId: string): (ChatMessage & { sessionId: SessionId }) | null;
  getMessage(transcriptTargetId: ProjectId, messageId: string): (ChatMessage & { sessionId: ProjectId }) | null;
  getMessage(transcriptTargetId: string, messageId: string): ChatMessage | null;
  getMessage(transcriptTargetId: string, messageId: string): ChatMessage | null {
    return getMessage(this.sqlite, transcriptTargetId, messageId);
  }

  snapshotAgentDisplayName(transcriptTargetId: string, memberOrAgentId: string, agentDisplayName: string): number {
    return snapshotAgentDisplayName(this.sqlite, transcriptTargetId, memberOrAgentId, agentDisplayName);
  }

  findManagedMeshAgentStreamingMessage(transcriptTargetId: string, meshSessionId: string): string | null {
    return findManagedMeshAgentStreamingMessage(this.sqlite, transcriptTargetId, meshSessionId);
  }

  retireManagedMeshAgentStreamingMessage(
    transcriptTargetId: string,
    messageId: string,
    meshSessionId: string,
    updatedAt = new Date().toISOString()
  ): boolean {
    return retireManagedMeshAgentStreamingMessage(this.sqlite, transcriptTargetId, messageId, meshSessionId, updatedAt);
  }

  /** Global lookup of a LIVE message's text by id (no session needed). Used to trace a graph edge
   *  back to the source message it was extracted from (the bottom of the "why do you believe X"
   *  chain) — `active = 1` so a soft-deleted message can't resurface before the next reconcile. */
  getMessageText(messageId: string): string | null {
    return getMessageText(this.sqlite, messageId);
  }

  /** Per-session durable key/value (the `memory` table). Returns null when unset. */
  getMemory(sessionId: string, key: string): string | null {
    return getMemory(this.sqlite, sessionId, key);
  }

  /** Upsert a per-session durable key/value. */
  setMemory(sessionId: string, key: string, value: string): void {
    setMemory(this.sqlite, sessionId, key, value);
  }

  recordFileObservation(sessionId: string, observation: FileObservationRow): void {
    recordFileObservation(this.sqlite, sessionId, observation);
  }

  getFileObservation(sessionId: string, path: string): FileObservationRow | null {
    return getFileObservation(this.sqlite, sessionId, path);
  }

  clearFileObservations(sessionId: string): number {
    return clearFileObservations(this.sqlite, sessionId);
  }

  /**
   * Soft-delete (active=0) `toMessageId` and everything after it, bumps restore_count.
   * Caller must validate that `toMessageId` exists and is a user message.
   */
  restoreMessages(sessionId: string, toMessageId: string): { restoredCount: number; newHeadMessageId: string | null } {
    return restoreMessages(this.sqlite, sessionId, toMessageId);
  }

  /**
   * FTS5 (tokenized) + trigram (substring/CJK, queries ≥3 chars) + LIKE fallback.
   * `mode` semantic/hybrid degrade to keyword until embeddings are configured.
   */
  searchMessages(opts: SearchOptions): SearchHit[] {
    return searchMessages(this.sqlite, opts);
  }

  /** Store/replace a message's embedding vector (raw little-endian float32 bytes). `model` records
   *  which embedding model produced it, so a later model switch can detect stale vectors. */
  upsertEmbedding(messageId: string, vec: number[], model?: string): void {
    upsertEmbedding(this.sqlite, messageId, vec, model);
  }

  /** Drop every stored embedding (used when the embedding model changes and the user opts to
   *  re-index from scratch). Returns how many vectors were cleared; the indexer then rebuilds. */
  clearEmbeddings(): number {
    return clearEmbeddings(this.sqlite);
  }

  /**
   * Active messages with no embedding yet. `limit` caps the batch — pass it for an unscoped
   * (whole-corpus) backfill so a single request can't materialize + embed the entire DB at
   * once; a session-scoped call is already bounded by that session and can omit it.
   */
  messagesMissingEmbedding(transcriptTargetId?: string, limit?: number): { id: string; text: string }[] {
    return messagesMissingEmbedding(this.sqlite, transcriptTargetId, limit);
  }

  /** How many active, non-empty messages still lack an embedding — surfaced as an "indexing N
   *  left" hint so a semantic search can tell the user recall may be incomplete. */
  pendingEmbeddingCount(transcriptTargetId?: string): number {
    return pendingEmbeddingCount(this.sqlite, transcriptTargetId);
  }

  /** How many stored vectors were produced by a model OTHER than `currentModel` — i.e. stale after
   *  an embedding-model switch. Vectors with an unknown (NULL) model are not counted as stale. */
  staleEmbeddingCount(currentModel: string): number {
    return staleEmbeddingCount(this.sqlite, currentModel);
  }

  searchSemantic(queryVec: number[], opts: SearchSemanticOptions = {}): SearchHit[] {
    return searchSemantic(this.sqlite, queryVec, opts);
  }

  /** Run `fn` inside a single database transaction. Nested store calls that open their own
   * transaction become savepoints of this one, so a domain mutation and its durable event append
   * commit or roll back together. Side effects (bus publish, fanout) must stay outside `fn`. */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  /** Idempotent on id (INSERT OR IGNORE). */
  appendEvents(batch: Event[]): void {
    appendEvents(this.sqlite, batch);
  }

  reconcileLegacyClarificationEvents(): number {
    return reconcileLegacyClarificationEvents(this.sqlite);
  }

  /** Reserve `count` consecutive scope-local sequence numbers for `scope` (see event-sequence.ts). */
  allocateEventSequence(scope: string, count = 1): EventSequenceRange {
    return allocateEventSequence(this.sqlite, scope, count);
  }

  /** Last issued scope-local sequence for `scope`, or 0 if none. */
  eventSequenceWatermark(scope: string): number {
    return eventSequenceWatermark(this.sqlite, scope);
  }

  /** Find approval/clarify requests that have no matching resolved event (left dangling by a restart). */
  findDanglingInterrupts(): DanglingInterrupt[] {
    return findDanglingInterrupts(this.sqlite);
  }

  getClarificationResolution(requestId: string) {
    return getClarificationResolution(this.sqlite, requestId);
  }

  /** True when `eventId` is present in the durable event log. Lets callers distinguish a persisted
   *  cursor from an un-persisted live message delta before calling {@link listEvents},
   *  whose missing-cursor fallback would otherwise replay the whole session. */
  hasEvent(transcriptTargetId: string, eventId: string): boolean {
    return hasEvent(this.sqlite, transcriptTargetId, eventId);
  }

  /** Three-way durable-anchor check for scope-bound replay cursors (see events.ts). */
  eventAnchorStatus(transcriptTargetId: string, eventId: string): 'durable' | 'other_scope' | 'missing' {
    return eventAnchorStatus(this.sqlite, transcriptTargetId, eventId);
  }

  /** Newest durably-appended event id for a transcript, or undefined when empty (see events.ts). */
  latestEventId(transcriptTargetId: string): string | undefined {
    return latestEventId(this.sqlite, transcriptTargetId);
  }

  /** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. Pass
   *  `limit` to read one bounded ascending page for memory-safe paged replay. */
  listEvents(sessionId: string, afterEventId?: string, limit?: number): Event[] {
    return listEvents(this.sqlite, sessionId, afterEventId, limit);
  }

  listRecentEventsOfTypes(sessionId: string, types: Event['type'][], limit: number): Event[] {
    return listRecentEventsOfTypes(this.sqlite, sessionId, types, limit);
  }

  listPendingInteractionEvents(sessionId: string): Event[] {
    return listPendingInteractionEvents(this.sqlite, sessionId);
  }

  getActiveConversation(channelId: string, conversationKey: string): ChannelConversation | null {
    return getActiveConversation(this.sqlite, channelId, conversationKey);
  }

  /** Repoint a conversation at `sessionId`, recording it in the history index. Upsert. */
  setActiveSession(args: SetActiveSessionArgs): void {
    setActiveSession(this.sqlite, args);
  }

  clearActiveConversation(channelId: string, conversationKey: string): void {
    clearActiveConversation(this.sqlite, channelId, conversationKey);
  }

  touchConversation(channelId: string, conversationKey: string): void {
    touchConversation(this.sqlite, channelId, conversationKey);
  }

  listConversationSessions(channelId: string, conversationKey: string): ChannelConversationSession[] {
    return listConversationSessions(this.sqlite, channelId, conversationKey);
  }

  countActiveConversations(channelId: string): number {
    return countActiveConversations(this.sqlite, channelId);
  }

  listActiveConversations(channelId: string): Array<{ conversationKey: string; activeSessionId: string }> {
    return listActiveConversations(this.sqlite, channelId);
  }

  // ── ACP Delegate Ledger ────────────────────────────────────────────────────────────────────────

  /** Insert a new live-delegate row on spawn. Upsert-safe: a re-spawn after eviction gets a fresh row. */
  upsertAcpDelegate(row: Omit<AcpDelegateRow, 'evictedAt' | 'evictReason' | 'reuseCount' | 'promptCount'>): void {
    upsertAcpDelegate(this.sqlite, row);
  }

  /** Update stats after a successful prompt (called in promptDelegate's finally block).
   *  Returns true if a live row was updated, false if the row was already evicted or missing. */
  touchAcpDelegate(id: string, lastUsedAt: string, reuseCount: number, promptCount: number): boolean {
    return touchAcpDelegate(this.sqlite, id, lastUsedAt, reuseCount, promptCount);
  }

  /** Mark a delegate as evicted (either by explicit eviction or daemon restart cleanup). */
  closeAcpDelegate(id: string, evictedAt: string, reason: string): void {
    closeAcpDelegate(this.sqlite, id, evictedAt, reason);
  }

  /** All rows where evicted_at IS NULL — i.e. delegates that were live when the daemon last ran.
   *  Used at startup to detect and kill orphaned adapter processes. */
  listLiveAcpDelegates(): AcpDelegateRow[] {
    return listLiveAcpDelegates(this.sqlite);
  }

  /** Recent delegate history for a session (live + evicted), newest first. */
  listAcpDelegatesForSession(sessionId: string, limit = 50): AcpDelegateRow[] {
    return listAcpDelegatesForSession(this.sqlite, sessionId, limit);
  }

  /** Delete rows evicted more than `olderThanMs` milliseconds ago. Returns deleted count. */
  pruneOldAcpDelegates(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    return pruneOldAcpDelegates(this.sqlite, olderThanMs);
  }

  /**
   * On daemon startup: close every delegate row that was live when the daemon last stopped (evicted_at
   * NULL), attempt to kill their adapter processes (best-effort — the PIDs may already be dead), and
   * mark them evicted. Returns how many rows were closed.
   *
   * Call ONCE, early, before any new delegates are spawned.
   */
  reconcileOrphanedDelegates(): number {
    return reconcileOrphanedDelegates(this.sqlite);
  }

  // ── External agent Session Ledger ─────────────────────────────────────────────────────────────────

  upsertMeshSession(row: Parameters<typeof upsertMeshSession>[1]): void {
    upsertMeshSession(this.sqlite, row);
  }

  getMeshSession(id: string): MeshSessionRow | null {
    return getMeshSession(this.sqlite, id);
  }

  listMeshSessionsForTranscriptTarget(transcriptTargetId: string): MeshSessionRow[] {
    return listMeshSessionsForTranscriptTarget(this.sqlite, transcriptTargetId);
  }

  listMeshSessions(): MeshSessionRow[] {
    return listMeshSessions(this.sqlite);
  }

  listLiveMeshSessions(): MeshSessionRow[] {
    return listLiveMeshSessions(this.sqlite);
  }

  replaceMeshAgentUsageSnapshot(input: Parameters<typeof replaceMeshAgentUsageSnapshot>[1]): void {
    replaceMeshAgentUsageSnapshot(this.sqlite, input);
  }

  upsertMeshSessionUsageSnapshot(
    session: MeshSessionRow,
    usage: Parameters<typeof upsertMeshSessionUsageSnapshot>[3],
    checkedAt?: string
  ): void {
    const projectId = this.getSession(session.transcriptTargetId)?.projectId ?? null;
    upsertMeshSessionUsageSnapshot(this.sqlite, session, projectId, usage, checkedAt);
  }

  listMeshUsageOverview(checkedAt?: string) {
    return listMeshUsageOverview(this.sqlite, checkedAt);
  }

  pruneExitedMeshSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    return pruneExitedMeshSessions(this.sqlite, olderThanMs);
  }

  updateMeshSessionRef(id: string, providerSessionRef: string): boolean {
    return updateMeshSessionRef(this.sqlite, id, providerSessionRef);
  }

  clearMeshSessionRef(id: string): boolean {
    return clearMeshSessionRef(this.sqlite, id);
  }

  setMeshAgentVisibleCursor(id: string, seq: number): boolean {
    return setMeshAgentVisibleCursor(this.sqlite, id, seq);
  }

  setMeshAgentDeliveredCursor(id: string, seq: number): boolean {
    return setMeshAgentDeliveredCursor(this.sqlite, id, seq);
  }

  enqueueMeshAgentInboxItem(
    meshSessionId: string,
    messageSeq: number,
    createdAtOrOptions: string | EnqueueMeshAgentInboxOptions = new Date().toISOString()
  ): boolean {
    return enqueueMeshAgentInboxItem(this.sqlite, meshSessionId, messageSeq, createdAtOrOptions);
  }

  enqueueNativeAgentIngressItem(input: EnqueueNativeAgentIngressInput): NativeAgentIngressItem {
    return enqueueNativeAgentIngressItem(this.sqlite, input);
  }

  bindNativeAgentIngressDelivery(
    deliveryId: NativeAgentDeliveryId,
    meshSessionId: string,
    providerSessionRef?: string | null,
    at?: string
  ): boolean {
    return bindNativeAgentIngressDelivery(this.sqlite, deliveryId, meshSessionId, providerSessionRef, at);
  }

  getNativeAgentIngressForDirectMessage(directMessageId: string): NativeAgentIngressItem | null {
    return getNativeAgentIngressForDirectMessage(this.sqlite, directMessageId);
  }

  getNativeAgentDirectMessage(id: string): NativeAgentDirectMessage | null {
    return getNativeAgentDirectMessage(this.sqlite, id);
  }

  claimNativeAgentIngressBatch(input: ClaimNativeAgentIngressBatchInput): ClaimedNativeAgentIngressBatch {
    return claimNativeAgentIngressBatch(this.sqlite, input);
  }

  claimNextNativeAgentIngressBatch(input: Omit<ClaimNativeAgentIngressBatchInput, 'id'> & { askRequestId: string }) {
    return claimNextNativeAgentIngressBatch(this.sqlite, input);
  }

  listClaimedNativeAgentIngress(batchId: string): ClaimedNativeAgentIngressItem[] {
    return listClaimedNativeAgentIngress(this.sqlite, batchId);
  }

  acknowledgeVisibleNativeAgentIngress(
    input: AcknowledgeVisibleNativeAgentIngressInput
  ): AcknowledgeVisibleNativeAgentIngressResult {
    return acknowledgeVisibleNativeAgentIngress(this.sqlite, input);
  }

  listNativeAgentProjectInbox(
    projectId: string,
    sessionId: string,
    memberInstanceId: string,
    limit = 50
  ): MeshAgentInboxItem[] {
    return listNativeAgentProjectInbox(this.sqlite, projectId, sessionId, memberInstanceId, limit);
  }

  consumeNativeAgentPendingInbox(
    projectId: string,
    sessionId: string,
    memberInstanceId: string,
    limit = 50
  ): NativeAgentPendingInboxItem[] {
    return consumeNativeAgentPendingInbox(this.sqlite, projectId, sessionId, memberInstanceId, limit);
  }

  consumeNativeAgentIngressBatch(batchId: string, at?: string): void {
    consumeNativeAgentIngressBatch(this.sqlite, batchId, at);
  }

  markNativeAgentIngressBatchDelivered(batchId: string, at?: string): boolean {
    return markNativeAgentIngressBatchDelivered(this.sqlite, batchId, at);
  }

  releaseNativeAgentIngressBatch(batchId: string, at?: string): void {
    releaseNativeAgentIngressBatch(this.sqlite, batchId, at);
  }

  reconcileNativeAgentIngressAfterRestart(at?: string): { consumed: number; released: number } {
    return reconcileNativeAgentIngressAfterRestart(this.sqlite, at);
  }

  reconcileNativeAgentMemberKeys(at?: string): ReconcileNativeAgentMemberKeysResult {
    return reconcileNativeAgentMemberKeys(this.sqlite, at);
  }

  listPendingNativeAgentIngressTargets(): PendingNativeAgentIngressTarget[] {
    return listPendingNativeAgentIngressTargets(this.sqlite);
  }

  createNativeAgentAsk(input: CreateNativeAgentAskInput): NativeAgentAskRecord {
    return createNativeAgentAsk(this.sqlite, input);
  }

  getNativeAgentAsk(requestId: string): NativeAgentAskRecord | null {
    return getNativeAgentAsk(this.sqlite, requestId);
  }

  getNativeAgentMemberGate(projectSessionId: string, memberInstanceId: string) {
    return getNativeAgentMemberGate(this.sqlite, projectSessionId, memberInstanceId);
  }

  settleNativeAgentAsk(input: SettleNativeAgentAskInput): boolean {
    return settleNativeAgentAsk(this.sqlite, input);
  }

  cancelNativeAgentAsk(input: CancelNativeAgentAskInput) {
    return cancelNativeAgentAsk(this.sqlite, input);
  }

  transitionNativeAgentMemberGate(
    requestId: string,
    from: import('./native-agent-asks.ts').NativeAgentAskState,
    to: import('./native-agent-asks.ts').NativeAgentAskState,
    at?: string
  ): boolean {
    return transitionNativeAgentMemberGate(this.sqlite, requestId, from, to, at);
  }

  reconcileNativeAgentAsksAfterRestart(at?: string): string[] {
    return reconcileNativeAgentAsksAfterRestart(this.sqlite, at);
  }

  finishNativeAgentAskRecovery(requestId: string, at?: string): boolean {
    return finishNativeAgentAskRecovery(this.sqlite, requestId, at);
  }

  markMeshAgentInboxDelivered(meshSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markMeshAgentInboxDelivered(this.sqlite, this.db, meshSessionId, cursor, at);
  }

  markMeshAgentInboxVisible(meshSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markMeshAgentInboxVisible(this.sqlite, this.db, meshSessionId, cursor, at);
  }

  markMeshAgentInboxConsumed(meshSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markMeshAgentInboxConsumed(this.sqlite, this.db, meshSessionId, cursor, at);
  }

  hasUnconsumedMeshAgentInbox(meshSessionId: string, cursor?: number): boolean {
    return hasUnconsumedMeshAgentInbox(this.sqlite, this.db, meshSessionId, cursor);
  }

  maxMessageSeq(sessionId: string): number {
    return maxMessageSeq(this.sqlite, sessionId);
  }

  maxMessageCreatedAt(sessionId: string): string | null {
    return maxMessageCreatedAt(this.sqlite, sessionId);
  }

  messageIdForSeq(transcriptTargetId: SessionId, seq: number): MessageId | null {
    return messageIdForSeq(this.sqlite, transcriptTargetId, seq);
  }

  listMeshAgentInbox(meshSessionId: string, limit = 50): MeshAgentInboxItem[] {
    return listMeshAgentInbox(this.sqlite, this.db, meshSessionId, limit);
  }

  listMentionInbox(limit = 100): InboxItem[] {
    return listMentionInbox(this.sqlite, limit);
  }

  listOperatorInbox(query: import('@monad/protocol').ListInboxQuery = {}) {
    return listOperatorInbox(this.sqlite, query);
  }

  operatorInboxSummary() {
    return operatorInboxSummary(this.sqlite);
  }

  markOperatorInboxRead(itemKeys: string[], readAt?: string) {
    return markOperatorInboxRead(this.sqlite, itemKeys, readAt);
  }

  markOperatorInboxUnread(itemKeys: string[]) {
    return markOperatorInboxUnread(this.sqlite, itemKeys);
  }

  markAllOperatorInboxRead(readAt?: string) {
    return markAllOperatorInboxRead(this.sqlite, readAt);
  }

  countMeshAgentInbox(meshSessionId: string): number {
    return countMeshAgentInbox(this.sqlite, this.db, meshSessionId);
  }

  meshAgentInboxCursor(meshSessionId: string): { deliveredSeq: number; visibleSeq: number } {
    return meshAgentInboxCursor(this.sqlite, this.db, meshSessionId);
  }

  getNativeAgentDelivery(deliveryId: NativeAgentDeliveryId): NativeAgentDelivery | null {
    return getNativeAgentDelivery(this.sqlite, deliveryId);
  }

  insertNativeAgentDirectMessage(
    row: NativeAgentDirectMessage,
    identity?: import('./native-agent-messages.ts').NativeAgentDirectMessageRequestIdentity
  ): import('./native-agent-messages.ts').NativeAgentDirectMessageInsertResult {
    return insertNativeAgentDirectMessage(this.sqlite, row, identity);
  }

  /** Register a message's file reference. Only the reference + a metadata snapshot is stored;
   *  content stays in the file. Registration also gates the wall preview/download endpoint. */
  registerMessageAttachment(att: MessageAttachmentInsert): MessageAttachmentRef {
    return registerMessageAttachment(this.sqlite, att);
  }

  /** Register a message's file references atomically: either all rows land or none. */
  registerMessageAttachments(atts: readonly MessageAttachmentInsert[]): MessageAttachmentRef[] {
    return registerMessageAttachments(this.sqlite, atts);
  }

  /** Roll back registrations whose message never landed (keeps the "registered = referenced by a
   *  message" gate on the client-facing read endpoint honest). */
  deleteMessageAttachments(ids: readonly string[]): void {
    deleteMessageAttachments(this.sqlite, ids);
  }

  getMessageAttachment(id: string): MessageAttachmentDetail | null {
    return getMessageAttachment(this.sqlite, id);
  }

  /** Batch-hydrate refs for a set of ids in one query (column-projected — no preview blobs).
   *  Missing ids are simply absent from the map. */
  getMessageAttachmentRefs(ids: readonly string[]): Map<string, MessageAttachmentRef> {
    return getMessageAttachmentRefs(this.sqlite, ids);
  }

  listNativeAgentDirectMessages(
    meshSessionId: string,
    peer: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): NativeAgentDirectMessage[] {
    return listNativeAgentDirectMessages(this.sqlite, meshSessionId, peer, opts);
  }

  closeMeshSession(
    id: string,
    exitedAt: string,
    exitCode: number | null,
    state: 'exited' | 'failed' | 'stopped' = 'exited'
  ): boolean {
    return closeMeshSession(this.sqlite, id, exitedAt, exitCode, state);
  }

  reconcileOrphanedMeshSessions(killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): number {
    return reconcileOrphanedMeshSessions(this.sqlite, killPid);
  }

  close(): void {
    if (this.#checkpoint) {
      stopWalCheckpoint(this.#checkpoint);
      this.#checkpoint = undefined;
    }
    this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    (this.sqlite as Database & { clearQueryCache(): void }).clearQueryCache();
    if (this.fileBacked && process.platform === 'win32') Bun.gc(true);
    this.sqlite.close();
  }
}

export function createStore(opts?: StoreOptions): Store {
  return new Store(opts);
}

export { factId, MemoryDir, projectKey, scopeOf } from './memory-dir.ts';
