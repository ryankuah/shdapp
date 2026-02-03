import { ipcRenderer } from 'electron';

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface ReadyStateMessage extends WSMessage {
  type: 'ready_state';
  agents: Record<number, boolean>;
  names?: Record<number, string>;
}

interface AgentAssignedMessage extends WSMessage {
  type: 'agent_assigned';
  agentId: number;
  agents: Record<number, boolean>;
  names?: Record<number, string>;
}

interface StartMessage extends WSMessage {
  type: 'start';
  timestamp: number;
  starterAgentId: number;
}

interface CountdownMessage extends WSMessage {
  type: 'countdown';
  endTime: number;
  duration: number;
}

interface PhaseMessage extends WSMessage {
  type: 'phase';
  phase: string;
}

const HARDCODED_SERVER_URL = 'wss://shd-overlay-server.fly.dev/ws';

// DOM elements
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
const nameGrid = document.getElementById('nameGrid') as HTMLDivElement;
const delayInput = document.getElementById('startDelay') as HTMLInputElement;
const resetRaidBtn = document.getElementById('resetRaidBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const nameStep = document.getElementById('nameStep') as HTMLDivElement;
const settingsStep = document.getElementById('settingsStep') as HTMLDivElement;
const nameButtons = Array.from(nameGrid.querySelectorAll('button')) as HTMLButtonElement[];

let ws: WebSocket | null = null;
let agentId: number | null = null;
let isReady = false;
let selectedName: string | null = null;
let startDelayMs = 2000;
let hasConfirmedName = false;
let namesByAgent: Record<number, string> = {};

const DEFAULT_START_DELAY_SECONDS = 2;
const START_DELAY_STORAGE_KEY = 'shd-start-delay-seconds';

delayInput.disabled = true;

function updateStatus(status: 'connected' | 'disconnected' | 'connecting', message: string) {
  statusDiv.className = `status ${status}`;
  statusDiv.textContent = message;

  if (status === 'connected') {
    if (hasConfirmedName) {
      nameStep.classList.add('hidden');
      settingsStep.classList.remove('hidden');
    } else {
      nameStep.classList.remove('hidden');
      settingsStep.classList.add('hidden');
    }
  } else {
    nameStep.classList.remove('hidden');
    settingsStep.classList.add('hidden');
    hasConfirmedName = false;
    namesByAgent = {};
    clearSelectedName();
  }
  updateSettingsState();
  updateNameButtons();
}

function connect() {
  updateStatus('connecting', 'Connecting...');

  try {
    ws = new WebSocket(HARDCODED_SERVER_URL);

    ws.onopen = () => {
      console.log('[WS] Connected');
      updateStatus('connected', 'Connected');
      // Show overlay when connected
      ipcRenderer.send('show-overlay');
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      updateStatus('disconnected', 'Disconnected - Reconnecting...');
      ws = null;
      setTimeout(connect, 3000);
    };

    ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      updateStatus('disconnected', 'Connection error');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;
        console.log('[WS] Received:', message);
        
        if (message.type === 'agent_assigned') {
          const assigned = message as AgentAssignedMessage;
          agentId = assigned.agentId;
          isReady = assigned.agents[assigned.agentId] ?? false;
          updateNames(assigned.names);
          ipcRenderer.send('update-overlay', assigned);
        } else if (message.type === 'ready_state') {
          const readyState = message as ReadyStateMessage;
          updateNames(readyState.names);
          ipcRenderer.send('update-overlay', readyState);
        } else if (message.type === 'countdown') {
          const countdownMsg = message as CountdownMessage;
          ipcRenderer.send('update-overlay', countdownMsg);
        } else if (message.type === 'start') {
          const startMessage = message as StartMessage;
          scheduleStartActions(startMessage.timestamp, startMessage.starterAgentId);
        } else if (message.type === 'phase') {
          const phaseMsg = message as PhaseMessage;
          ipcRenderer.send('update-overlay', phaseMsg);
        } else if (message.type === 'error') {
          updateStatus('disconnected', String(message.message ?? 'Server error'));
        }
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };
  } catch (e) {
    console.error('[WS] Connection failed:', e);
    updateStatus('disconnected', 'Connection failed');
  }
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  agentId = null;
  isReady = false;
  updateStatus('disconnected', 'Disconnected');
}

function sendReady() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    isReady = !isReady;
    const message = { type: 'ready', value: isReady };
    ws.send(JSON.stringify(message));
    console.log('[WS] Sent:', message);
  } else {
    console.warn('Not connected to server');
  }
}

function sendStartRequest() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type: 'start_request' };
    ws.send(JSON.stringify(message));
    console.log('[WS] Sent:', message);
  } else {
    console.warn('Not connected to server');
  }
}

function sendResetRaid() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'reset_raid' }));
    console.log('[WS] Sent reset_raid');
  }
}

function scheduleStartActions(timestamp: number, starterAgentId: number) {
  if (!agentId) {
    return;
  }
  const delay = Math.max(0, timestamp + startDelayMs - Date.now());
  setTimeout(() => {
    if (agentId === starterAgentId) {
      ipcRenderer.send('start-space');
      // Send phase change after key press
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'set_phase', phase: 'Railyard' }));
        }
      }, 200);
    } else {
      ipcRenderer.send('start-ctrl-tap');
    }
  }, delay);
}

function setSelectedName(name: string) {
  nameButtons.forEach((button) => {
    button.classList.toggle('selected', button.dataset.name === name);
  });
  selectedName = name;
}

function clearSelectedName() {
  nameButtons.forEach((button) => {
    button.classList.remove('selected');
  });
  selectedName = null;
}

function saveName(name: string) {
  const cleanName = name.trim();
  if (!cleanName) {
    updateStatus('connected', 'Please select your name');
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type: 'set_name', name: cleanName };
    ws.send(JSON.stringify(message));
    localStorage.setItem('shd-display-name', cleanName);
    setSelectedName(cleanName);
    updateStatus('connected', 'Name saved');
  } else {
    updateStatus('disconnected', 'Not connected');
  }
}

function getDelaySeconds() {
  const parsed = Number(delayInput.value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_START_DELAY_SECONDS;
  }
  return parsed;
}

function setDelaySeconds(seconds: number) {
  delayInput.value = String(seconds);
}

function updateSettingsState() {
  const isConnected = Boolean(ws && ws.readyState === WebSocket.OPEN);
  delayInput.disabled = !isConnected || !hasConfirmedName;
}

function updateNames(names?: Record<number, string>) {
  if (!names) {
    return;
  }
  namesByAgent = names;
  updateNameButtons();
}

function updateNameButtons() {
  const takenNames = new Set<string>();
  Object.entries(namesByAgent).forEach(([id, name]) => {
    const numericId = Number(id);
    if (!Number.isNaN(numericId) && agentId !== numericId) {
      takenNames.add(name);
    }
  });

  nameButtons.forEach((button) => {
    const name = button.dataset.name;
    const isTaken = Boolean(name && takenNames.has(name));
    button.disabled = isTaken;
  });

  if (selectedName && takenNames.has(selectedName)) {
    clearSelectedName();
    statusDiv.className = 'status connected';
    statusDiv.textContent = 'That name is already taken';
  }
}

// Listen for hotkey from main process
ipcRenderer.on('hotkey-ready', () => {
  console.log('Hotkey received');
  sendReady();
});

ipcRenderer.on('hotkey-start', () => {
  console.log('Start hotkey received');
  sendStartRequest();
});

// Initialize
disconnectBtn.addEventListener('click', disconnect);
resetRaidBtn.addEventListener('click', sendResetRaid);
delayInput.addEventListener('input', () => {
  const delaySeconds = getDelaySeconds();
  startDelayMs = delaySeconds * 1000;
  localStorage.setItem(START_DELAY_STORAGE_KEY, String(delaySeconds));
});
nameGrid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest('button');
  const name = button?.dataset?.name;
  if (name && !button?.disabled) {
    saveName(name);
    hasConfirmedName = true;
    nameStep.classList.add('hidden');
    settingsStep.classList.remove('hidden');
    updateSettingsState();
  }
});

// Load saved name
const savedName = localStorage.getItem('shd-display-name');
if (savedName) {
  const hasOption = nameButtons.some((button) => button.dataset.name === savedName);
  if (hasOption) {
    setSelectedName(savedName);
  }
}

// Load saved delay
const savedDelay = localStorage.getItem(START_DELAY_STORAGE_KEY);
if (savedDelay) {
  const parsed = Number(savedDelay);
  const delaySeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_START_DELAY_SECONDS;
  setDelaySeconds(delaySeconds);
  startDelayMs = delaySeconds * 1000;
} else {
  setDelaySeconds(DEFAULT_START_DELAY_SECONDS);
  startDelayMs = DEFAULT_START_DELAY_SECONDS * 1000;
}

// Auto-connect on load
document.addEventListener('DOMContentLoaded', () => {
  connect();
});
