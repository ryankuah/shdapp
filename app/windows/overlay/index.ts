interface ReadyStateMessage {
  type: 'ready_state';
  agents: Record<number, boolean>;
}

interface AgentAssignedMessage {
  type: 'agent_assigned';
  agentId: number;
  agents: Record<number, boolean>;
}

type OverlayMessage = ReadyStateMessage | AgentAssignedMessage;

const MAX_AGENTS = 8;
const phaseStatus = document.getElementById('phaseStatus') as HTMLDivElement;
const agentList = document.getElementById('agentList') as HTMLDivElement;

const agentRows = new Map<number, HTMLDivElement>();
const agentDots = new Map<number, HTMLSpanElement>();
const agentStatuses = new Map<number, HTMLSpanElement>();

let selfAgentId: number | null = null;
let agentStates: Record<number, boolean> = {};

function normalizeAgentStates(states: Record<number, boolean>): Record<number, boolean> {
  const normalized: Record<number, boolean> = {};
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    normalized[i] = states[i] ?? false;
  }
  return normalized;
}

function setPhaseStatus(isReady: boolean) {
  phaseStatus.textContent = isReady ? 'Ready' : 'Unready';
  phaseStatus.classList.toggle('ready', isReady);
  phaseStatus.classList.toggle('unready', !isReady);
}

function updateAgentRow(agentId: number, isReady: boolean) {
  const row = agentRows.get(agentId);
  const dot = agentDots.get(agentId);
  const status = agentStatuses.get(agentId);
  if (!row || !dot || !status) {
    return;
  }
  row.classList.toggle('ready', isReady);
  row.classList.toggle('unready', !isReady);
  status.textContent = isReady ? 'Ready' : 'Unready';
  dot.classList.toggle('ready', isReady);
}

function renderAgentList() {
  agentList.innerHTML = '';
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
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
  }
}

function applyAgentStates(states: Record<number, boolean>) {
  agentStates = normalizeAgentStates(states);
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    updateAgentRow(i, agentStates[i]);
  }
  const isReady = selfAgentId ? agentStates[selfAgentId] ?? false : false;
  setPhaseStatus(isReady);
}

// Listen for messages from the connect window
function setupMessageListeners() {
  // Overwolf message listener
  window.addEventListener('message', (event) => {
    const message = event.data as OverlayMessage;
    if (!message) {
      return;
    }
    if (message.type === 'agent_assigned') {
      selfAgentId = message.agentId;
      applyAgentStates(message.agents);
    } else if (message.type === 'ready_state') {
      applyAgentStates(message.agents);
    }
  });

  // LocalStorage fallback for cross-window communication
  window.addEventListener('storage', (event) => {
    if (event.key === 'shd-overlay-message' && event.newValue) {
      try {
        const message = JSON.parse(event.newValue) as OverlayMessage;
        if (message.type === 'agent_assigned') {
          selfAgentId = message.agentId;
          applyAgentStates(message.agents);
        } else if (message.type === 'ready_state') {
          applyAgentStates(message.agents);
        }
      } catch (e) {
        console.error('Failed to parse overlay message:', e);
      }
    }
  });

  // Also check for existing message on load
  const existingMessage = localStorage.getItem('shd-overlay-message');
  if (existingMessage) {
    try {
      const message = JSON.parse(existingMessage) as OverlayMessage;
      if (message.type === 'agent_assigned') {
        selfAgentId = message.agentId;
        applyAgentStates(message.agents);
      } else if (message.type === 'ready_state') {
        applyAgentStates(message.agents);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

// Initialize
renderAgentList();
setPhaseStatus(false);
setupMessageListeners();
