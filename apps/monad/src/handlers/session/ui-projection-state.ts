import type { Translate } from '@monad/i18n';
import type { ExternalAgentSessionId, SessionUiEvent, UIItem, UIMessageItem } from '@monad/protocol';

interface ChannelDisplayCacheEntry {
  len: number;
  text: string;
}

interface SetCustomArgs {
  id: string;
  name: string;
  data?: unknown;
  status?: 'streaming' | 'done' | 'error';
  seq?: string;
}

export interface ProjectionMutations {
  readonly opts: { channelStructured?: boolean };
  readonly t: Translate;
  readonly items: Map<string, UIItem>;
  readonly rawStreamingText: Map<string, string>;
  readonly channelDisplayCache: Map<string, ChannelDisplayCacheEntry>;
  upsert(item: UIItem): UIItem;
  remove(kind: 'message' | 'approval' | 'clarification' | 'custom' | 'tool', id: string): SessionUiEvent;
  setMessage(item: UIMessageItem): SessionUiEvent;
  setCustom(args: SetCustomArgs): SessionUiEvent;
  findMessage(id: string): UIMessageItem | undefined;
  messageObservationPointers(
    payload: { externalAgentSessionId?: ExternalAgentSessionId; deliveryId?: `deliv_${string}` },
    existing?: UIMessageItem
  ): Pick<UIMessageItem, 'externalAgentSessionId' | 'deliveryId'>;
  clearItems(): SessionUiEvent;
}
