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

// DOM elements
const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
const nameGrid = document.getElementById('nameGrid') as HTMLDivElement;
const delayInput = document.getElementById('startDelay') as HTMLInputElement;
const confirmNameBtn = document.getElementById('confirmNameBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const urlStep = document.getElementById('urlStep') as HTMLDivElement;
const nameStep = document.getElementById('nameStep') as HTMLDivElement;
const nameButtons = Array.from(nameGrid.querySelectorAll('button')) as HTMLButtonElement[];

let ws: WebSocket | null = null;
let agentId: number | null = null;
let isReady = false;
let selectedName: string | null = null;
let startDelayMs = 2000;

const DEFAULT_START_DELAY_SECONDS = 2;
const START_DELAY_STORAGE_KEY = 'shd-start-delay-seconds';

delayInput.disabled = true;
confirmNameBtn.disabled = true;

function updateStatus(status: 'connected' | 'disconnected' | 'connecting', message: string) {
  statusDiv.className = `status ${status}`;
  statusDiv.textContent = message;
  
  if (status === 'connected') {
    urlStep.classList.add('hidden');
    nameStep.classList.remove('hidden');
    serverUrlInput.disabled = true;
    connectBtn.disabled = false;
    delayInput.disabled = false;
  } else {
    urlStep.classList.remove('hidden');
    nameStep.classList.add('hidden');
    serverUrlInput.disabled = false;
    connectBtn.disabled = status === 'connecting';
    delayInput.disabled = true;
  }
  updateConfirmState();
}

function connect() {
  const url = serverUrlInput.value.trim();
  if (!url) {
    updateStatus('disconnected', 'Please enter a server URL');
    return;
  }

  updateStatus('connecting', 'Connecting...');
  
  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WS] Connected');
      updateStatus('connected', 'Connected');
      // Show overlay when connected
      ipcRenderer.send('show-overlay');
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      updateStatus('disconnected', 'Disconnected');
      ws = null;
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
          ipcRenderer.send('update-overlay', assigned);
        } else if (message.type === 'ready_state') {
          ipcRenderer.send('update-overlay', message as ReadyStateMessage);
        } else if (message.type === 'start') {
          const startMessage = message as StartMessage;
          scheduleStartActions(startMessage.timestamp, startMessage.starterAgentId);
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

function scheduleStartActions(timestamp: number, starterAgentId: number) {
  if (!agentId) {
    return;
  }
  const delay = Math.max(0, timestamp + startDelayMs - Date.now());
  setTimeout(() => {
    if (agentId === starterAgentId) {
      ipcRenderer.send('start-space');
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
  updateConfirmState();
}

function saveName(name: string) {
  const cleanName = name.trim();
  if (!cleanName) {
    updateStatus('connected', 'Please select your name');
    return;
  }
  const delaySeconds = getDelaySeconds();
  startDelayMs = delaySeconds * 1000;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type: 'set_name', name: cleanName };
    ws.send(JSON.stringify(message));
    localStorage.setItem('shd-display-name', cleanName);
    localStorage.setItem(START_DELAY_STORAGE_KEY, String(delaySeconds));
    setSelectedName(cleanName);
    updateStatus('connected', `Name saved. Delay set to ${delaySeconds}s`);
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

function updateConfirmState() {
  const isConnected = Boolean(ws && ws.readyState === WebSocket.OPEN);
  confirmNameBtn.disabled = !isConnected || !selectedName;
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
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
confirmNameBtn.addEventListener('click', () => {
  if (selectedName) {
    saveName(selectedName);
  } else {
    updateStatus('connected', 'Please select your name');
  }
});
nameGrid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest('button');
  const name = button?.dataset?.name;
  if (name) {
    setSelectedName(name);
  }
});

// Load saved URL
const savedUrl = localStorage.getItem('shd-server-url');
if (savedUrl) {
  serverUrlInput.value = savedUrl;
}

const savedName = localStorage.getItem('shd-display-name');
if (savedName) {
  const hasOption = nameButtons.some((button) => button.dataset.name === savedName);
  if (hasOption) {
    setSelectedName(savedName);
  }
}

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

// Save URL on change
serverUrlInput.addEventListener('change', () => {
  localStorage.setItem('shd-server-url', serverUrlInput.value);
});
