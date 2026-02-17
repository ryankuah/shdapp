import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

// Fix for HDR (10-bit) displays — desktopCapturer requires 8-bit RGBA
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// Auto-updater configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Load RobotJS — required for key simulation features.
let robot: { keyTap: (key: string) => void } | null = null;
let robotjsError: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  robot = require('@jitsi/robotjs');
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  robotjsError = `RobotJS failed to load: ${msg}`;
  console.error(robotjsError);
}

let connectWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayReady = false;
let pendingOverlayMessages: unknown[] = [];

function createConnectWindow() {
  connectWindow = new BrowserWindow({
    width: 420,
    height: 580,
    minWidth: 360,
    minHeight: 480,
    resizable: true,
    frame: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
    icon: path.join(__dirname, '../../icons/icon.png'),
  });

  connectWindow.loadFile(path.join(__dirname, '../renderer/connect/index.html'));

  // Handle getDisplayMedia() calls from the renderer.
  // Used to grab system audio loopback — the video track is discarded by the renderer.
  connectWindow.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources[0]) {
      callback({});
      return;
    }
    callback({ video: sources[0], audio: 'loopback' });
  });

  connectWindow.webContents.on('did-finish-load', () => {
    if (robotjsError && connectWindow) {
      connectWindow.webContents.send('app-error', robotjsError);
    }
  });

  connectWindow.on('closed', () => {
    connectWindow = null;
    // Close overlay when main window closes
    if (overlayWindow) {
      overlayWindow.close();
    }
    app.quit();
  });
}

function createOverlayWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  overlayReady = false;
  pendingOverlayMessages = [];

  overlayWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false, // Don't show until renderer is loaded — prevents blank overlay
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // Use 'screen-saver' level so overlay stays above fullscreen games
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true);

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayReady = true;
    // Flush any messages that arrived while the overlay was loading
    for (const msg of pendingOverlayMessages) {
      overlayWindow?.webContents.send('overlay-update', msg);
    }
    pendingOverlayMessages = [];
    // Now safe to show
    overlayWindow?.show();
  });
  
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayReady = false;
    pendingOverlayMessages = [];
  });
}

interface KeybindsConfig {
  ready: string;
  start: string;
  testRoll: string;
  rollDelaySeconds?: number;
}

const DEFAULT_KEYBINDS: KeybindsConfig = {
  ready: 'CommandOrControl+Shift+R',
  start: 'CommandOrControl+Shift+S',
  testRoll: 'CommandOrControl+Shift+K',
};

let currentKeybinds: KeybindsConfig = { ...DEFAULT_KEYBINDS };

function registerKeybinds(config: KeybindsConfig) {
  globalShortcut.unregisterAll();

  const registered = globalShortcut.register(config.ready, () => {
    if (connectWindow) connectWindow.webContents.send('hotkey-ready');
  });
  const registeredStart = globalShortcut.register(config.start, () => {
    if (connectWindow) connectWindow.webContents.send('hotkey-start');
  });
  const registeredTestRoll = globalShortcut.register(config.testRoll, () => {
    setTimeout(() => sendControlKeyTapTwice(), 1000);
  });

  const failures: string[] = [];
  if (!registered) failures.push(`Ready (${config.ready})`);
  if (!registeredStart) failures.push(`Start (${config.start})`);
  if (!registeredTestRoll) failures.push(`Test Roll (${config.testRoll})`);

  if (failures.length > 0) {
    const msg = `Failed to register hotkeys: ${failures.join(', ')}. Another app may be using them.`;
    console.error(msg);
    if (connectWindow) {
      connectWindow.webContents.send('app-error', msg);
    }
  }

  currentKeybinds = { ...config };
}

function sendControlKeyTapTwice() {
  if (!robot) {
    const msg = robotjsError || 'RobotJS not loaded — key simulation unavailable.';
    console.error(msg);
    if (connectWindow) connectWindow.webContents.send('app-error', msg);
    return;
  }
  robot.keyTap('control');
  setTimeout(() => {
    robot!.keyTap('control');
  }, 50);
}

function sendSpaceKeyTap() {
  if (!robot) {
    const msg = robotjsError || 'RobotJS not loaded — key simulation unavailable.';
    console.error(msg);
    if (connectWindow) connectWindow.webContents.send('app-error', msg);
    return;
  }
  robot.keyTap('space');
}

// IPC handlers
ipcMain.on('show-overlay', () => {
  if (!overlayWindow) {
    createOverlayWindow();
  } else {
    overlayWindow.show();
    // Re-assert on every show — Windows can lose alwaysOnTop after hide/show cycles
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWindow) {
    overlayWindow.hide();
  }
});

ipcMain.on('update-overlay', (_event, data) => {
  if (overlayWindow) {
    if (overlayReady) {
      overlayWindow.webContents.send('overlay-update', data);
    } else {
      // Queue messages until overlay renderer is loaded
      pendingOverlayMessages.push(data);
    }
  }
});

ipcMain.on('start-ctrl-tap', () => {
  sendControlKeyTapTwice();
});

ipcMain.on('start-space', () => {
  sendSpaceKeyTap();
});

ipcMain.on('keybinds-config', (_event, config: KeybindsConfig) => {
  const merged = {
    ready: config.ready || DEFAULT_KEYBINDS.ready,
    start: config.start || DEFAULT_KEYBINDS.start,
    testRoll: config.testRoll || DEFAULT_KEYBINDS.testRoll,
  };
  registerKeybinds(merged);
});

// ── Streaming / Recording IPC handlers ──────────────────────────────

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// No-op — the renderer calls this before getDisplayMedia() to signal intent.
// The handler always picks the first screen source for audio loopback.
ipcMain.handle('set-pending-display', () => {});

ipcMain.handle('select-recording-folder', async () => {
  if (!connectWindow) return null;
  const result = await dialog.showOpenDialog(connectWindow, {
    properties: ['openDirectory'],
    title: 'Select Recording Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.on('save-recording-chunk', (_event, payload: { filePath: string; chunk: number[]; isFirst: boolean }) => {
  try {
    const buffer = Buffer.from(payload.chunk);
    if (payload.isFirst) {
      fs.writeFileSync(payload.filePath, buffer);
    } else {
      fs.appendFileSync(payload.filePath, buffer);
    }
  } catch (err) {
    console.error('Failed to write recording chunk:', err);
  }
});

ipcMain.on('finalize-recording', (_event, filePath: string) => {
  console.log('Recording finalized:', filePath);
});

// Auto-updater event handlers
function setupAutoUpdater() {
  // Skip updates in development
  if (!app.isPackaged) {
    console.log('Skipping auto-update check in development mode');
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('Update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    console.log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('Update downloaded:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you restart the app.',
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on('error', (error: Error) => {
    console.error('Auto-updater error:', error);
  });

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify();
}

// App lifecycle
app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // Remove File, Edit, View, etc. menu bar
  createConnectWindow();
  createOverlayWindow();
  registerKeybinds(DEFAULT_KEYBINDS);
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createConnectWindow();
  }
});
