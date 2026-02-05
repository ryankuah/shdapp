import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from 'electron';
import * as path from 'path';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

// Auto-updater configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Load RobotJS lazily to avoid startup failure if native rebuild is missing.
let robot: { keyTap: (key: string) => void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  robot = require('@jitsi/robotjs');
} catch (error) {
  console.warn('RobotJS not available. Key simulation features will be disabled.', error);
}

let connectWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

function createConnectWindow() {
  connectWindow = new BrowserWindow({
    width: 400,
    height: 350,
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
  
  overlayWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // Make window click-through
  overlayWindow.setIgnoreMouseEvents(true);
  
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
  
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function registerGlobalHotkey() {
  // Register Ctrl+Shift+R for ready toggle
  const registered = globalShortcut.register('CommandOrControl+Shift+R', () => {
    console.log('Hotkey pressed: Ready toggle');
    // Send to connect window to broadcast via WebSocket
    if (connectWindow) {
      connectWindow.webContents.send('hotkey-ready');
    }
  });

  const registeredStart = globalShortcut.register('CommandOrControl+Shift+S', () => {
    console.log('Hotkey pressed: Start');
    if (connectWindow) {
      connectWindow.webContents.send('hotkey-start');
    }
  });

  // Test hotkey for double control tap (roll) - 1 second delay to switch focus
  const registeredTestRoll = globalShortcut.register('CommandOrControl+Shift+K', () => {
    console.log('Hotkey pressed: Test Roll (double ctrl tap) - executing in 1 second');
    setTimeout(() => {
      sendControlKeyTapTwice();
    }, 1000);
  });

  if (!registered) {
    console.error('Failed to register hotkey');
  }
  if (!registeredStart) {
    console.error('Failed to register start hotkey');
  }
  if (!registeredTestRoll) {
    console.error('Failed to register test roll hotkey');
  }
}

function sendControlKeyTapTwice() {
  if (!robot) {
    console.warn('RobotJS not loaded; skipping key taps.');
    return;
  }
  robot.keyTap('control');
  setTimeout(() => {
    robot.keyTap('control');
  }, 50);
}

function sendSpaceKeyTap() {
  if (!robot) {
    console.warn('RobotJS not loaded; skipping key taps.');
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
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWindow) {
    overlayWindow.hide();
  }
});

ipcMain.on('update-overlay', (_event, data) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('overlay-update', data);
  }
});

ipcMain.on('start-ctrl-tap', () => {
  sendControlKeyTapTwice();
});

ipcMain.on('start-space', () => {
  sendSpaceKeyTap();
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
  createConnectWindow();
  createOverlayWindow();
  registerGlobalHotkey();
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
