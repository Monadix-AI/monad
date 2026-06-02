export type ConfigSnapshotDocument = 'config' | 'agents' | 'mesh' | 'auth';
export type ConfigSnapshotPhase = 'prepared' | 'committed';

type DocumentWriteKind = 'stage' | 'rollback';
type SecureWriteStep =
  | `${DocumentWriteKind}:${ConfigSnapshotDocument}:created-secure`
  | `${DocumentWriteKind}:${ConfigSnapshotDocument}:written`
  | `${DocumentWriteKind}:${ConfigSnapshotDocument}:synced`
  | `${DocumentWriteKind}:${ConfigSnapshotDocument}:directory-synced`;
type ManifestStep =
  | `manifest:${ConfigSnapshotPhase}:created-secure`
  | `manifest:${ConfigSnapshotPhase}:written`
  | `manifest:${ConfigSnapshotPhase}:synced`
  | `manifest:${ConfigSnapshotPhase}:temp-directory-synced`
  | `manifest:${ConfigSnapshotPhase}:installed`
  | `manifest:${ConfigSnapshotPhase}:directory-synced`;
type ConflictStep =
  | 'conflict:created-secure'
  | 'conflict:written'
  | 'conflict:synced'
  | 'conflict:temp-directory-synced'
  | 'conflict:installed'
  | 'conflict:directory-synced';
type DocumentInstallStep =
  | `install:${ConfigSnapshotDocument}:linked`
  | `install:${ConfigSnapshotDocument}:stage-removed`
  | `install:${ConfigSnapshotDocument}:directory-synced`;
type DocumentCheckStep =
  | `check:${ConfigSnapshotDocument}:final`
  | `check:${ConfigSnapshotDocument}:claimed`
  | `check:${ConfigSnapshotDocument}:retained`
  | `check:${ConfigSnapshotDocument}:precommit`;
type DocumentClaimStep = `claim:${ConfigSnapshotDocument}:renamed` | `claim:${ConfigSnapshotDocument}:directory-synced`;
type CleanupStep =
  | `cleanup:${ConfigSnapshotDocument}:removed`
  | `cleanup:${ConfigSnapshotDocument}:directory-synced`
  | `cleanup:manifest:${ConfigSnapshotPhase}-removed`
  | `cleanup:manifest:${ConfigSnapshotPhase}-directory-synced`;
type RecoveryStep =
  | `recovery:${ConfigSnapshotDocument}:target-restored`
  | `recovery:${ConfigSnapshotDocument}:target-removed`
  | `recovery:${ConfigSnapshotDocument}:target-directory-synced`
  | `recovery:${ConfigSnapshotDocument}:stage-removed`
  | `recovery:${ConfigSnapshotDocument}:stage-directory-synced`
  | `recovery:${ConfigSnapshotDocument}:backup-removed`
  | `recovery:${ConfigSnapshotDocument}:backup-directory-synced`
  | `recovery:manifest:${ConfigSnapshotPhase}-removed`
  | `recovery:manifest:${ConfigSnapshotPhase}-directory-synced`
  | `recovery:manifest:${ConfigSnapshotPhase}-temp-removed`
  | `recovery:manifest:${ConfigSnapshotPhase}-temp-directory-synced`;

export type ConfigSnapshotTransactionStep =
  | SecureWriteStep
  | ManifestStep
  | ConflictStep
  | DocumentCheckStep
  | DocumentClaimStep
  | DocumentInstallStep
  | CleanupStep
  | RecoveryStep;

export interface ConfigSnapshotTransactionOptions {
  afterStep?(step: ConfigSnapshotTransactionStep): void | Promise<void>;
  recoverOnFailure?: boolean;
}

export interface ConfigSnapshotTransactionDocument {
  name: ConfigSnapshotDocument;
  target: string;
  previousContent: string | null;
  nextContent: string;
  normalize(content: string): string;
}

export interface ConfigSnapshotTransactionLayout {
  home: string;
  manifestPath: string;
  documents: Array<Pick<ConfigSnapshotTransactionDocument, 'name' | 'target'>>;
}
