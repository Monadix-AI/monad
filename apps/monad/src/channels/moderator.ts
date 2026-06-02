import type { MonadConfig } from '@monad/home';
import type { ChannelInbound, ChannelResponseNextTarget } from '@monad/protocol';
import type { ChannelLogger, ChannelRoute, Instance } from '@/channels/channel.ts';
import type { ChannelModeratorRoundResult, ChannelModeratorRoundTask, Store } from '@/store/db/index.ts';

import { newId, parseChannelStructuredResponse } from '@monad/protocol';

import { errMsg } from '@/channels/helpers.ts';

const MODERATOR_LOOP_MAX_DEPTH = 8;
const DEFAULT_MODERATOR_TASK_TIMEOUT_MS = 120_000;
const MODERATOR_MAX_PARALLEL_TASKS = 8;

interface ModeratorRound {
  id: string;
  expected: number;
  results: Map<number, ChannelModeratorRoundResult>;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(results: ChannelModeratorRoundResult[]): void;
}

export interface ModeratorRuntime {
  cfg(): MonadConfig;
  store: Store;
  log: ChannelLogger;
  moderatorTaskTimeoutMs?: number;
  rounds: Map<string, ModeratorRound>;
  deriveKey(c: Instance['config'], m: ChannelInbound, agentId?: string): string;
  serialize<T>(inst: Instance, key: string, fn: () => Promise<T>): Promise<T>;
  dispatch(
    inst: Instance,
    m: ChannelInbound,
    key: string,
    route: ChannelRoute,
    moderatorDepth: number
  ): Promise<string | undefined>;
}

export async function dispatchAgentResultToModerator(
  runtime: ModeratorRuntime,
  inst: Instance,
  original: ChannelInbound,
  agentKey: string,
  route: Extract<ChannelRoute, { kind: 'agent' }>,
  result: string
): Promise<void> {
  if (!inst.adapter) return;
  const moderatorKey = runtime.deriveKey(inst.config, original, route.moderatorAgentId);
  const moderatorInput = [
    `Agent ${route.agentName} returned a channel-visible result.`,
    `Original user message: ${original.text}`,
    `Agent result: ${result}`,
    '',
    'Decide whether the channel needs another task assignment. If no further work is needed, respond with a concise display update and do not assign new work.'
  ].join('\n');
  await runtime.serialize(inst, moderatorKey, async () => {
    const synthetic: ChannelInbound = {
      ...original,
      text: moderatorInput,
      nativeMessageId: `${original.nativeMessageId}:moderator:${route.agentId}`
    };
    await runtime.dispatch(
      inst,
      synthetic,
      moderatorKey,
      {
        kind: 'moderator',
        agentId: route.moderatorAgentId
      },
      0
    );
  });
  runtime.log.info(`channel "${inst.config.id}": routed agent result from ${agentKey} to moderator`);
}

export async function dispatchModeratorNextTargets(
  runtime: ModeratorRuntime,
  inst: Instance,
  original: ChannelInbound,
  moderatorKey: string,
  route: Extract<ChannelRoute, { kind: 'moderator' }>,
  moderatorText: string,
  depth: number
): Promise<void> {
  if (depth >= MODERATOR_LOOP_MAX_DEPTH) {
    runtime.log.warn(`channel "${inst.config.id}": moderator loop stopped at depth ${depth}`);
    return;
  }
  const structured = parseChannelStructuredResponse(moderatorText);
  const next = structured?.next ?? [];
  if (next.length === 0) return;

  const runnable = next
    .flatMap((task) => {
      if (task.agentId === route.agentId) {
        runtime.log.warn(`channel "${inst.config.id}": moderator next target cannot be the moderator itself`);
        return [];
      }
      const agent = runtime.cfg().agent.agents.find((a) => a.id === task.agentId);
      if (!agent) {
        runtime.log.warn(`channel "${inst.config.id}": moderator next target ${task.agentId} is not configured`);
        return [];
      }
      return agent ? [{ task, agent }] : [];
    })
    .slice(0, MODERATOR_MAX_PARALLEL_TASKS);
  if (next.length > MODERATOR_MAX_PARALLEL_TASKS) {
    runtime.log.warn(
      `channel "${inst.config.id}": moderator next produced ${next.length} tasks; only the first ${MODERATOR_MAX_PARALLEL_TASKS} runnable tasks will run`
    );
  }
  if (runnable.length === 0) return;

  const results = await runModeratorRound(
    runtime,
    inst,
    original,
    depth,
    route.agentId,
    moderatorKey,
    runnable.map(({ task, agent }) => ({ task, agentId: agent.id, agentName: agent.name }))
  );

  const moderatorInput = moderatorContinuationInput(original, results);
  const synthetic: ChannelInbound = {
    ...original,
    text: moderatorInput,
    nativeMessageId: `${original.nativeMessageId}:moderator-continuation:${depth}`
  };
  await runtime.dispatch(inst, synthetic, moderatorKey, route, depth + 1);
}

export async function recoverOpenModeratorRounds(runtime: ModeratorRuntime, inst: Instance): Promise<void> {
  if (!inst.adapter) return;
  const rows = runtime.store.listOpenChannelModeratorRounds(inst.config.id);
  for (const row of rows) {
    const byIndex = new Map(row.results.map((r) => [r.index, r]));
    const recoveredResults = row.tasks
      .map((task) => {
        const existing = byIndex.get(task.index);
        if (existing) return existing;
        return {
          index: task.index,
          agentId: task.agentId,
          agentName: task.agentName,
          title: task.title,
          result: '(daemon restarted before agent result was observed)',
          timedOut: true
        };
      })
      .sort((a, b) => a.index - b.index);
    runtime.store.settleChannelModeratorRound(row.id, recoveredResults);
    const synthetic: ChannelInbound = {
      ...row.originalInbound,
      text: moderatorContinuationInput(row.originalInbound, recoveredResults, true),
      nativeMessageId: `${row.originalInbound.nativeMessageId}:moderator-recovered:${row.id}`
    };
    await runtime.serialize(inst, row.moderatorKey, () =>
      runtime.dispatch(
        inst,
        synthetic,
        row.moderatorKey,
        { kind: 'moderator', agentId: row.moderatorAgentId },
        row.depth + 1
      )
    );
  }
}

function moderatorContinuationInput(
  original: ChannelInbound,
  results: ChannelModeratorRoundResult[],
  recovered = false
): string {
  return [
    recovered
      ? 'A previously open moderator task batch was recovered after daemon restart.'
      : 'A batch of moderator-assigned tasks returned channel-visible results.',
    `Original user message: ${original.text}`,
    '',
    ...results.map((r, i) =>
      [
        `Task ${i + 1}: ${r.title ?? r.agentName} (${r.agentId})`,
        r.timedOut ? 'Status: incomplete' : 'Status: returned',
        `Agent result: ${r.result || '(no display content)'}`
      ].join('\n')
    ),
    '',
    recovered
      ? 'The daemon restarted before every assigned task could be observed. Decide whether another independent task batch is needed. Do not assume missing work completed.'
      : 'All tasks in this batch have returned. Decide whether another independent task batch is needed. If no further work is needed, respond with a concise display update and next: [].'
  ].join('\n');
}

function taskInput(original: ChannelInbound, task: ChannelResponseNextTarget, index: number): string {
  return [
    `Moderator assigned task ${index + 1}.`,
    task.title ? `Title: ${task.title}` : undefined,
    `Task: ${task.prompt}`,
    task.context ? `Context: ${task.context}` : undefined,
    `Original user message: ${original.text}`,
    '',
    'Return a structured channel response. Put the user-visible task result in display.content and use next: [].'
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function runModeratorRound(
  runtime: ModeratorRuntime,
  inst: Instance,
  original: ChannelInbound,
  depth: number,
  moderatorAgentId: string,
  moderatorKey: string,
  tasks: { task: ChannelResponseNextTarget; agentId: string; agentName: string }[]
): Promise<ChannelModeratorRoundResult[]> {
  const roundId = `${inst.config.id}:${original.nativeMessageId}:${depth}:${newId('evt')}`;
  const timeoutMs = runtime.moderatorTaskTimeoutMs ?? DEFAULT_MODERATOR_TASK_TIMEOUT_MS;
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const persistedTasks: ChannelModeratorRoundTask[] = tasks.map(({ task, agentId, agentName }, index) => ({
    index,
    agentId,
    agentName,
    title: task.title,
    task
  }));
  runtime.store.createChannelModeratorRound({
    id: roundId,
    channelId: inst.config.id,
    moderatorKey,
    moderatorAgentId,
    originalInbound: original,
    depth,
    tasks: persistedTasks,
    deadlineAt
  });
  return new Promise((resolve) => {
    const finish = () => {
      if (round.settled) return;
      round.settled = true;
      clearTimeout(round.timer);
      runtime.rounds.delete(roundId);
      const results = [...round.results.values()].sort((a, b) => a.index - b.index);
      runtime.store.settleChannelModeratorRound(roundId, results);
      resolve(results);
    };
    const round: ModeratorRound = {
      id: roundId,
      expected: tasks.length,
      results: new Map(),
      settled: false,
      timer: setTimeout(() => {
        for (const [index, { task, agentId, agentName }] of tasks.entries()) {
          if (!round.results.has(index)) {
            round.results.set(index, {
              index,
              agentId,
              agentName,
              title: task.title,
              result: '(timed out waiting for agent result)',
              timedOut: true
            });
          }
        }
        runtime.log.warn(`channel "${inst.config.id}": moderator round ${round.id} timed out`);
        finish();
      }, timeoutMs),
      resolve
    };
    round.timer.unref?.();
    runtime.rounds.set(roundId, round);

    for (const [index, { task, agentId, agentName }] of tasks.entries()) {
      void runModeratorTask(runtime, inst, original, depth, index, task, agentId, agentName)
        .then((result) => {
          if (round.settled) return;
          round.results.set(index, result);
          runtime.store.updateChannelModeratorRoundResults(
            roundId,
            [...round.results.values()].sort((a, b) => a.index - b.index)
          );
          if (round.results.size >= round.expected) finish();
        })
        .catch((err: unknown) => {
          if (round.settled) return;
          round.results.set(index, {
            index,
            agentId,
            agentName,
            title: task.title,
            result: `error: ${errMsg(err)}`
          });
          runtime.store.updateChannelModeratorRoundResults(
            roundId,
            [...round.results.values()].sort((a, b) => a.index - b.index)
          );
          if (round.results.size >= round.expected) finish();
        });
    }
  });
}

async function runModeratorTask(
  runtime: ModeratorRuntime,
  inst: Instance,
  original: ChannelInbound,
  depth: number,
  index: number,
  task: ChannelResponseNextTarget,
  agentId: string,
  agentName: string
): Promise<ChannelModeratorRoundResult> {
  const input = taskInput(original, task, index);
  const agentKey = runtime.deriveKey(inst.config, original, agentId);
  const synthetic: ChannelInbound = {
    ...original,
    text: input,
    nativeMessageId: `${original.nativeMessageId}:task:${depth}:${index}:${agentId}`
  };
  const result = await runtime.serialize(inst, agentKey, () =>
    runtime.dispatch(inst, synthetic, agentKey, { kind: 'agent_direct', agentId, agentName }, depth)
  );
  return { index, agentId, agentName, title: task.title, result: result ?? '' };
}
