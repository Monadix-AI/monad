// First-party `graph-view` workspace experience, shipped as a same-origin ES module over the
// `web-component` delivery path (the same path a third-party experience uses). The host loads this
// module, renders <monad-graph-view>, sets `el.monadWorkspaceExperience`, and dispatches
// `monad-workspace-experience:update`. We bind to that host API and render the activity graph from
// `api.snapshot.graphCanvas` — participants (with live presence) + recent tool activity.
//
// Deliberately dependency-free: a module served from public/ can't resolve bare specifiers at
// runtime, so the tiny `bindWorkspaceExperience` contract and the layout/colours (mirrored from
// @monad/atoms' graph-model) are inlined here rather than imported.

const UPDATE_EVENT = 'monad-workspace-experience:update';
const SVG_NS = 'http://www.w3.org/2000/svg';

const HUB_ID = 'hub:monad';
const HUB_COLOR = '#444441';
const HUMAN_COLOR = '#0ea5e9';
const RECENT_ACTIVITY = 6;

const AGENT_PRESENCE_COLOR = {
  working: '#f59e0b',
  online: '#6366f1',
  'needs-login': '#d97706',
  failed: '#ef4444',
  stopped: '#6b7280',
  idle: '#6b7280'
};
const ACTIVITY_STATUS_COLOR = {
  ok: '#10b981',
  error: '#ef4444',
  running: '#378add'
};

/** Subscribe an element to its host API: deliver the current value (if the host set the property
 *  before we listened) plus every subsequent update event. Returns an unsubscribe. */
function bindWorkspaceExperience(target, onUpdate) {
  const listener = (event) => onUpdate(event.detail);
  target.addEventListener(UPDATE_EVENT, listener);
  if (target.monadWorkspaceExperience) onUpdate(target.monadWorkspaceExperience);
  return () => target.removeEventListener(UPDATE_EVENT, listener);
}

function participantColor(p) {
  return p.kind === 'human' ? HUMAN_COLOR : (AGENT_PRESENCE_COLOR[p.presence] ?? AGENT_PRESENCE_COLOR.idle);
}

/** Hub-and-spoke layout mirroring @monad/atoms' canvasToGraph: participants ring the `monad` hub,
 *  recent activity stacks in a column to the left. Returns positioned nodes + edges. */
function layout(canvas) {
  const participants = canvas?.participants ?? [];
  const activity = canvas?.activity ?? [];
  const nodes = [{ id: HUB_ID, x: 0, y: 0, label: 'monad', color: HUB_COLOR }];
  const edges = [];

  const radius = Math.max(180, participants.length * 36);
  participants.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, participants.length);
    const id = `p:${p.id}`;
    nodes.push({
      id,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      label: p.name,
      color: participantColor(p)
    });
    edges.push({ id: `e:p:${p.id}`, from: HUB_ID, to: id });
  });

  activity.slice(-RECENT_ACTIVITY).forEach((a, i) => {
    const id = `a:${a.id}`;
    nodes.push({
      id,
      x: -radius - 160,
      y: (i - (RECENT_ACTIVITY - 1) / 2) * 64,
      label: a.tool,
      color: ACTIVITY_STATUS_COLOR[a.status] ?? ACTIVITY_STATUS_COLOR.ok
    });
    edges.push({ id: `e:a:${a.id}`, from: HUB_ID, to: id, animated: a.status === 'running' });
  });

  return { nodes, edges };
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

class MonadGraphView extends HTMLElement {
  #unbind = null;
  #api = null;

  connectedCallback() {
    this.style.display = 'block';
    this.style.position = 'relative';
    this.style.minWidth = '0';
    this.style.minHeight = '0';
    this.#unbind = bindWorkspaceExperience(this, (api) => {
      this.#api = api;
      this.render();
    });
  }

  disconnectedCallback() {
    this.#unbind?.();
    this.#unbind = null;
  }

  render() {
    const api = this.#api;
    if (!api) {
      this.textContent = '';
      return;
    }
    const canvas = api.snapshot?.graphCanvas ?? { participants: [], activity: [] };
    this.dataset.projectId = api.snapshot?.projectId ?? '';
    this.dataset.participantCount = String(canvas.participants?.length ?? 0);
    this.dataset.activityCount = String(canvas.activity?.length ?? 0);

    const { nodes, edges } = layout(canvas);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Fit-to-content viewBox with padding, mirroring the host-component's fitView behaviour.
    const NODE_W = 128;
    const NODE_H = 40;
    const PAD = 48;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - NODE_W / 2);
      minY = Math.min(minY, n.y - NODE_H / 2);
      maxX = Math.max(maxX, n.x + NODE_W / 2);
      maxY = Math.max(maxY, n.y + NODE_H / 2);
    }
    const vbX = minX - PAD;
    const vbY = minY - PAD;
    const vbW = maxX - minX + PAD * 2;
    const vbH = maxY - minY + PAD * 2;

    const svg = el('svg', {
      viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`,
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Project activity graph'
    });
    svg.style.display = 'block';
    svg.style.background = 'var(--card, #fff)';

    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const line = el('line', {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: 'var(--border, #d4d4d8)',
        'stroke-width': 1.5
      });
      if (e.animated) {
        line.setAttribute('stroke', ACTIVITY_STATUS_COLOR.running);
        line.setAttribute('stroke-dasharray', '4 4');
        const anim = el('animate', {
          attributeName: 'stroke-dashoffset',
          values: '16;0',
          dur: '0.6s',
          repeatCount: 'indefinite'
        });
        line.appendChild(anim);
      }
      svg.appendChild(line);
    }

    for (const n of nodes) {
      const g = el('g', { transform: `translate(${n.x} ${n.y})`, 'data-node-id': n.id });
      const rect = el('rect', {
        x: -NODE_W / 2,
        y: -NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
        rx: 8,
        ry: 8,
        fill: n.color
      });
      const text = el('text', {
        x: 0,
        y: 0,
        fill: '#fff',
        'font-size': 12,
        'font-family': 'system-ui, sans-serif',
        'text-anchor': 'middle',
        'dominant-baseline': 'central'
      });
      // Truncate long labels so they stay inside the node box.
      const label = n.label ?? '';
      text.textContent = label.length > 18 ? `${label.slice(0, 17)}…` : label;
      g.appendChild(rect);
      g.appendChild(text);

      if (n.id === HUB_ID && typeof api.actions?.switchExperience === 'function') {
        // Dogfood an action off the published host API: clicking the hub drops into the chat-room
        // experience — a real, non-destructive switchExperience call.
        g.style.cursor = 'pointer';
        rect.setAttribute('role', 'button');
        const title = el('title', {});
        title.textContent = 'Open chat';
        g.appendChild(title);
        g.addEventListener('click', () => api.actions.switchExperience('chat-room'));
      }

      svg.appendChild(g);
    }

    this.replaceChildren(svg);
    this.dataset.ready = 'true';
  }
}

if (!customElements.get('monad-graph-view')) {
  customElements.define('monad-graph-view', MonadGraphView);
}
