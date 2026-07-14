// Power Pack Kanban workspace experience. Business state is loaded exclusively from the pack's
// private API; the browser receives no daemon capability objects and imports no host framework.
const UPDATE_EVENT = 'monad-workspace-experience:update';
const LANES = [
  { id: 'requirements', title: 'Requirements', description: 'Discuss and approve a proposal' },
  { id: 'execution', title: 'Execution', description: 'Autopilot work and approvals' },
  { id: 'acceptance', title: 'Acceptance', description: 'Evidence and human review' }
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusLabel(task) {
  if (task.stage === 'requirements')
    return task.requirementsState === 'proposal_awaiting_approval' ? 'Proposal ready' : 'Discussing';
  if (task.stage === 'execution') return String(task.executionState ?? 'Queued').replaceAll('_', ' ');
  return task.stage === 'acceptance' ? 'Ready for review' : task.stage;
}

function taskCard(task) {
  return `<button class="task-card" type="button" role="option" aria-selected="false" data-task-id="${escapeHtml(task.id)}">
    <span class="task-title">${escapeHtml(task.title)}</span>
    <span class="task-meta"><span class="status-dot" data-state="${escapeHtml(task.executionState ?? task.requirementsState)}"></span>${escapeHtml(statusLabel(task))}</span>
    <span class="task-foot">v${escapeHtml(task.version)}${task.executionIteration ? ` · iteration ${escapeHtml(task.executionIteration)}` : ''}</span>
  </button>`;
}

export function renderBoardMarkup(tasks = [], nextCursor = null) {
  const active = tasks.filter((task) => LANES.some((lane) => lane.id === task.stage));
  return `<main class="board" aria-label="Project lifecycle Kanban">
    <header class="board-header">
      <div><p class="eyebrow">PROJECT AUTOPILOT</p><h1>Requirements → Execution → Acceptance</h1></div>
      <button type="button" class="primary" data-action="new-task">New task</button>
    </header>
    <div class="lanes">
      ${LANES.map((lane) => {
        const laneTasks = active.filter((task) => task.stage === lane.id);
        return `<section class="lane" data-lane="${lane.id}" aria-labelledby="lane-${lane.id}">
          <header><div><h2 id="lane-${lane.id}">${lane.title}</h2><p>${lane.description}</p></div><span class="count">${laneTasks.length}</span></header>
          <div class="cards" role="listbox" aria-label="${lane.title} tasks">
            ${laneTasks.length ? laneTasks.map(taskCard).join('') : '<p class="empty">No tasks in this stage</p>'}
          </div>
        </section>`;
      }).join('')}
    </div>${nextCursor ? '<button type="button" class="load-more" data-action="load-more-tasks">Load more tasks</button>' : ''}
  </main>`;
}

function timeline(items, empty) {
  if (!items?.length) return `<p class="empty panel-empty">${empty}</p>`;
  return `<ol class="timeline">${items
    .map(
      (item) =>
        `<li><div class="timeline-kind">${escapeHtml(item.role ?? item.kind ?? 'event')}</div><p>${escapeHtml(item.text)}</p><time>${escapeHtml(item.createdAt ?? '')}</time></li>`
    )
    .join('')}</ol>`;
}

function proposals(task) {
  const proposal = task.proposals?.at(-1);
  if (!proposal) return '<p class="empty panel-empty">No proposal submitted yet</p>';
  return `<section class="proposal"><h3>Proposal r${escapeHtml(proposal.revision)}</h3><p>${escapeHtml(proposal.summary)}</p>
    <ul>${(proposal.acceptanceCriteria ?? []).map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join('')}</ul></section>`;
}

function artifacts(task) {
  const refs = (task.runs ?? []).flatMap((run) => run.artifactRefs ?? []);
  if (!refs.length) return '<p class="empty panel-empty">No artifacts reported</p>';
  return `<ul class="artifacts">${refs.map((ref) => `<li><span>${escapeHtml(ref.kind)}</span><a href="${escapeHtml(ref.uri)}">${escapeHtml(ref.label)}</a></li>`).join('')}</ul>`;
}

export function renderInspectorMarkup(task, panel = {}) {
  if (!task) return '';
  let content = '';
  if (task.stage === 'requirements') {
    const proposalActions =
      task.requirementsState === 'proposal_awaiting_approval'
        ? `<div class="action-row"><button type="button" class="primary" data-action="decide-proposal" data-decision="approve">Approve proposal</button><button type="button" data-action="decide-proposal" data-decision="reject">Keep discussing</button></div>`
        : '';
    content = `<section><div class="section-title"><h3>Task discussion</h3><span>Complete transcript</span></div>${timeline(panel.messages, 'Start the discussion below')}</section>
      <form class="composer" data-action="send-message"><textarea name="message" required placeholder="Discuss requirements with AI…"></textarea><button class="primary" type="submit">Send</button></form>
      ${proposals(task)}
      <form class="proposal-form" data-action="submit-proposal"><label>Proposal summary<textarea name="summary" required placeholder="What will be delivered"></textarea></label><label>Acceptance criteria<textarea name="criteria" required placeholder="One criterion per line"></textarea></label><button type="submit">Submit proposal</button></form>${proposalActions}`;
  } else if (task.stage === 'execution') {
    const approvalMarkup = (panel.approvals ?? [])
      .map(
        (approval) =>
          `<article class="approval"><div><strong>Approval required</strong><p>${escapeHtml(approval.summary)}</p></div><div class="action-row"><button type="button" class="primary" data-action="resolve-approval" data-approval-id="${escapeHtml(approval.id)}" data-decision="approved">Approve</button><button type="button" data-action="resolve-approval" data-approval-id="${escapeHtml(approval.id)}" data-decision="denied">Deny</button></div></article>`
      )
      .join('');
    content = `<section><div class="section-title"><h3>Execution observation</h3><span>Iteration ${escapeHtml(task.executionIteration ?? 0)}</span></div>${approvalMarkup}${timeline(panel.observations, 'Waiting for execution events')}</section>
      <div class="action-row sticky-actions"><button type="button" data-action="execution-control" data-control="${task.executionState === 'paused' ? 'resume' : 'pause'}">${task.executionState === 'paused' ? 'Resume' : 'Pause'}</button><button type="button" class="danger" data-action="execution-control" data-control="cancel">Cancel</button></div>`;
  } else {
    content = `${proposals(task)}<section><div class="section-title"><h3>Artifacts & evidence</h3><span>${escapeHtml(task.runs?.length ?? 0)} runs</span></div>${artifacts(task)}${timeline(panel.observations, 'No execution evidence')}</section>
      <div class="action-row"><button type="button" class="primary" data-action="accept-task">Accept</button></div>
      <form class="return-form" data-action="return-task"><textarea name="reason" required placeholder="What needs revision?"></textarea><button type="submit">Return to execution</button></form>`;
  }
  const more = panel.nextCursor
    ? '<button type="button" data-action="load-more-panel">Load older activity</button>'
    : '';
  return `<aside class="inspector" aria-label="Task details" data-stage="${escapeHtml(task.stage)}">
    <header class="inspector-header"><div><span class="stage-pill">${escapeHtml(task.stage)}</span><h2>${escapeHtml(task.title)}</h2><p>${escapeHtml(statusLabel(task))}</p></div><button type="button" class="icon-button" data-action="close-inspector" aria-label="Close task details">×</button></header>
    <div class="inspector-body">${content}${more}</div>
    <footer><button type="button" data-action="open-session">Open full session</button></footer>
  </aside>`;
}

const STYLES = `<style>
  :host{display:block;position:relative;min-width:0;min-height:0;height:100%;color:var(--foreground,#18181b);background:var(--background,#f7f7f5);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}.board{height:100%;box-sizing:border-box;padding:24px;overflow:auto}.board-header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.eyebrow{margin:0 0 5px;color:var(--muted-foreground,#71717a);font-size:10px;font-weight:700;letter-spacing:.14em}.board h1{margin:0;font-size:22px;line-height:1.2;letter-spacing:-.025em}.lanes{display:grid;grid-template-columns:repeat(3,minmax(250px,1fr));gap:14px;min-height:calc(100% - 78px)}.lane{min-width:0;padding:14px;border:1px solid var(--border,#e4e4e7);border-radius:14px;background:color-mix(in srgb,var(--card,#fff) 88%,transparent)}.lane>header{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}.lane h2{margin:0;font-size:13px}.lane header p{margin:3px 0 0;color:var(--muted-foreground,#71717a);font-size:11px}.count{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--muted,#f1f1f1);font-size:11px}.cards{display:grid;gap:9px}.task-card{display:grid;width:100%;gap:9px;padding:13px;text-align:left;border:1px solid var(--border,#e4e4e7);border-radius:11px;background:var(--card,#fff);color:inherit;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.03)}.task-card:hover,.task-card:focus-visible{border-color:color-mix(in srgb,var(--foreground,#18181b) 28%,var(--border,#e4e4e7));outline:none}.task-title{font-weight:650}.task-meta,.task-foot{display:flex;align-items:center;gap:6px;color:var(--muted-foreground,#71717a);font-size:11px;text-transform:capitalize}.task-foot{border-top:1px solid var(--border,#eee);padding-top:8px}.status-dot{width:7px;height:7px;border-radius:50%;background:#a1a1aa}.status-dot[data-state=running]{background:#3b82f6}.status-dot[data-state=waiting_approval]{background:#f59e0b}.status-dot[data-state=succeeded]{background:#10b981}.empty{margin:12px 4px;color:var(--muted-foreground,#71717a);font-size:12px}.primary{background:var(--foreground,#18181b)!important;color:var(--background,#fff)!important;border-color:var(--foreground,#18181b)!important}.danger{color:#dc2626!important}.inspector{position:absolute;z-index:20;top:0;right:0;bottom:0;width:clamp(420px,38vw,560px);resize:horizontal;overflow:auto;border-left:1px solid var(--border,#e4e4e7);background:var(--card,#fff);box-shadow:-16px 0 40px rgba(0,0,0,.09)}.inspector-header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;gap:20px;padding:22px;border-bottom:1px solid var(--border,#e4e4e7);background:var(--card,#fff)}.inspector h2{margin:8px 0 2px;font-size:19px}.inspector-header p{margin:0;color:var(--muted-foreground,#71717a);text-transform:capitalize}.stage-pill{padding:3px 7px;border-radius:6px;background:var(--muted,#f2f2f2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.icon-button{border:0!important;font-size:24px!important}.inspector-body{display:grid;gap:24px;padding:22px 22px 90px}.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.section-title h3,.proposal h3{margin:0;font-size:13px}.section-title span{color:var(--muted-foreground,#71717a);font-size:10px}.timeline{display:grid;gap:0;margin:12px 0 0;padding:0;list-style:none}.timeline li{position:relative;padding:0 0 18px 18px;border-left:1px solid var(--border,#e4e4e7)}.timeline li:before{content:'';position:absolute;left:-4px;top:4px;width:7px;height:7px;border-radius:50%;background:#a1a1aa}.timeline p{margin:3px 0;white-space:pre-wrap}.timeline-kind,.timeline time{color:var(--muted-foreground,#71717a);font-size:10px}.composer,.proposal-form,.return-form{display:grid;gap:9px}.proposal-form label{display:grid;gap:5px;font-size:11px;font-weight:650}textarea{box-sizing:border-box;width:100%;min-height:74px;padding:10px;border:1px solid var(--border,#d4d4d8);border-radius:9px;resize:vertical;background:var(--background,#fafafa);color:inherit;font:inherit}button{padding:8px 11px;border:1px solid var(--border,#d4d4d8);border-radius:8px;background:var(--card,#fff);color:inherit;font:inherit;font-weight:600;cursor:pointer}.action-row{display:flex;flex-wrap:wrap;gap:8px}.approval{display:grid;gap:10px;margin:12px 0;padding:12px;border:1px solid #f0c36a;border-radius:10px;background:#fff8e8}.approval p{margin:2px 0 0}.proposal{padding:14px;border:1px solid var(--border,#e4e4e7);border-radius:10px;background:var(--background,#fafafa)}.proposal p{white-space:pre-wrap}.proposal ul{padding-left:18px}.artifacts{display:grid;gap:8px;padding:0;list-style:none}.artifacts li{display:flex;gap:10px}.artifacts span{color:var(--muted-foreground,#71717a)}.inspector footer{position:sticky;bottom:0;padding:12px 22px;border-top:1px solid var(--border,#e4e4e7);background:var(--card,#fff)}.live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.error{margin:20px;padding:12px;border:1px solid #fecaca;border-radius:8px;color:#b91c1c;background:#fef2f2}.new-task{position:absolute;z-index:30;top:70px;right:24px;display:grid;gap:9px;width:300px;padding:16px;border:1px solid var(--border,#ddd);border-radius:12px;background:var(--card,#fff);box-shadow:0 16px 40px rgba(0,0,0,.14)}
  @media(max-width:900px){.board{padding:16px}.lanes{display:flex;overflow-x:auto;scroll-snap-type:x mandatory}.lane{min-width:82vw;scroll-snap-align:start}.inspector{position:fixed;width:100%;max-width:none;resize:none}.board-header{align-items:start}.board h1{font-size:18px}}
</style>`;

const HTMLElementBase = globalThis.HTMLElement ?? class {};

class MonadKanban extends HTMLElementBase {
  #api = null;
  #listener = null;
  #tasks = [];
  #selected = null;
  #panel = {};
  #error = '';
  #live = '';
  #lastFocus = null;
  #showNewTask = false;
  #nextCursor = null;

  connectedCallback() {
    this.#listener = (event) => {
      this.#api = event.detail;
      void this.#loadTasks();
    };
    this.addEventListener(UPDATE_EVENT, this.#listener);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('submit', this.#onSubmit);
    this.addEventListener('keydown', this.#onKeyDown);
    if (this.monadWorkspaceExperience) {
      this.#api = this.monadWorkspaceExperience;
      void this.#loadTasks();
    } else this.#render();
  }

  disconnectedCallback() {
    if (this.#listener) this.removeEventListener(UPDATE_EVENT, this.#listener);
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('submit', this.#onSubmit);
    this.removeEventListener('keydown', this.#onKeyDown);
    this.#listener = null;
  }

  async #loadTasks(cursor = null) {
    if (!this.#api?.apiBaseUrl || !this.#api.snapshot?.projectId) return;
    try {
      const query = new URLSearchParams({ projectId: this.#api.snapshot.projectId, limit: '50' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`${this.#api.apiBaseUrl}/tasks?${query}`);
      if (!response.ok) throw new Error(`tasks request failed: ${response.status}`);
      const payload = await response.json();
      this.#tasks = cursor ? [...this.#tasks, ...(payload.tasks ?? [])] : (payload.tasks ?? []);
      this.#nextCursor = payload.nextCursor ?? null;
      if (this.#selected) this.#selected = this.#tasks.find((task) => task.id === this.#selected.id) ?? null;
      this.#error = '';
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.#render();
  }

  async #selectTask(taskId, source, cursor = null) {
    const task = this.#tasks.find((candidate) => candidate.id === taskId);
    if (!task || !this.#api?.apiBaseUrl) return;
    this.#lastFocus = source ?? null;
    try {
      const query = new URLSearchParams({ projectId: task.projectId, taskId: task.id });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`${this.#api.apiBaseUrl}/tasks/panel?${query}`);
      if (!response.ok) throw new Error(`task panel request failed: ${response.status}`);
      const payload = await response.json();
      this.#panel = cursor
        ? {
            ...payload,
            messages: [...(this.#panel.messages ?? []), ...(payload.messages ?? [])],
            observations: [...(this.#panel.observations ?? []), ...(payload.observations ?? [])]
          }
        : payload;
      this.#selected = task;
      this.#error = '';
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.#render();
  }

  async #post(path, payload) {
    try {
      const response = await fetch(`${this.#api.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `${path} failed: ${response.status}`);
      this.#live = 'Task state updated';
      await this.#loadTasks();
      if (this.#selected) await this.#selectTask(this.#selected.id);
      return true;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#render();
      return false;
    }
  }

  #onClick = (event) => {
    const target = event.target?.closest?.('[data-task-id],[data-action]');
    if (!target) return;
    if (target.dataset.taskId) {
      void this.#selectTask(target.dataset.taskId, target);
      return;
    }
    const task = this.#selected;
    switch (target.dataset.action) {
      case 'new-task':
        this.#showNewTask = !this.#showNewTask;
        this.#render();
        break;
      case 'load-more-tasks':
        if (this.#nextCursor) void this.#loadTasks(this.#nextCursor);
        break;
      case 'load-more-panel':
        if (task && this.#panel.nextCursor) void this.#selectTask(task.id, null, this.#panel.nextCursor);
        break;
      case 'close-inspector':
        this.#selected = null;
        this.#panel = {};
        this.#render();
        this.#lastFocus?.focus?.();
        break;
      case 'open-session':
        if (task) this.#api.actions?.openProjectSession?.(task.sessionId);
        break;
      case 'decide-proposal':
        if (task)
          void this.#post('/proposals/decide', {
            projectId: task.projectId,
            taskId: task.id,
            expectedVersion: task.version,
            decision: target.dataset.decision
          });
        break;
      case 'resolve-approval':
        void this.#post('/execution/control', {
          action: 'resolve-approval',
          approvalId: target.dataset.approvalId,
          decision: target.dataset.decision
        });
        break;
      case 'execution-control':
        if (task)
          void this.#post('/execution/control', {
            projectId: task.projectId,
            taskId: task.id,
            expectedVersion: task.version,
            action: target.dataset.control
          });
        break;
      case 'accept-task':
        if (task)
          void this.#post('/acceptance/decide', {
            projectId: task.projectId,
            taskId: task.id,
            expectedVersion: task.version,
            decision: 'accept'
          });
        break;
    }
  };

  #onSubmit = (event) => {
    const form = event.target;
    const action = form?.dataset?.action;
    if (!action) return;
    event.preventDefault();
    const data = new FormData(form);
    const task = this.#selected;
    const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
    if (action === 'new-task') {
      void this.#post('/tasks/create', {
        projectId: this.#api.snapshot.projectId,
        title: data.get('title'),
        idempotencyKey
      }).then((succeeded) => {
        if (succeeded) {
          this.#showNewTask = false;
          this.#render();
        }
      });
    } else if (action === 'send-message' && task) {
      void this.#post('/messages/send', {
        projectId: task.projectId,
        taskId: task.id,
        text: data.get('message'),
        idempotencyKey
      });
    } else if (action === 'submit-proposal' && task) {
      void this.#post('/proposals/submit', {
        projectId: task.projectId,
        taskId: task.id,
        expectedVersion: task.version,
        summary: data.get('summary'),
        acceptanceCriteria: String(data.get('criteria') ?? '')
          .split('\n')
          .filter(Boolean)
      });
    } else if (action === 'return-task' && task) {
      void this.#post('/acceptance/decide', {
        projectId: task.projectId,
        taskId: task.id,
        expectedVersion: task.version,
        decision: 'return',
        reason: data.get('reason')
      });
    }
  };

  #onKeyDown = (event) => {
    if (event.key === 'Escape' && this.#selected) {
      this.#selected = null;
      this.#render();
      this.#lastFocus?.focus?.();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const cards = [...this.querySelectorAll('.task-card')];
    const index = cards.indexOf(event.target);
    if (index < 0 || cards.length < 2) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    cards[(index + delta + cards.length) % cards.length]?.focus();
  };

  #render() {
    if (!('innerHTML' in this)) return;
    const newTask = this.#showNewTask
      ? '<form class="new-task" data-action="new-task"><label>Task title<textarea name="title" required autofocus></textarea></label><button class="primary" type="submit">Start planning</button></form>'
      : '';
    this.innerHTML = `${STYLES}${this.#error ? `<div class="error" role="alert">${escapeHtml(this.#error)}</div>` : ''}${renderBoardMarkup(this.#tasks, this.#nextCursor)}${newTask}${renderInspectorMarkup(this.#selected, this.#panel)}<div class="live" aria-live="polite">${escapeHtml(this.#live)}</div>`;
    this.dataset.projectId = this.#api?.snapshot?.projectId ?? '';
    this.dataset.ready = this.#api ? 'true' : 'false';
  }
}

if (globalThis.customElements && !globalThis.customElements.get('monad-kanban')) {
  globalThis.customElements.define('monad-kanban', MonadKanban);
}
