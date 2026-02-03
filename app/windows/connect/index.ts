import { createWSClient, WSClient } from '../../shared/ws.js';

// DOM elements
const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

let wsClient: WSClient | null = null;
let agentId: number | null = null;
let isReady = false;

function updateStatus(status: 'connected' | 'disconnected' | 'connecting', message: string) {
  statusDiv.className = `status ${status}`;
  statusDiv.textContent = message;
  
  if (status === 'connected') {
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    serverUrlInput.disabled = true;
  } else {
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
    serverUrlInput.disabled = false;
    connectBtn.disabled = status === 'connecting';
  }
}

function connect() {
  const url = serverUrlInput.value.trim();
  if (!url) {
    updateStatus('disconnected', 'Please enter a server URL');
    return;
  }

  updateStatus('connecting', 'Connecting...');
  
  wsClient = createWSClient(url, {
    onOpen: () => {
      updateStatus('connected', 'Connected');
      // Open the overlay window when connected
      openOverlayWindow();
    },
    onClose: () => {
      updateStatus('disconnected', 'Disconnected');
      wsClient = null;
      agentId = null;
      isReady = false;
    },
    onError: (error) => {
      console.error('WebSocket error:', error);
      updateStatus('disconnected', 'Connection error');
    },
    onMessage: (message) => {
      console.log('Received message:', message);
      // Forward messages to overlay window via Overwolf messaging
      if (message.type === 'agent_assigned') {
        const assigned = message as { agentId: number; agents: Record<number, boolean> };
        agentId = assigned.agentId;
        isReady = assigned.agents[assigned.agentId] ?? false;
        broadcastToOverlay(message);
      } else if (message.type === 'ready_state') {
        broadcastToOverlay(message);
      } else if (message.type === 'error') {
        updateStatus('disconnected', String(message.message ?? 'Server error'));
      }
    }
  });
}

function disconnect() {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
  agentId = null;
  isReady = false;
  updateStatus('disconnected', 'Disconnected');
}

function openOverlayWindow() {
  if (typeof overwolf !== 'undefined') {
    overwolf.windows.obtainDeclaredWindow('overlay', (result: { success: boolean; window: { id: string } }) => {
      if (result.success) {
        overwolf.windows.restore(result.window.id);
      }
    });
  }
}

function broadcastToOverlay(message: unknown) {
  if (typeof overwolf !== 'undefined') {
    overwolf.windows.getMainWindow().postMessage(message, '*');
  }
  // Also use localStorage for cross-window communication fallback
  localStorage.setItem('shd-overlay-message', JSON.stringify(message));
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'shd-overlay-message',
    newValue: JSON.stringify(message)
  }));
}

// Register hotkey handler
function registerHotkey() {
  if (typeof overwolf !== 'undefined') {
    overwolf.settings.hotkeys.onPressed.addListener((event: overwolf.settings.hotkeys.OnPressedEvent) => {
      if (event.name === 'ready_toggle') {
        toggleReady();
      }
    });
  } else {
    // Fallback for testing outside Overwolf
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        toggleReady();
      }
    });
  }
}

function toggleReady() {
  if (wsClient && wsClient.isConnected()) {
    isReady = !isReady;
    wsClient.send({ type: 'ready', value: isReady });
  } else {
    console.warn('Not connected to server');
  }
}

// Initialize
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
registerHotkey();

// Load saved URL
const savedUrl = localStorage.getItem('shd-server-url');
if (savedUrl) {
  serverUrlInput.value = savedUrl;
}

// Save URL on change
serverUrlInput.addEventListener('change', () => {
  localStorage.setItem('shd-server-url', serverUrlInput.value);
});
