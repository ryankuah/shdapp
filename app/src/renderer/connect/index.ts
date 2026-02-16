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

// Detect dev mode: when running via `electron .`, execPath points to the
// electron binary (e.g. electron.exe). When packaged, it's the app's own exe.
const isDev =
  process.execPath.toLowerCase().includes('electron') ||
  process.env.NODE_ENV === 'development' ||
  process.env.ELECTRON_IS_DEV === 'true';

const SERVER_URL = isDev ? 'ws://localhost:3001/ws' : 'wss://shd-overlay-server.fly.dev/ws';

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


const captureSourceName = document.getElementById('captureSourceName') as HTMLSpanElement;
const captureSourceBtn = document.getElementById('captureSourceBtn') as HTMLButtonElement;
const streamBtn = document.getElementById('streamBtn') as HTMLButtonElement;
const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const recordFolderPath = document.getElementById('recordFolderPath') as HTMLSpanElement;
const recordFolderBtn = document.getElementById('recordFolderBtn') as HTMLButtonElement;
const windowPickerModal = document.getElementById('windowPickerModal') as HTMLDivElement;
const windowPickerGrid = document.getElementById('windowPickerGrid') as HTMLDivElement;
const windowPickerCancel = document.getElementById('windowPickerCancel') as HTMLButtonElement;

const devBadge = document.getElementById('devBadge') as HTMLDivElement;

const errorBanner = document.getElementById('errorBanner') as HTMLDivElement;
const errorBannerText = document.getElementById('errorBannerText') as HTMLSpanElement;
const errorBannerDismiss = document.getElementById('errorBannerDismiss') as HTMLButtonElement;

const connectionStatus = document.getElementById('connectionStatus') as HTMLDivElement;
const connectionText = document.getElementById('connectionText') as HTMLSpanElement;

const KEYBINDS_STORAGE_KEY = 'shd-keybinds';
const RECORDING_FOLDER_KEY = 'shd-recording-folder';

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

// ── Streaming / Recording state ──────────────────────────────
interface CaptureSource {
  id: string;
  name: string;
  thumbnail: string;
}

let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let isStreaming = false;
let isRecording = false;
let recordingFolder: string | null = null;
let recordingFilePath: string | null = null;
let isFirstRecordChunk = true;
let cachedSourceId: string | null = null;
let cachedSourceName: string | null = null;
let pendingCaptureResolve: ((source: CaptureSource | null) => void) | null = null;


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
  updateRecordFolderDisplay();

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

// ── Window Capture ───────────────────────────────────────────

function updateCaptureSourceDisplay() {
  if (cachedSourceName) {
    captureSourceName.textContent = cachedSourceName;
    captureSourceName.classList.add('active');
    captureSourceBtn.textContent = 'Change';
  } else {
    captureSourceName.textContent = 'No window selected';
    captureSourceName.classList.remove('active');
    captureSourceBtn.textContent = 'Pick Window';
  }
}

async function pickCaptureSource(): Promise<void> {
  try {
    const sources: CaptureSource[] = await ipcRenderer.invoke('get-sources');
    if (!sources || sources.length === 0) {
      showError('No windows found to capture.');
      return;
    }
    const selected = await showWindowPicker(sources);
    if (selected) {
      cachedSourceId = selected.id;
      cachedSourceName = selected.name;
      updateCaptureSourceDisplay();
    }
  } catch (err) {
    console.error('[Capture] Failed to get sources:', err);
    showError('Failed to list windows.');
  }
}

function showWindowPicker(sources: CaptureSource[]): Promise<CaptureSource | null> {
  return new Promise((resolve) => {
    pendingCaptureResolve = resolve;
    windowPickerGrid.innerHTML = '';
    for (const source of sources) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'window-picker-item';

      const thumb = document.createElement('img');
      thumb.className = 'window-picker-thumb';
      thumb.src = source.thumbnail;
      thumb.alt = source.name;

      const name = document.createElement('span');
      name.className = 'window-picker-name';
      name.textContent = source.name;

      item.appendChild(thumb);
      item.appendChild(name);
      item.addEventListener('click', () => {
        windowPickerModal.classList.add('hidden');
        if (pendingCaptureResolve) {
          pendingCaptureResolve(source);
          pendingCaptureResolve = null;
        }
      });
      windowPickerGrid.appendChild(item);
    }
    windowPickerModal.classList.remove('hidden');
  });
}

async function startCapture(): Promise<MediaStream | null> {
  // If we already have an active stream, reuse it
  if (mediaStream && mediaStream.active) {
    return mediaStream;
  }

  try {
    const sources: CaptureSource[] = await ipcRenderer.invoke('get-sources');
    if (!sources || sources.length === 0) {
      showError('No windows found to capture.');
      return null;
    }

    let selectedSource: CaptureSource | null = null;

    // If we have a cached source, try to find it
    if (cachedSourceId) {
      selectedSource = sources.find((s) => s.id === cachedSourceId) ?? null;
    }

    // Auto-detect Division 2 window
    if (!selectedSource) {
      selectedSource = sources.find((s) =>
        s.name.toLowerCase().includes('the division 2') ||
        s.name.toLowerCase().includes('division 2')
      ) ?? null;
    }

    // Fall back to window picker
    if (!selectedSource) {
      selectedSource = await showWindowPicker(sources);
    }

    if (!selectedSource) {
      return null; // User cancelled
    }

    cachedSourceId = selectedSource.id;
    cachedSourceName = selectedSource.name;
    updateCaptureSourceDisplay();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSource.id,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      } as unknown as MediaTrackConstraints,
    });

    mediaStream = stream;

    // If the stream track ends (e.g., window closed), clean up
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      console.log('[Capture] Stream track ended');
      if (isStreaming) stopStreaming();
      if (isRecording) stopRecording();
    });

    return stream;
  } catch (err) {
    console.error('[Capture] Failed:', err);
    showError('Failed to capture window. Please try again.');
    return null;
  }
}

function stopCapture() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  cachedSourceId = null;
  cachedSourceName = null;
  updateCaptureSourceDisplay();
}

function ensureMediaRecorder(stream: MediaStream): MediaRecorder {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return mediaRecorder;
  }
  // Prefer H.264 so the server can mux to HLS without re-encoding (codec copy)
  const preferredMime = 'video/webm;codecs=h264';
  const mimeType = MediaRecorder.isTypeSupported(preferredMime)
    ? preferredMime
    : 'video/webm;codecs=vp8';
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });

  recorder.ondataavailable = async (event) => {
    if (event.data.size === 0) return;

    // Send to server if streaming
    if (isStreaming && ws && ws.readyState === WebSocket.OPEN) {
      const buffer = await event.data.arrayBuffer();
      ws.send(buffer);
    }

    // Write to disk if recording
    if (isRecording && recordingFilePath) {
      const buffer = await event.data.arrayBuffer();
      const chunk = Array.from(new Uint8Array(buffer));
      ipcRenderer.send('save-recording-chunk', {
        filePath: recordingFilePath,
        chunk,
        isFirst: isFirstRecordChunk,
      });
      isFirstRecordChunk = false;
    }
  };

  recorder.onstop = () => {
    console.log('[MediaRecorder] Stopped');
  };

  mediaRecorder = recorder;
  return recorder;
}

// ── Streaming ────────────────────────────────────────────────

async function startStreaming() {
  if (isStreaming) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showError('Not connected to server.');
    return;
  }

  const stream = await startCapture();
  if (!stream) return;

  // Always create a fresh MediaRecorder so FFmpeg receives a clean WebM header
  // with codec initialization data at the start of every stream session.
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  isStreaming = true;
  updateStreamButton();

  // Tell the server we are starting a stream
  ws.send(JSON.stringify({ type: 'stream_start' }));

  const recorder = ensureMediaRecorder(stream);
  recorder.start(500); // emit chunk every 500ms for lower latency

  console.log('[Stream] Started');
}

function stopStreaming() {
  if (!isStreaming) return;
  isStreaming = false;
  updateStreamButton();

  // Tell the server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stream_stop' }));
  }

  // If not recording either, stop capture entirely
  if (!isRecording) {
    stopCapture();
  }

  console.log('[Stream] Stopped');
}

function updateStreamButton() {
  if (isStreaming) {
    streamBtn.innerHTML = '<span class="live-dot"></span> Stop Stream';
    streamBtn.classList.add('active');
  } else {
    streamBtn.textContent = 'Stream';
    streamBtn.classList.remove('active');
  }
}

// ── Recording ────────────────────────────────────────────────

async function promptRecordingFolder(): Promise<string | null> {
  const folder: string | null = await ipcRenderer.invoke('select-recording-folder');
  if (folder) {
    recordingFolder = folder;
    localStorage.setItem(RECORDING_FOLDER_KEY, folder);
    updateRecordFolderDisplay();
  }
  return folder;
}

function updateRecordFolderDisplay() {
  if (recordingFolder) {
    // Show last part of path to keep it short
    const parts = recordingFolder.replace(/\\/g, '/').split('/');
    const display = parts.length > 2
      ? '.../' + parts.slice(-2).join('/')
      : recordingFolder;
    recordFolderPath.textContent = display;
    recordFolderPath.title = recordingFolder;
  } else {
    recordFolderPath.textContent = 'Not set';
    recordFolderPath.title = '';
  }
}

async function startRecording() {
  if (isRecording) return;

  // Ensure recording folder is set
  if (!recordingFolder) {
    const folder = await promptRecordingFolder();
    if (!folder) return; // user cancelled
  }

  const stream = await startCapture();
  if (!stream) return;

  // Build file path
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const agentName = selectedName ?? 'agent';
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
  recordingFilePath = `${recordingFolder}/${safeName}_${timestamp}.webm`.replace(/\//g, '\\');
  isFirstRecordChunk = true;
  isRecording = true;
  updateRecordButton();

  const recorder = ensureMediaRecorder(stream);

  // Start recording chunks if not already started
  if (recorder.state === 'inactive') {
    recorder.start(1000);
  }

  console.log('[Record] Started:', recordingFilePath);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  updateRecordButton();

  if (recordingFilePath) {
    ipcRenderer.send('finalize-recording', recordingFilePath);
    recordingFilePath = null;
  }

  // If not streaming either, stop capture entirely
  if (!isStreaming) {
    stopCapture();
  }

  console.log('[Record] Stopped');
}

function updateRecordButton() {
  if (isRecording) {
    recordBtn.innerHTML = '<span class="rec-dot"></span> Stop Rec';
    recordBtn.classList.add('active');
  } else {
    recordBtn.textContent = 'Record';
    recordBtn.classList.remove('active');
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

  // Stop streaming/recording before disconnecting
  if (isStreaming) stopStreaming();
  if (isRecording) stopRecording();

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

captureSourceBtn.addEventListener('click', () => {
  pickCaptureSource();
});

streamBtn.addEventListener('click', () => {
  if (isStreaming) {
    stopStreaming();
  } else {
    startStreaming();
  }
});

recordBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

recordFolderBtn.addEventListener('click', () => {
  promptRecordingFolder();
});

windowPickerCancel.addEventListener('click', () => {
  windowPickerModal.classList.add('hidden');
  if (pendingCaptureResolve) {
    pendingCaptureResolve(null);
    pendingCaptureResolve = null;
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
// Show DEV badge immediately when running in development
if (isDev && devBadge) {
  devBadge.classList.remove('hidden');
  console.log('[DEV] Running in development mode — connecting to', SERVER_URL);
}

// Load saved keybinds (includes roll delay) and send to main process
const initialKeybinds = loadKeybinds();
setDelaySeconds(initialKeybinds.rollDelaySeconds);
startDelayMs = initialKeybinds.rollDelaySeconds * 1000;
ipcRenderer.send('keybinds-config', initialKeybinds);

// Load saved recording folder
recordingFolder = localStorage.getItem(RECORDING_FOLDER_KEY);
updateRecordFolderDisplay();

// Auto-connect on load
document.addEventListener('DOMContentLoaded', () => {
  updateReadyButton();
  updateStreamButton();
  updateRecordButton();
  const savedName = localStorage.getItem('shd-display-name');
  if (savedName) {
    nameInput.value = savedName;
  }
  connect();
});
