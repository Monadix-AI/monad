// Minimal ACP AGENT (the side monad drives as a client in agent_acp_delegate). Speaks ACP over
// stdio via the SDK's agent() builder: initialize → session/new → session/prompt, answering a
// prompt by streaming one agent_message_chunk that echoes the instruction, then ending the turn.

import type { PromptRequest } from '@agentclientprotocol/sdk';

import { agent as createAcpAgent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

function promptText(prompt: PromptRequest['prompt']): string {
  return prompt
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

// MCP server names monad forwarded via newSession — echoed back on the `mcp` prompt to prove forwarding.
let forwardedMcp: string[] = [];

// Per-PROCESS prompt counter — echoed on the `count` prompt. A reused delegate (same process + same
// ACP session) increments across turns (count: 1, 2, …); a freshly spawned one restarts at 1, so the
// multi-turn-reuse + eviction tests can tell continuation from a re-spawn.
let promptCount = 0;

// How many times session/new was called in THIS process — echoed on the `sessions` prompt. Reuse must
// drive successive prompts on ONE session (sessions: 1 across many turns); a regression that re-issues
// session/new per turn (discarding the sub-agent's context) would show sessions > 1.
let sessionNewCount = 0;

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  }
});

const stream = ndJsonStream(output, Bun.stdin.stream());

await createAcpAgent({ name: 'mock-acp' })
  .onRequest('initialize', async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'mock-acp', version: '0.0.0' },
    // Advertise http MCP support so the forwarding test exercises both stdio + http forwarding.
    agentCapabilities: { mcpCapabilities: { http: true } }
  }))
  .onRequest('authenticate', async () => {})
  .onRequest('session/new', async ({ params }) => {
    forwardedMcp = (params.mcpServers ?? []).map((s) => s.name);
    sessionNewCount += 1;
    return { sessionId: 'mock-acp-session' };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = promptText(params.prompt);
    let reply = `mock-acp handled: ${text}`;
    // `mcp` echoes the MCP server names monad forwarded via newSession (proves tool forwarding).
    if (text === 'mcp' || text.includes('\nmcp\n</channel_user_message>')) reply = `mcp: ${forwardedMcp.join(',')}`;
    // `count` echoes a per-process turn counter (proves multi-turn reuse vs a re-spawn).
    if (text === 'count') reply = `count: ${++promptCount}`;
    // `sessions` echoes how many times session/new was called (proves ONE continued session, not re-handshake).
    if (text === 'sessions') reply = `sessions: ${sessionNewCount}`;
    if (text.includes('structured-next')) {
      reply = JSON.stringify({
        display: { kind: 'markdown', content: 'ACP host assigned the task.' },
        attachments: [],
        next: [{ agentId: 'acp:codex', title: 'Echo delegated task', prompt: 'count', context: 'structured-next' }]
      });
    }
    // `read <path>` exercises monad-served fs (the client reads via monad's sandbox/backend).
    if (text.startsWith('read ')) {
      const { content } = await client.request('fs/read_text_file', {
        sessionId: params.sessionId,
        path: text.slice(5).trim(),
        line: null,
        limit: null
      });
      reply = `read: ${content}`;
    } else if (text.startsWith('term ')) {
      // exercises monad-served terminal via raw protocol calls (create → wait → output → release).
      const { terminalId } = await client.request('terminal/create', {
        sessionId: params.sessionId,
        command: 'sh',
        args: ['-c', text.slice(5).trim()]
      });
      await client.request('terminal/wait_for_exit', { terminalId, sessionId: params.sessionId });
      const out = await client.request('terminal/output', { terminalId, sessionId: params.sessionId });
      await client.request('terminal/release', { terminalId, sessionId: params.sessionId });
      reply = `term: ${out.output.trim()}`;
    } else if (text === 'plan') {
      // emits a plan update so the connector surfaces the sub-agent's checklist via reportProgress.
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'investigate the bug', priority: 'high', status: 'in_progress' },
            { content: 'write the fix', priority: 'medium', status: 'pending' }
          ]
        }
      });
      reply = 'planned';
    } else if (text === 'toolcall') {
      // emits a tool_call update so the connector surfaces sub-agent activity via reportProgress.
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub-tc-1',
          title: 'sub-fs-read',
          kind: 'read',
          status: 'pending'
        }
      });
      reply = 'used a tool';
    } else if (text.startsWith('perm')) {
      // exercises the permission round-trip → monad's oversight gate.
      const { outcome } = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tc', title: 'danger', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      });
      reply = `perm: ${outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome}`;
    }
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification('session/cancel', () => {})
  .connect(stream).closed;
