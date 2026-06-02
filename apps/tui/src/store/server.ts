import type { Session, SessionId } from '@monad/protocol';

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type { Session };

interface ToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  done: boolean;
  failed: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCall[];
  at: string;
}

interface ServerState {
  sessions: Session[];
  currentSessionId: SessionId | null;
  transcripts: Record<string, Message[]>;
  streaming: string;
  isStreaming: boolean;
  pendingTools: ToolCall[];
}

const initialState: ServerState = {
  sessions: [],
  currentSessionId: null,
  transcripts: {},
  streaming: '',
  isStreaming: false,
  pendingTools: []
};

export const serverSlice = createSlice({
  name: 'server',
  initialState,
  reducers: {
    setSessions(state, action: PayloadAction<Session[]>) {
      state.sessions = action.payload;
    },
    upsertSession(state, action: PayloadAction<Session>) {
      const idx = state.sessions.findIndex((s) => s.id === action.payload.id);
      if (idx >= 0) state.sessions[idx] = action.payload;
      else state.sessions.unshift(action.payload);
    },
    switchSession(state, action: PayloadAction<SessionId>) {
      state.currentSessionId = action.payload;
      state.streaming = '';
      state.isStreaming = false;
      state.pendingTools = [];
      if (!state.transcripts[action.payload]) {
        state.transcripts[action.payload] = [];
      }
    },
    addUserMessage(state, action: PayloadAction<string>) {
      const sid = state.currentSessionId;
      if (!sid) return;
      state.transcripts[sid] ??= [];
      const transcript = state.transcripts[sid];
      transcript.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: action.payload,
        toolCalls: [],
        at: new Date().toISOString()
      });
    },
    appendToken(state, action: PayloadAction<string>) {
      state.streaming += action.payload;
      state.isStreaming = true;
    },
    commitMessage(state, action: PayloadAction<string | undefined>) {
      const sid = state.currentSessionId;
      if (!sid) return;
      const content = action.payload ?? state.streaming;
      if (content) {
        state.transcripts[sid] ??= [];
        const transcript = state.transcripts[sid];
        transcript.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          toolCalls: state.pendingTools.filter((t) => t.done),
          at: new Date().toISOString()
        });
      }
      state.streaming = '';
      state.isStreaming = false;
      state.pendingTools = state.pendingTools.filter((t) => !t.done);
    },
    toolCalled(state, action: PayloadAction<{ id: string; name: string; args?: Record<string, unknown> }>) {
      state.pendingTools.push({ ...action.payload, done: false, failed: false });
    },
    toolResult(state, action: PayloadAction<{ id: string; result: unknown; failed?: boolean }>) {
      const tool = state.pendingTools.find((t) => t.id === action.payload.id);
      if (tool) {
        tool.result = action.payload.result;
        tool.done = true;
        tool.failed = action.payload.failed ?? false;
      }
    }
  }
});

export const { setSessions, upsertSession, switchSession, addUserMessage, appendToken, commitMessage } =
  serverSlice.actions;
