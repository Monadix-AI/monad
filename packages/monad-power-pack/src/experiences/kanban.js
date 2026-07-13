// Power Pack workspace experience. The host sets `monadWorkspaceExperience` and dispatches
// `monad-workspace-experience:update`; this dependency-free element renders the published activity
// canvas without importing host or framework internals.
const UPDATE_EVENT = 'monad-workspace-experience:update';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HUB_ID = 'hub:monad';
const RECENT_ACTIVITY = 6;

const PRESENCE_COLOR = {
  online: '#6366f1',
  working: '#f59e0b',
  'needs-login': '#d97706',
  failed: '#ef4444',
  stopped: '#6b7280',
  idle: '#6b7280'
};
const STATUS_COLOR = { ok: '#10b981', error: '#ef4444', running: '#378add' };

function svgElement(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function layout(canvas) {
  const participants = canvas?.participants ?? [];
  const activity = canvas?.activity ?? [];
  const nodes = [{ id: HUB_ID, x: 0, y: 0, label: 'monad', color: '#444441' }];
  const edges = [];
  const radius = Math.max(180, participants.length * 36);

  participants.forEach((participant, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, participants.length);
    const id = `p:${participant.id}`;
    nodes.push({
      id,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      label: participant.name,
      color: participant.kind === 'human' ? '#0ea5e9' : (PRESENCE_COLOR[participant.presence] ?? PRESENCE_COLOR.idle)
    });
    edges.push({ from: HUB_ID, to: id });
  });

  activity.slice(-RECENT_ACTIVITY).forEach((row, index) => {
    const id = `a:${row.id}`;
    nodes.push({
      id,
      x: -radius - 160,
      y: (index - (RECENT_ACTIVITY - 1) / 2) * 64,
      label: row.tool,
      color: STATUS_COLOR[row.status] ?? STATUS_COLOR.ok
    });
    edges.push({ from: HUB_ID, to: id, animated: row.status === 'running' });
  });
  return { nodes, edges };
}

class MonadKanban extends HTMLElement {
  #api = null;
  #listener = null;

  connectedCallback() {
    this.style.cssText = 'display:block;position:relative;min-width:0;min-height:0';
    this.#listener = (event) => {
      this.#api = event.detail;
      this.render();
    };
    this.addEventListener(UPDATE_EVENT, this.#listener);
    if (this.monadWorkspaceExperience) {
      this.#api = this.monadWorkspaceExperience;
      this.render();
    }
  }

  disconnectedCallback() {
    if (this.#listener) this.removeEventListener(UPDATE_EVENT, this.#listener);
    this.#listener = null;
  }

  render() {
    if (!this.#api) return;
    const canvas = this.#api.snapshot?.graphCanvas ?? { participants: [], activity: [] };
    const { nodes, edges } = layout(canvas);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const nodeWidth = 128;
    const nodeHeight = 40;
    const padding = 48;
    const xs = nodes.flatMap((node) => [node.x - nodeWidth / 2, node.x + nodeWidth / 2]);
    const ys = nodes.flatMap((node) => [node.y - nodeHeight / 2, node.y + nodeHeight / 2]);
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    const width = Math.max(...xs) - Math.min(...xs) + padding * 2;
    const height = Math.max(...ys) - Math.min(...ys) + padding * 2;
    const svg = svgElement('svg', {
      viewBox: `${minX} ${minY} ${width} ${height}`,
      width: '100%',
      height: '100%',
      role: 'img',
      'aria-label': 'Kanban activity view'
    });
    svg.style.cssText = 'display:block;background:var(--card,#fff)';

    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const line = svgElement('line', {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        stroke: edge.animated ? STATUS_COLOR.running : 'var(--border,#d4d4d8)',
        'stroke-width': 1.5,
        ...(edge.animated ? { 'stroke-dasharray': '4 4' } : {})
      });
      svg.append(line);
    }

    for (const node of nodes) {
      const group = svgElement('g', { transform: `translate(${node.x} ${node.y})`, 'data-node-id': node.id });
      const rect = svgElement('rect', {
        x: -nodeWidth / 2,
        y: -nodeHeight / 2,
        width: nodeWidth,
        height: nodeHeight,
        rx: 8,
        fill: node.color
      });
      const text = svgElement('text', {
        x: 0,
        y: 0,
        fill: '#fff',
        'font-size': 12,
        'font-family': 'system-ui,sans-serif',
        'text-anchor': 'middle',
        'dominant-baseline': 'central'
      });
      const label = node.label ?? '';
      text.textContent = label.length > 18 ? `${label.slice(0, 17)}…` : label;
      group.append(rect, text);
      if (node.id === HUB_ID && typeof this.#api.actions?.switchExperience === 'function') {
        group.style.cursor = 'pointer';
        group.addEventListener('click', () => this.#api.actions.switchExperience('chat-room'));
      }
      svg.append(group);
    }

    this.dataset.projectId = this.#api.snapshot?.projectId ?? '';
    this.dataset.participantCount = String(canvas.participants?.length ?? 0);
    this.dataset.activityCount = String(canvas.activity?.length ?? 0);
    this.dataset.ready = 'true';
    this.replaceChildren(svg);
  }
}

if (!customElements.get('monad-kanban')) customElements.define('monad-kanban', MonadKanban);
