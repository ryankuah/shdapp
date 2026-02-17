import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
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

// ── FFmpeg binary path ──────────────────────────────────────────
const ffmpegPath: string = app.isPackaged
  ? path.join(process.resourcesPath, 'ffmpeg.exe')
  : (() => {
      try { return require('ffmpeg-static') as string; }
      catch { return 'ffmpeg'; }
    })();

// ── FFmpeg hardware encoder detection ───────────────────────────
type EncoderConfig = { name: string; args: string[] };

const ENCODER_CHAIN: EncoderConfig[] = [
  { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr'] },
  { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cbr'] },
  { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast'] },
  { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency'] },
];

let detectedEncoder: EncoderConfig | null = null;

async function detectHardwareEncoder(): Promise<EncoderConfig> {
  if (detectedEncoder) return detectedEncoder;

  for (const enc of ENCODER_CHAIN) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const proc = execFile(ffmpegPath, [
          '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=1',
          ...enc.args.slice(0, 2), // just -c:v <encoder>
          '-frames:v', '1',
          '-f', 'null', '-',
        ], { timeout: 5000 }, (err) => {
          resolve(!err);
        });
        proc.on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[FFmpeg] Detected hardware encoder: ${enc.name}`);
        detectedEncoder = enc;
        return enc;
      }
    } catch {
      // try next
    }
  }

  // Should not reach here since libx264 is always available
  console.log('[FFmpeg] Falling back to libx264');
  detectedEncoder = ENCODER_CHAIN[ENCODER_CHAIN.length - 1];
  return detectedEncoder;
}

// ── FFmpeg capture pipeline state ───────────────────────────────
interface FFmpegStreamConfig {
  windowTitle: string;
  width: number;
  height: number;
  fps: number;
  recordingPath?: string;
  audioDevice?: string;
}

async function listAudioDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = execFile(ffmpegPath, [
      '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy',
    ], { timeout: 5000 }, (_err, _stdout, stderr) => {
      const output = stderr || '';
      const devices: string[] = [];
      let inAudio = false;
      for (const line of output.split('\n')) {
        if (line.includes('DirectShow audio devices')) {
          inAudio = true;
          continue;
        }
        if (inAudio && line.includes('DirectShow video devices')) {
          break;
        }
        if (inAudio) {
          const match = line.match(/"([^"]+)"/);
          if (match && !line.includes('Alternative name')) {
            devices.push(match[1]);
          }
        }
      }
      resolve(devices);
    });
    proc.on('error', () => resolve([]));
  });
}

let ffmpegProcess: ChildProcess | null = null;

function getBitrateForQuality(width: number, height: number, fps: number): { bitrate: string; maxrate: string } {
  if (height >= 1080) {
    return fps >= 60
      ? { bitrate: '8M', maxrate: '10M' }
      : { bitrate: '6M', maxrate: '8M' };
  }
  return fps >= 60
    ? { bitrate: '5M', maxrate: '6M' }
    : { bitrate: '3M', maxrate: '4M' };
}

async function startFFmpegStream(config: FFmpegStreamConfig): Promise<void> {
  if (ffmpegProcess) {
    stopFFmpegStream();
  }

  const encoder = await detectHardwareEncoder();
  const { bitrate, maxrate } = getBitrateForQuality(config.width, config.height, config.fps);

  const hasAudio = !!config.audioDevice;

  const outputArgs: string[] = [];
  if (config.recordingPath) {
    // Tee muxer: output to both pipe (MPEG-TS for streaming) and file (MP4 for recording)
    const maps = hasAudio ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0'];
    outputArgs.push(
      '-f', 'tee',
      ...maps,
      `[f=mpegts]pipe:1|[f=mp4:movflags=+frag_keyframe+empty_moov]${config.recordingPath}`,
    );
  } else {
    if (hasAudio) {
      outputArgs.push('-map', '0:v:0', '-map', '1:a:0');
    }
    outputArgs.push('-f', 'mpegts', 'pipe:1');
  }

  const audioInputArgs: string[] = hasAudio
    ? ['-f', 'dshow', '-i', `audio=${config.audioDevice}`]
    : [];

  const audioEncodeArgs: string[] = hasAudio
    ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000']
    : [];

  const args = [
    // Input 0: gdigrab window capture (no -video_size — capture full window, then scale)
    '-f', 'gdigrab',
    '-framerate', String(config.fps),
    '-i', `title=${config.windowTitle}`,
    // Input 1 (optional): audio device
    ...audioInputArgs,
    // Scale to target resolution (handles windows that aren't exactly 1920x1080)
    '-vf', `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`,
    // Video encoder
    ...encoder.args,
    '-b:v', bitrate,
    '-maxrate', maxrate,
    '-bufsize', `${parseInt(maxrate) * 2}M`,
    '-g', String(config.fps * 2), // keyframe every 2 seconds
    '-keyint_min', String(config.fps),
    // Audio encoder
    ...audioEncodeArgs,
    // Output
    ...outputArgs,
  ];

  console.log(`[FFmpeg] Starting capture: ${encoder.name} ${config.width}x${config.height}@${config.fps}fps ${bitrate}${hasAudio ? ` audio="${config.audioDevice}"` : ' (no audio)'}`);


  const proc = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    // Send encoded MPEG-TS chunks to the renderer for WebSocket forwarding
    if (connectWindow) {
      connectWindow.webContents.send('ffmpeg-chunk', chunk);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) {
      console.log(`[FFmpeg] ${msg}`);
    }
  });

  proc.on('close', (code) => {
    console.log(`[FFmpeg] Process exited with code ${code}`);
    ffmpegProcess = null;
    if (connectWindow) {
      connectWindow.webContents.send('ffmpeg-stopped', code);
    }
  });

  proc.on('error', (err) => {
    console.error('[FFmpeg] Process error:', err);
    ffmpegProcess = null;
    if (connectWindow) {
      connectWindow.webContents.send('ffmpeg-error', err.message);
    }
  });

  // Handle stdin errors (process may die before we stop writing)
  proc.stdin?.on('error', () => {});

  ffmpegProcess = proc;
}

function stopFFmpegStream(): void {
  if (ffmpegProcess) {
    console.log('[FFmpeg] Stopping capture');
    // Send 'q' to FFmpeg stdin for graceful shutdown (finalizes MP4 recordings)
    ffmpegProcess.stdin?.write('q');
    // Force kill after 3 seconds if it doesn't exit
    const proc = ffmpegProcess;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 3000);
    ffmpegProcess = null;
  }
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

ipcMain.handle('select-recording-folder', async () => {
  if (!connectWindow) return null;
  const result = await dialog.showOpenDialog(connectWindow, {
    properties: ['openDirectory'],
    title: 'Select Recording Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// FFmpeg capture pipeline IPC
ipcMain.on('start-ffmpeg-stream', (_event, config: FFmpegStreamConfig) => {
  startFFmpegStream(config).catch((err) => {
    console.error('[FFmpeg] Failed to start:', err);
    if (connectWindow) {
      connectWindow.webContents.send('ffmpeg-error', String(err));
    }
  });
});

ipcMain.on('stop-ffmpeg-stream', () => {
  stopFFmpegStream();
});

ipcMain.handle('get-audio-devices', async () => {
  return listAudioDevices();
});

// Detect encoder on startup so there's no delay on first stream
ipcMain.handle('detect-encoder', async () => {
  const enc = await detectHardwareEncoder();
  return enc.name;
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
  stopFFmpegStream();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createConnectWindow();
  }
});
