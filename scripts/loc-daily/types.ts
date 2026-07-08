export type LocRowType = 'actual' | 'estimated';

export interface LocRow {
  date: string;
  files?: number;
  lines: number;
  note: string;
  type: LocRowType;
}

export interface Snapshot {
  commit: string;
  files: number;
  lines: number;
}
