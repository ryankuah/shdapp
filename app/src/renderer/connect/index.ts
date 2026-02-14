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

interface PhaseConfigMessage extends WSMessage {
  type: 'phase_config';
  phases: string[];
  currentPhase: string;
  currentPhaseIndex: number;
}

interface RolesConfigMessage extends WSMessage {
  type: 'roles_config';
  roles: Record<string, Record<number, string>>;
}

const isDev =
  process.env.NODE_ENV === 'development' ||
  process.env.ELECTRON_IS_DEV === 'true' ||
  process.defaultApp === true;

const SERVER_URL = isDev ? 'ws://localhost:3000/ws' : 'wss://shd-overlay-server.fly.dev/ws';

// DOM elements
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
const nameGrid = document.getElementById('nameGrid') as HTMLDivElement;
const delayInput = document.getElementById('startDelay') as HTMLInputElement;
const resetRaidBtn = document.getElementById('resetRaidBtn') as HTMLButtonElement;
const nameStep = document.getElementById('nameStep') as HTMLDivElement;
const settingsStep = document.getElementById('settingsStep') as HTMLDivElement;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const welcomeText = document.getElementById('welcomeText') as HTMLSpanElement;
const settingsBtnGroup = document.getElementById('settingsBtnGroup') as HTMLDivElement;
const editNamesBtn = document.getElementById('editNamesBtn') as HTMLButtonElement;
const editPhasesBtn = document.getElementById('editPhasesBtn') as HTMLButtonElement;
const editRolesBtn = document.getElementById('editRolesBtn') as HTMLButtonElement;
const nameSettingsStep = document.getElementById('nameSettingsStep') as HTMLDivElement;
const nameSettingsBackBtn = document.getElementById('nameSettingsBackBtn') as HTMLButtonElement;
const saveNameSettingsBtn = document.getElementById('saveNameSettingsBtn') as HTMLButtonElement;
const phasesSettingsStep = document.getElementById('phasesSettingsStep') as HTMLDivElement;
const phasesSettingsBackBtn = document.getElementById('phasesSettingsBackBtn') as HTMLButtonElement;
const phasesContainer = document.getElementById('phasesContainer') as HTMLDivElement;
const addPhaseBtn = document.getElementById('addPhaseBtn') as HTMLButtonElement;
const savePhasesBtn = document.getElementById('savePhasesBtn') as HTMLButtonElement;
const rolesSettingsStep = document.getElementById('rolesSettingsStep') as HTMLDivElement;
const rolesSettingsBackBtn = document.getElementById('rolesSettingsBackBtn') as HTMLButtonElement;
const phaseSelect = document.getElementById('phaseSelect') as HTMLSelectElement;
const rolesContainer = document.getElementById('rolesContainer') as HTMLDivElement;
const saveRolesBtn = document.getElementById('saveRolesBtn') as HTMLButtonElement;
const currentPhaseDisplay = document.getElementById('currentPhaseDisplay') as HTMLDivElement;
const nextPhaseBtn = document.getElementById('nextPhaseBtn') as HTMLButtonElement;
const NAME_INPUT_IDS = ['nameInput0', 'nameInput1', 'nameInput2', 'nameInput3', 'nameInput4', 'nameInput5', 'nameInput6', 'nameInput7'] as const;
let nameButtons: HTMLButtonElement[] = [];

const DEFAULT_AGENT_NAMES = [
  'Flamingskull',
  'Chonko',
  'Thunndarr',
  'SS-R',
  'Pear123451',
  'YellowBirb',
  'VibronicWand',
  'Sunraiser',
];
const AGENT_NAMES_STORAGE_KEY = 'shd-agent-names';
const PHASES_STORAGE_KEY = 'shd-phases';
const ROLES_STORAGE_KEY = 'shd-phase-roles';

let ws: WebSocket | null = null;
let agentId: number | null = null;
let isReady = false;
let selectedName: string | null = null;
let startDelayMs = 2000;
let hasConfirmedName = false;
let namesByAgent: Record<number, string> = {};
let intentionalDisconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let configuredPhases: string[] = [];
let currentPhase = 'Ready';
let phaseRoles: Record<string, Record<number, string>> = {};
let phasesEditBuffer: string[] = [];

const DEFAULT_START_DELAY_SECONDS = 2.9;
const STARTER_DELAY_MS = 3000; // Starter always acts at exactly 3 seconds
const START_DELAY_STORAGE_KEY = 'shd-start-delay-seconds';

delayInput.disabled = true;

function loadAgentNames(): string[] {
  try {
    const stored = localStorage.getItem(AGENT_NAMES_STORAGE_KEY);
    if (!stored) return [...DEFAULT_AGENT_NAMES];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 8) return [...DEFAULT_AGENT_NAMES];
    return parsed.map((v, i) =>
      typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_AGENT_NAMES[i] ?? ''
    );
  } catch {
    return [...DEFAULT_AGENT_NAMES];
  }
}

function saveAgentNames(names: string[]): void {
  localStorage.setItem(AGENT_NAMES_STORAGE_KEY, JSON.stringify(names));
}

function loadPhases(): string[] {
  try {
    const stored = localStorage.getItem(PHASES_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, 32);
  } catch {
    return [];
  }
}

function savePhases(phases: string[]): void {
  localStorage.setItem(PHASES_STORAGE_KEY, JSON.stringify(phases));
}

function loadRoles(): Record<string, Record<number, string>> {
  try {
    const stored = localStorage.getItem(ROLES_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, Record<number, string>> = {};
    for (const [phase, roles] of Object.entries(parsed)) {
      if (typeof phase === 'string' && roles && typeof roles === 'object') {
        const roleMap: Record<number, string> = {};
        for (const [k, v] of Object.entries(roles)) {
          const id = Number(k);
          if (Number.isInteger(id) && typeof v === 'string') {
            roleMap[id] = v;
          }
        }
        result[phase] = roleMap;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveRoles(roles: Record<string, Record<number, string>>): void {
  localStorage.setItem(ROLES_STORAGE_KEY, JSON.stringify(roles));
}

function renderNameGrid(): void {
  const names = loadAgentNames();
  nameGrid.innerHTML = '';
  for (const name of names) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'name-option';
    btn.dataset.name = name;
    btn.textContent = name;
    nameGrid.appendChild(btn);
  }
  nameButtons = Array.from(nameGrid.querySelectorAll('button')) as HTMLButtonElement[];
  if (selectedName) {
    const hasMatch = nameButtons.some((b) => b.dataset.name === selectedName);
    if (hasMatch) {
      setSelectedName(selectedName);
    } else {
      selectedName = null;
    }
  }
  updateNameButtons();
}

function updateStatus(status: 'connected' | 'disconnected' | 'connecting', _message: string) {
  if (status === 'connected') {
    if (hasConfirmedName) {
      nameStep.classList.add('hidden');
      settingsStep.classList.remove('hidden');
      nameSettingsStep.classList.add('hidden');
      phasesSettingsStep.classList.add('hidden');
      rolesSettingsStep.classList.add('hidden');
      document.body.classList.add('settings-view');
      updateWelcomeText();
    } else {
      nameStep.classList.remove('hidden');
      settingsStep.classList.add('hidden');
      nameSettingsStep.classList.add('hidden');
      phasesSettingsStep.classList.add('hidden');
      rolesSettingsStep.classList.add('hidden');
      document.body.classList.remove('settings-view');
    }
    settingsBtnGroup.classList.remove('hidden');
  } else {
    nameStep.classList.remove('hidden');
    settingsStep.classList.add('hidden');
    nameSettingsStep.classList.add('hidden');
    phasesSettingsStep.classList.add('hidden');
    rolesSettingsStep.classList.add('hidden');
    document.body.classList.remove('settings-view', 'name-settings-view', 'phases-settings-view', 'roles-settings-view');
    settingsBtnGroup.classList.remove('hidden');
    hasConfirmedName = false;
    namesByAgent = {};
    clearSelectedName();
  }
  updateSettingsState();
  updateNameButtons();
}

function getTakenNamesByOthers(): Set<string> {
  const taken = new Set<string>();
  Object.entries(namesByAgent).forEach(([id, name]) => {
    const numericId = Number(id);
    if (!Number.isNaN(numericId) && agentId !== numericId) {
      taken.add(name);
    }
  });
  return taken;
}

function openNameSettings(): void {
  const names = loadAgentNames();
  const takenByOthers = getTakenNamesByOthers();
  NAME_INPUT_IDS.forEach((id, i) => {
    const input = document.getElementById(id) as HTMLInputElement;
    if (input) {
      input.value = names[i] ?? '';
      input.disabled = takenByOthers.has(names[i] ?? '');
    }
  });
  nameStep.classList.add('hidden');
  settingsStep.classList.add('hidden');
  phasesSettingsStep.classList.add('hidden');
  rolesSettingsStep.classList.add('hidden');
  nameSettingsStep.classList.remove('hidden');
  document.body.classList.remove('settings-view');
  document.body.classList.add('name-settings-view');
  settingsBtnGroup.classList.add('hidden');
}

function closeNameSettings(): void {
  nameSettingsStep.classList.add('hidden');
  settingsBtnGroup.classList.remove('hidden');
  document.body.classList.remove('name-settings-view');
  if (hasConfirmedName) {
    settingsStep.classList.remove('hidden');
    document.body.classList.add('settings-view');
  } else {
    nameStep.classList.remove('hidden');
  }
}

function updateCurrentPhaseDisplay(): void {
  if (currentPhaseDisplay) {
    currentPhaseDisplay.textContent = `Phase: ${currentPhase}`;
  }
}

function openPhasesSettings(): void {
  phasesEditBuffer = configuredPhases.length > 0 ? [...configuredPhases] : loadPhases();
  renderPhasesInputs();
  nameStep.classList.add('hidden');
  settingsStep.classList.add('hidden');
  nameSettingsStep.classList.add('hidden');
  rolesSettingsStep.classList.add('hidden');
  phasesSettingsStep.classList.remove('hidden');
  document.body.classList.remove('settings-view');
  document.body.classList.add('phases-settings-view');
  settingsBtnGroup.classList.add('hidden');
}

function renderPhasesInputs(): void {
  phasesContainer.innerHTML = '';
  phasesEditBuffer.forEach((phase, i) => {
    const row = document.createElement('div');
    row.className = 'phase-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = phase;
    input.placeholder = `Phase ${i + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      phasesEditBuffer.splice(i, 1);
      renderPhasesInputs();
    });
    row.append(input, removeBtn);
    phasesContainer.appendChild(row);
  });
}

function closePhasesSettings(): void {
  phasesSettingsStep.classList.add('hidden');
  settingsBtnGroup.classList.remove('hidden');
  document.body.classList.remove('phases-settings-view');
  if (hasConfirmedName) {
    settingsStep.classList.remove('hidden');
    document.body.classList.add('settings-view');
  } else {
    nameStep.classList.remove('hidden');
  }
}

function savePhasesSettings(): void {
  const rows = phasesContainer.querySelectorAll('.phase-input-row');
  const newPhases: string[] = [];
  rows.forEach((row) => {
    const input = row.querySelector('input') as HTMLInputElement | null;
    const value = input?.value?.trim() ?? '';
    if (value) newPhases.push(value);
  });
  configuredPhases = newPhases;
  phasesEditBuffer = newPhases;
  savePhases(newPhases);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_phases', phases: newPhases }));
  }
  closePhasesSettings();
}

function openRolesSettings(): void {
  const phases = configuredPhases.length > 0 ? configuredPhases : loadPhases();
  if (Object.keys(phaseRoles).length === 0) {
    phaseRoles = loadRoles();
  }
  phaseSelect.innerHTML = '';
  phases.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    phaseSelect.appendChild(opt);
  });
  if (phases.length > 0 && !phaseSelect.value) {
    phaseSelect.selectedIndex = 0;
  }
  phaseSelect.onchange = renderRolesForSelectedPhase;
  renderRolesForSelectedPhase();
  nameStep.classList.add('hidden');
  settingsStep.classList.add('hidden');
  nameSettingsStep.classList.add('hidden');
  phasesSettingsStep.classList.add('hidden');
  rolesSettingsStep.classList.remove('hidden');
  document.body.classList.remove('settings-view');
  document.body.classList.add('roles-settings-view');
  settingsBtnGroup.classList.add('hidden');
}

function renderRolesForSelectedPhase(): void {
  const phase = phaseSelect.value;
  rolesContainer.innerHTML = '';
  if (!phase) return;
  const roles = phaseRoles[phase] ?? {};
  const names = loadAgentNames();
  for (let i = 0; i < 8; i += 1) {
    const agentId = i + 1;
    const row = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = `${names[i] || `Slot ${agentId}`} (Agent ${agentId})`;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.agentId = String(agentId);
    input.value = roles[agentId] ?? '';
    input.placeholder = 'Role';
    row.append(label, input);
    rolesContainer.appendChild(row);
  }
}

function closeRolesSettings(): void {
  phaseSelect.onchange = null;
  rolesSettingsStep.classList.add('hidden');
  settingsBtnGroup.classList.remove('hidden');
  document.body.classList.remove('roles-settings-view');
  if (hasConfirmedName) {
    settingsStep.classList.remove('hidden');
    document.body.classList.add('settings-view');
  } else {
    nameStep.classList.remove('hidden');
  }
}

function saveRolesSettings(): void {
  const phase = phaseSelect.value;
  if (!phase) {
    closeRolesSettings();
    return;
  }
  const inputs = rolesContainer.querySelectorAll('input[data-agent-id]');
  const roles: Record<number, string> = phaseRoles[phase] ? { ...phaseRoles[phase] } : {};
  inputs.forEach((input) => {
    const agentId = Number((input as HTMLInputElement).dataset.agentId);
    if (Number.isInteger(agentId)) {
      const value = (input as HTMLInputElement).value?.trim() ?? '';
      if (value) {
        roles[agentId] = value;
      } else {
        delete roles[agentId];
      }
    }
  });
  phaseRoles[phase] = roles;
  saveRoles(phaseRoles);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_roles', roles: phaseRoles }));
  }
  closeRolesSettings();
}

function saveNameSettings(): void {
  const names = loadAgentNames();
  const newNames: string[] = [];
  NAME_INPUT_IDS.forEach((id, i) => {
    const input = document.getElementById(id) as HTMLInputElement;
    const value = input?.value?.trim() ?? '';
    newNames.push((value || DEFAULT_AGENT_NAMES[i]) ?? '');
  });
  saveAgentNames(newNames);

  const selectedSlotIndex = selectedName ? names.findIndex((n) => n === selectedName) : -1;
  const wasUserSlotRenamed =
    selectedSlotIndex >= 0 && newNames[selectedSlotIndex] !== selectedName;

  if (wasUserSlotRenamed && newNames[selectedSlotIndex]) {
    const newName = newNames[selectedSlotIndex];
    if (ws && ws.readyState === WebSocket.OPEN && agentId !== null) {
      ws.send(JSON.stringify({ type: 'set_name', name: newName }));
      localStorage.setItem('shd-display-name', newName);
      selectedName = newName;
      namesByAgent[agentId] = newName;
      updateWelcomeText();
      ipcRenderer.send('update-overlay', { type: 'ready_state', agents: {}, names: { ...namesByAgent } });
    }
  }

  renderNameGrid();
  if (selectedName) {
    setSelectedName(selectedName);
  }
  closeNameSettings();
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
      updateStatus('connected', 'Connected');
      // Show overlay when connected
      ipcRenderer.send('show-overlay');
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      ws = null;

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
        } else if (message.type === 'phase_config') {
          const phaseConfig = message as PhaseConfigMessage;
          configuredPhases = phaseConfig.phases ?? [];
          currentPhase = phaseConfig.currentPhase ?? 'Ready';
          updateCurrentPhaseDisplay();
          ipcRenderer.send('update-overlay', phaseConfig);
        } else if (message.type === 'roles_config') {
          const rolesConfig = message as RolesConfigMessage;
          phaseRoles = rolesConfig.roles ?? {};
          ipcRenderer.send('update-overlay', rolesConfig);
        } else if (message.type === 'reset') {
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

ipcRenderer.on('hotkey-advance-phase', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'advance_phase' }));
  }
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
    updateWelcomeText();
    updateSettingsState();
  }
});

backBtn.addEventListener('click', () => {
  hasConfirmedName = false;
  nameStep.classList.remove('hidden');
  settingsStep.classList.add('hidden');
  document.body.classList.remove('settings-view');
  updateSettingsState();
});

editNamesBtn.addEventListener('click', openNameSettings);
editPhasesBtn.addEventListener('click', openPhasesSettings);
editRolesBtn.addEventListener('click', openRolesSettings);
saveNameSettingsBtn.addEventListener('click', saveNameSettings);
nameSettingsBackBtn.addEventListener('click', closeNameSettings);
phasesSettingsBackBtn.addEventListener('click', closePhasesSettings);
addPhaseBtn.addEventListener('click', () => {
  phasesEditBuffer.push('');
  renderPhasesInputs();
});
savePhasesBtn.addEventListener('click', savePhasesSettings);
rolesSettingsBackBtn.addEventListener('click', closeRolesSettings);
saveRolesBtn.addEventListener('click', saveRolesSettings);
nextPhaseBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'advance_phase' }));
  }
});

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
  renderNameGrid();
  updateCurrentPhaseDisplay();
  const savedName = localStorage.getItem('shd-display-name');
  if (savedName) {
    const hasOption = nameButtons.some((button) => button.dataset.name === savedName);
    if (hasOption) {
      setSelectedName(savedName);
    }
  }
  connect();
});
