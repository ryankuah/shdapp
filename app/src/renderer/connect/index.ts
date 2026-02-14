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
  timestamp: number;
  duration: number;
}

const isDev =
  process.env.NODE_ENV === 'development' ||
  process.env.ELECTRON_IS_DEV === 'true' ||
  process.defaultApp === true;

const SERVER_URL = isDev ? 'ws://localhost:3000/ws' : 'wss://shd-overlay-server.fly.dev/ws';

// DOM elements
const nameInput = document.getElementById('nameInput') as HTMLInputElement;
const joinBtn = document.getElementById('joinBtn') as HTMLButtonElement;
const delayInput = document.getElementById('startDelay') as HTMLInputElement;
const resetRaidBtn = document.getElementById('resetRaidBtn') as HTMLButtonElement;
const nameStep = document.getElementById('nameStep') as HTMLDivElement;
const settingsStep = document.getElementById('settingsStep') as HTMLDivElement;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const welcomeText = document.getElementById('welcomeText') as HTMLSpanElement;
const fabContainer = document.getElementById('fabContainer') as HTMLDivElement;
const fabBtn = document.getElementById('fabBtn') as HTMLButtonElement;
const fabMenu = document.getElementById('fabMenu') as HTMLDivElement;
const editKeybindsBtn = document.getElementById('editKeybindsBtn') as HTMLButtonElement;
const keybindsSettingsStep = document.getElementById('keybindsSettingsStep') as HTMLDivElement;
const keybindsSettingsBackBtn = document.getElementById('keybindsSettingsBackBtn') as HTMLButtonElement;
const saveKeybindsBtn = document.getElementById('saveKeybindsBtn') as HTMLButtonElement;
const keybindReadyBtn = document.getElementById('keybindReady') as HTMLButtonElement;
const keybindStartBtn = document.getElementById('keybindStart') as HTMLButtonElement;
const keybindTestRollBtn = document.getElementById('keybindTestRoll') as HTMLButtonElement;
const readyBtn = document.getElementById('readyBtn') as HTMLButtonElement;
const readySection = document.getElementById('readySection') as HTMLDivElement;
const postRaidSection = document.getElementById('postRaidSection') as HTMLDivElement;
const travelBtn = document.getElementById('travelBtn') as HTMLButtonElement;


const errorBanner = document.getElementById('errorBanner') as HTMLDivElement;
const errorBannerText = document.getElementById('errorBannerText') as HTMLSpanElement;
const errorBannerDismiss = document.getElementById('errorBannerDismiss') as HTMLButtonElement;

const connectionStatus = document.getElementById('connectionStatus') as HTMLDivElement;
const connectionText = document.getElementById('connectionText') as HTMLSpanElement;

const KEYBINDS_STORAGE_KEY = 'shd-keybinds';

interface KeybindsConfig {
  ready: string;
  start: string;
  testRoll: string;
  rollDelaySeconds: number;
}

const DEFAULT_KEYBINDS: KeybindsConfig = {
  ready: 'CommandOrControl+Shift+R',
  start: 'CommandOrControl+Shift+S',
  testRoll: 'CommandOrControl+Shift+K',
  rollDelaySeconds: 2.9,
};

let ws: WebSocket | null = null;
let agentId: number | null = null;
let isReady = false;
let selectedName: string | null = null;
let startDelayMs = 2000;
let hasConfirmedName = false;
let namesByAgent: Record<number, string> = {};
let intentionalDisconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let raidState: 'ready' | 'started' = 'ready';
let countdownEndTimer: ReturnType<typeof setTimeout> | null = null;
let travelMode = false;

const DEFAULT_START_DELAY_SECONDS = 2.9;
const STARTER_DELAY_MS = 3000; // Starter always acts at exactly 3 seconds
const START_DELAY_STORAGE_KEY = 'shd-start-delay-seconds';


function updateConnectionIndicator(status: 'connected' | 'disconnected' | 'connecting', message: string) {
  if (connectionStatus && connectionText) {
    connectionStatus.className = `connection-status ${status}`;
    connectionText.textContent = message;
  }
}

function updateStatus(status: 'connected' | 'disconnected' | 'connecting', _message: string) {
  // Update the connection status pill
  const statusLabels: Record<string, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
  };
  updateConnectionIndicator(status, statusLabels[status] ?? _message);

  if (status === 'connected') {
    if (hasConfirmedName) {
      nameStep.classList.add('hidden');
      settingsStep.classList.remove('hidden');
      keybindsSettingsStep.classList.add('hidden');
      document.body.classList.add('settings-view');
      updateWelcomeText();
    } else {
      nameStep.classList.remove('hidden');
      settingsStep.classList.add('hidden');
      keybindsSettingsStep.classList.add('hidden');
      document.body.classList.remove('settings-view');
    }
    fabContainer.classList.remove('hidden');
    closeFabMenu();
  } else {
    nameStep.classList.remove('hidden');
    settingsStep.classList.add('hidden');
    keybindsSettingsStep.classList.add('hidden');
    document.body.classList.remove('settings-view', 'keybinds-settings-view');
    fabContainer.classList.remove('hidden');
    closeFabMenu();
    hasConfirmedName = false;
    namesByAgent = {};
    selectedName = null;
  }
  updateSettingsState();
}

function loadKeybinds(): KeybindsConfig {
  try {
    const stored = localStorage.getItem(KEYBINDS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_KEYBINDS };
    const parsed = JSON.parse(stored) as unknown;
    if (parsed && typeof parsed === 'object' && 'ready' in parsed && 'start' in parsed && 'testRoll' in parsed) {
      return {
        ready: String((parsed as KeybindsConfig).ready || DEFAULT_KEYBINDS.ready),
        start: String((parsed as KeybindsConfig).start || DEFAULT_KEYBINDS.start),
        testRoll: String((parsed as KeybindsConfig).testRoll || DEFAULT_KEYBINDS.testRoll),
        rollDelaySeconds: Number((parsed as KeybindsConfig).rollDelaySeconds) || DEFAULT_KEYBINDS.rollDelaySeconds,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_KEYBINDS };
}

function saveKeybinds(config: KeybindsConfig): void {
  localStorage.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(config));
  ipcRenderer.send('keybinds-config', config);
}

function keyEventToAccelerator(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) {
    parts.push('CommandOrControl');
  }
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.toUpperCase();
  if (['CONTROL', 'META', 'ALT', 'SHIFT'].includes(key)) {
    return parts.join('+') || key;
  }
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    'ARROWUP': 'Up',
    'ARROWDOWN': 'Down',
    'ARROWLEFT': 'Left',
    'ARROWRIGHT': 'Right',
  };
  parts.push(keyMap[key] || key);
  return parts.join('+');
}

function formatAcceleratorForDisplay(acc: string): string {
  return acc.replace('CommandOrControl', 'Ctrl');
}

function openKeybindsSettings(): void {
  const config = loadKeybinds();
  delayInput.value = String(config.rollDelaySeconds);
  keybindReadyBtn.textContent = formatAcceleratorForDisplay(config.ready);
  keybindStartBtn.textContent = formatAcceleratorForDisplay(config.start);
  keybindTestRollBtn.textContent = formatAcceleratorForDisplay(config.testRoll);
  keybindReadyBtn.dataset.accelerator = config.ready;
  keybindStartBtn.dataset.accelerator = config.start;
  keybindTestRollBtn.dataset.accelerator = config.testRoll;

  nameStep.classList.add('hidden');
  settingsStep.classList.add('hidden');
  keybindsSettingsStep.classList.remove('hidden');
  document.body.classList.remove('settings-view');
  document.body.classList.add('keybinds-settings-view');
  fabContainer.classList.add('hidden');
  closeFabMenu();
}

function closeKeybindsSettings(): void {
  keybindsSettingsStep.classList.add('hidden');
  fabContainer.classList.remove('hidden');
  document.body.classList.remove('keybinds-settings-view');
  if (hasConfirmedName) {
    settingsStep.classList.remove('hidden');
    document.body.classList.add('settings-view');
  } else {
    nameStep.classList.remove('hidden');
  }
}

function setupKeybindCapture(btn: HTMLButtonElement, key: keyof Pick<KeybindsConfig, 'ready' | 'start' | 'testRoll'>): void {
  btn.addEventListener('click', () => {
    // If already recording, ignore repeat clicks
    if (btn.classList.contains('recording')) return;

    const originalText = btn.textContent ?? '';
    const originalAccelerator = btn.dataset.accelerator ?? '';
    btn.classList.add('recording');
    btn.textContent = 'Press keys...';

    function cleanup() {
      window.removeEventListener('keydown', keyHandler, true);
      document.removeEventListener('mousedown', cancelHandler, true);
    }

    const cancelHandler = (e: MouseEvent) => {
      // Click landed outside the button — cancel recording
      if (e.target !== btn) {
        btn.classList.remove('recording');
        btn.textContent = originalText;
        btn.dataset.accelerator = originalAccelerator;
        cleanup();
      }
    };

    const keyHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const upper = e.key.toUpperCase();
      // Ignore bare modifier keys — wait for the actual key
      if (['CONTROL', 'META', 'ALT', 'SHIFT'].includes(upper)) {
        return;
      }
      const acc = keyEventToAccelerator(e);
      btn.dataset.accelerator = acc;
      btn.textContent = formatAcceleratorForDisplay(acc);
      btn.classList.remove('recording');
      cleanup();
    };

    window.addEventListener('keydown', keyHandler, { capture: true });
    document.addEventListener('mousedown', cancelHandler, { capture: true });
  });
}

function saveKeybindsSettings(): void {
  const rollDelaySeconds = getDelaySeconds();
  const config: KeybindsConfig = {
    ready: keybindReadyBtn.dataset.accelerator || DEFAULT_KEYBINDS.ready,
    start: keybindStartBtn.dataset.accelerator || DEFAULT_KEYBINDS.start,
    testRoll: keybindTestRollBtn.dataset.accelerator || DEFAULT_KEYBINDS.testRoll,
    rollDelaySeconds,
  };
  saveKeybinds(config);
  setDelaySeconds(rollDelaySeconds);
  startDelayMs = rollDelaySeconds * 1000;
  localStorage.setItem(START_DELAY_STORAGE_KEY, String(rollDelaySeconds));
  closeKeybindsSettings();
}

function setRaidState(state: 'ready' | 'started', options?: { skipOverlay?: boolean }): void {
  raidState = state;
  if (state === 'ready') {
    readySection.classList.remove('hidden');
    postRaidSection.classList.add('hidden');
    if (!options?.skipOverlay) {
      ipcRenderer.send('show-overlay');
    }
  } else {
    readySection.classList.add('hidden');
    postRaidSection.classList.remove('hidden');
    ipcRenderer.send('hide-overlay');
  }
}

function updateReadyButton(): void {
  if (readyBtn) {
    readyBtn.textContent = isReady ? 'Ready ✓' : 'Ready';
    readyBtn.classList.toggle('ready', isReady);
  }
}

function closeFabMenu(): void {
  fabMenu.classList.add('hidden');
  fabBtn.classList.remove('open');
}

function toggleFabMenu(): void {
  const isOpen = !fabMenu.classList.contains('hidden');
  if (isOpen) {
    closeFabMenu();
  } else {
    fabMenu.classList.remove('hidden');
    fabBtn.classList.add('open');
  }
}

function connect() {
  // Clear any pending reconnect timer to prevent stacking
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  intentionalDisconnect = false;
  updateStatus('connecting', 'Connecting...');

  try {
    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
      console.log('[WS] Connected');
      setRaidState('ready');
      updateStatus('connected', 'Connected');
      // Show overlay when connected
      ipcRenderer.send('show-overlay');
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      ws = null;
      travelMode = false;
      travelBtn.textContent = 'Travel';
      travelBtn.classList.remove('execute');
      if (countdownEndTimer) {
        clearTimeout(countdownEndTimer);
        countdownEndTimer = null;
      }
      setRaidState('ready', { skipOverlay: true });

      // Reset overlay to clear stale data
      ipcRenderer.send('update-overlay', { type: 'reset' });

      if (intentionalDisconnect) {
        // User clicked disconnect - don't reconnect, hide overlay
        ipcRenderer.send('hide-overlay');
        updateStatus('disconnected', 'Disconnected');
      } else {
        // Unexpected disconnect - auto-reconnect
        updateStatus('disconnected', 'Disconnected - Reconnecting...');
        reconnectTimer = setTimeout(connect, 3000);
      }
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
          updateReadyButton();
          ipcRenderer.send('update-overlay', assigned);
        } else if (message.type === 'ready_state') {
          const readyState = message as ReadyStateMessage;
          if (agentId !== null) {
            isReady = readyState.agents[agentId] ?? false;
            updateReadyButton();
          }
          updateNames(readyState.names);
          ipcRenderer.send('update-overlay', readyState);
        } else if (message.type === 'countdown') {
          const countdownMsg = message as CountdownMessage;
          ipcRenderer.send('update-overlay', countdownMsg);
          if (countdownEndTimer) clearTimeout(countdownEndTimer);
          countdownEndTimer = setTimeout(() => {
            countdownEndTimer = null;
            setRaidState('started');
          }, countdownMsg.duration);
        } else if (message.type === 'start') {
          const startMessage = message as StartMessage;
          scheduleStartActions(startMessage.timestamp, startMessage.starterAgentId);
        } else if (message.type === 'travel_mode') {
          const travelMsg = message as { type: string; active: boolean };
          setTravelMode(travelMsg.active);
        } else if (message.type === 'execute_travel') {
          if (isReady) {
            ipcRenderer.send('start-space');
          }
        } else if (message.type === 'reset') {
          if (countdownEndTimer) {
            clearTimeout(countdownEndTimer);
            countdownEndTimer = null;
          }
          travelMode = false;
          travelBtn.textContent = 'Travel';
          travelBtn.classList.remove('execute');
          setRaidState('ready');
          ipcRenderer.send('update-overlay', { type: 'reset' });
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
  intentionalDisconnect = true;

  // Clear any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.close(); // onclose handler will reset overlay and hide it
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
    updateReadyButton();
    console.log('[WS] Sent:', message);
  } else {
    console.warn('Not connected to server');
  }
}

function sendStartRequest() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type: 'start_request', timestamp: Date.now() };
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

function sendTravelRequest() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'travel_request' }));
    console.log('[WS] Sent travel_request');
  }
}

function sendExecuteTravel() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'execute_travel' }));
    console.log('[WS] Sent execute_travel');
  }
}

function setTravelMode(active: boolean) {
  travelMode = active;
  if (active) {
    travelBtn.textContent = 'Execute Travel';
    travelBtn.classList.add('execute');
    readySection.classList.remove('hidden');
    isReady = false;
    updateReadyButton();
    ipcRenderer.send('show-overlay');
    ipcRenderer.send('update-overlay', { type: 'travel_mode', active: true });
  } else {
    travelBtn.textContent = 'Travel';
    travelBtn.classList.remove('execute');
    if (raidState === 'started') {
      readySection.classList.add('hidden');
    }
    isReady = false;
    updateReadyButton();
    ipcRenderer.send('update-overlay', { type: 'travel_mode', active: false });
    ipcRenderer.send('hide-overlay');
  }
}

function scheduleStartActions(timestamp: number, starterAgentId: number) {
  if (!agentId) {
    return;
  }
  
  if (agentId === starterAgentId) {
    // Starter always acts at exactly 3 seconds after timestamp
    const delay = Math.max(0, timestamp + STARTER_DELAY_MS - Date.now());
    setTimeout(() => {
      ipcRenderer.send('start-space');
    }, delay);
  } else {
    // Others use the customizable delay (default 2.9 seconds)
    const delay = Math.max(0, timestamp + startDelayMs - Date.now());
    setTimeout(() => {
      ipcRenderer.send('start-ctrl-tap');
    }, delay);
  }
}

function saveName(name: string) {
  const cleanName = name.trim();
  if (!cleanName) {
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = { type: 'set_name', name: cleanName };
    ws.send(JSON.stringify(message));
    localStorage.setItem('shd-display-name', cleanName);
    selectedName = cleanName;
    updateStatus('connected', 'Connected');
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

function updateWelcomeText() {
  if (welcomeText && selectedName) {
    welcomeText.textContent = `Welcome Agent ${selectedName}`;
  }
}

function updateSettingsState() {
  // Reserved for future use
}

function updateNames(names?: Record<number, string>) {
  if (!names) {
    return;
  }
  namesByAgent = names;
}

// Error banner management
function showError(message: string) {
  errorBannerText.textContent = message;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
  errorBannerText.textContent = '';
}

errorBannerDismiss.addEventListener('click', hideError);

// Listen for errors from main process
ipcRenderer.on('app-error', (_event: unknown, message: string) => {
  console.error('[Main Process Error]', message);
  showError(message);
});

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
resetRaidBtn.addEventListener('click', sendResetRaid);
delayInput.addEventListener('input', () => {
  const delaySeconds = getDelaySeconds();
  startDelayMs = delaySeconds * 1000;
});
function joinWithName() {
  const name = nameInput.value.trim();
  if (!name) return;
  saveName(name);
  hasConfirmedName = true;
  nameStep.classList.add('hidden');
  settingsStep.classList.remove('hidden');
  document.body.classList.add('settings-view');
  updateWelcomeText();
  updateSettingsState();
}

joinBtn.addEventListener('click', joinWithName);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    joinWithName();
  }
});

backBtn.addEventListener('click', () => {
  hasConfirmedName = false;
  nameStep.classList.remove('hidden');
  settingsStep.classList.add('hidden');
  document.body.classList.remove('settings-view');
  updateSettingsState();
});

fabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFabMenu();
});
editKeybindsBtn.addEventListener('click', openKeybindsSettings);
readyBtn.addEventListener('click', sendReady);
travelBtn.addEventListener('click', () => {
  if (!travelMode) {
    sendTravelRequest();
  } else {
    sendExecuteTravel();
  }
});

setupKeybindCapture(keybindReadyBtn, 'ready');
setupKeybindCapture(keybindStartBtn, 'start');
setupKeybindCapture(keybindTestRollBtn, 'testRoll');

keybindsSettingsBackBtn.addEventListener('click', closeKeybindsSettings);
saveKeybindsBtn.addEventListener('click', saveKeybindsSettings);

// Close FAB menu when clicking outside
document.addEventListener('click', (e) => {
  if (!fabContainer.contains(e.target as Node)) {
    closeFabMenu();
  }
});
// Load saved keybinds (includes roll delay) and send to main process
const initialKeybinds = loadKeybinds();
setDelaySeconds(initialKeybinds.rollDelaySeconds);
startDelayMs = initialKeybinds.rollDelaySeconds * 1000;
ipcRenderer.send('keybinds-config', initialKeybinds);

// Auto-connect on load
document.addEventListener('DOMContentLoaded', () => {
  updateReadyButton();
  const savedName = localStorage.getItem('shd-display-name');
  if (savedName) {
    nameInput.value = savedName;
  }
  connect();
});
