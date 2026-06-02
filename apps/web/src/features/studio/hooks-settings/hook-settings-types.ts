export interface DraftCommand {
  _id: number;
  command: string;
  timeoutMs?: number;
  onError?: 'allow' | 'deny';
}

export interface DraftMatcher {
  _id: number;
  matcher?: string;
  hooks: DraftCommand[];
}
