import { ipcRenderer } from 'electron';

interface ReadyStateMessage {
  type: 'ready_state';
  agents: Record<number, boolean>;
  names: Record<number, string>;
}

interface AgentAssignedMessage {
  type: 'agent_assigned';
  agentId: number;
  agents: Record<number, boolean>;
  names: Record<number, string>;
}

type OverlayMessage = ReadyStateMessage | AgentAssignedMessage;

const MAX_AGENTS = 8;
const phaseStatus = document.getElementById('phaseStatus') as HTMLDivElement;
const agentList = document.getElementById('agentList') as HTMLDivElement;

const agentRows = new Map<number, HTMLDivElement>();
const agentDots = new Map<number, HTMLSpanElement>();
const agentStatuses = new Map<number, HTMLSpanElement>();
const agentNames = new Map<number, HTMLSpanElement>();

let selfAgentId: number | null = null;
let agentStates: Record<number, boolean> = {};
let agentNameState: Record<number, string> = {};

function normalizeAgentStates(states: Record<number, boolean>): Record<number, boolean> {
  const normalized: Record<number, boolean> = {};
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    normalized[i] = states[i] ?? false;
  }
  return normalized;
}

function normalizeAgentNames(names: Record<number, string>): Record<number, string> {
  const normalized: Record<number, string> = {};
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    normalized[i] = names[i] ?? '';
  }
  return normalized;
}

function setPhaseStatus(isReady: boolean) {
  phaseStatus.textContent = isReady ? 'Ready' : 'Unready';
  phaseStatus.classList.toggle('ready', isReady);
  phaseStatus.classList.toggle('unready', !isReady);
}

function updateAgentRow(agentId: number, isReady: boolean, displayName: string) {
  const row = agentRows.get(agentId);
  const dot = agentDots.get(agentId);
  const status = agentStatuses.get(agentId);
  const name = agentNames.get(agentId);
  if (!row || !dot || !status || !name) {
    return;
  }
  row.classList.toggle('ready', isReady);
  row.classList.toggle('unready', !isReady);
  status.textContent = isReady ? 'Ready' : 'Unready';
  dot.classList.toggle('ready', isReady);
  name.textContent = displayName || `Agent ${agentId}`;
}

function renderAgentList() {
  agentList.innerHTML = '';
  agentRows.clear();
  agentDots.clear();
  agentStatuses.clear();
  agentNames.clear();
}

function getJoinedAgentIds(names: Record<number, string>): number[] {
  const joined: number[] = [];
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    if (names[i]?.trim()) {
      joined.push(i);
    }
  }
  return joined;
}

function renderJoinedAgents(joinedIds: number[]) {
  agentList.innerHTML = '';
  agentRows.clear();
  agentDots.clear();
  agentStatuses.clear();
  agentNames.clear();

  for (const i of joinedIds) {
    const row = document.createElement('div');
    row.className = 'agent-row unready';

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = `Agent ${i}`;

    const status = document.createElement('span');
    status.className = 'agent-status';
    status.textContent = 'Unready';

    row.append(dot, name, status);
    agentList.appendChild(row);

    agentRows.set(i, row);
    agentDots.set(i, dot);
    agentStatuses.set(i, status);
    agentNames.set(i, name);
  }
}

function applyAgentStates(states: Record<number, boolean>, names: Record<number, string>) {
  agentStates = normalizeAgentStates(states);
  agentNameState = normalizeAgentNames(names);
  const joinedIds = getJoinedAgentIds(agentNameState);
  renderJoinedAgents(joinedIds);
  for (const id of joinedIds) {
    updateAgentRow(id, agentStates[id], agentNameState[id]);
  }
  const isReady = selfAgentId ? agentStates[selfAgentId] ?? false : false;
  setPhaseStatus(isReady);
}

// Listen for updates from main process
ipcRenderer.on('overlay-update', (_event: unknown, data: OverlayMessage) => {
  console.log('Overlay update:', data);
  if (data.type === 'agent_assigned') {
    selfAgentId = data.agentId;
    applyAgentStates(data.agents, data.names);
  } else if (data.type === 'ready_state') {
    applyAgentStates(data.agents, data.names);
  }
});

renderAgentList();
setPhaseStatus(false);
