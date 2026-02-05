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

interface CountdownMessage {
  type: 'countdown';
  timestamp: number;
  duration: number;
}

interface PhaseMessage {
  type: 'phase';
  phase: string;
}

interface ResetMessage {
  type: 'reset';
}

type OverlayMessage = ReadyStateMessage | AgentAssignedMessage | CountdownMessage | PhaseMessage | ResetMessage;

type OverlayState = 'agents' | 'countdown' | 'phase';

const MAX_AGENTS = 8;
const phaseStatus = document.getElementById('phaseStatus') as HTMLDivElement;
const agentList = document.getElementById('agentList') as HTMLDivElement;
const countdown = document.getElementById('countdown') as HTMLDivElement;
const countdownValue = document.getElementById('countdownValue') as HTMLSpanElement;
const phaseDisplay = document.getElementById('phaseDisplay') as HTMLDivElement;
const phaseText = document.getElementById('phaseText') as HTMLSpanElement;

const agentRows = new Map<number, HTMLDivElement>();
const agentDots = new Map<number, HTMLSpanElement>();
const agentStatuses = new Map<number, HTMLSpanElement>();
const agentNames = new Map<number, HTMLSpanElement>();

let selfAgentId: number | null = null;
let agentStates: Record<number, boolean> = {};
let agentNameState: Record<number, string> = {};
let overlayState: OverlayState = 'agents';
let countdownInterval: ReturnType<typeof setInterval> | null = null;

function setOverlayState(state: OverlayState) {
  overlayState = state;
  phaseStatus.classList.toggle('hidden', state !== 'agents');
  agentList.classList.toggle('hidden', state !== 'agents');
  countdown.classList.toggle('hidden', state !== 'countdown');
  phaseDisplay.classList.toggle('hidden', state !== 'phase');
}

function startCountdown(timestamp: number, duration: number) {
  if (countdownInterval) clearInterval(countdownInterval);
  setOverlayState('countdown');
  
  // Calculate endTime from the starter's timestamp
  const endTime = timestamp + duration;

  function update() {
    const remaining = Math.max(0, endTime - Date.now());
    countdownValue.textContent = String(Math.ceil(remaining / 1000));
    if (remaining <= 0) {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }
  }
  update();
  countdownInterval = setInterval(update, 100);
}

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
    setOverlayState('agents');
  } else if (data.type === 'ready_state') {
    applyAgentStates(data.agents, data.names);
    if (overlayState === 'agents') {
      // Stay in agents state, don't change
    }
  } else if (data.type === 'countdown') {
    startCountdown(data.timestamp, data.duration);
  } else if (data.type === 'phase') {
    phaseText.textContent = data.phase;
    setOverlayState('phase');
  } else if (data.type === 'reset') {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    setOverlayState('agents');
  }
});

renderAgentList();
setPhaseStatus(false);
