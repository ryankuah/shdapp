import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Message types
interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface ReadyMessage extends WSMessage {
  type: 'ready';
  value: boolean;
}

interface ReadyStateMessage extends WSMessage {
  type: 'ready_state';
  agents: Record<number, boolean>;
  names: Record<number, string>;
}

interface AgentAssignedMessage extends WSMessage {
  type: 'agent_assigned';
  agentId: number;
  agents: Record<number, boolean>;
  names: Record<number, string>;
}

interface SetNameMessage extends WSMessage {
  type: 'set_name';
  name: string;
}

interface StartRequestMessage extends WSMessage {
  type: 'start_request';
}

interface StartBroadcastMessage extends WSMessage {
  type: 'start';
  timestamp: number;
  starterAgentId: number;
}

const MAX_AGENTS = 8;

// Connected clients tracking
const clients = new Set<WebSocket>();
const clientAgents = new Map<WebSocket, number>();
const agentReadyState = new Map<number, boolean>();
const agentNames = new Map<number, string>();
let travelMode = false;

// ── Streaming state ─────────────────────────────────────────
const HLS_ROOT = process.env.NODE_ENV === 'production' ? '/data/hls' : path.join(__dirname, '../data/hls');
const RECORDINGS_ROOT = process.env.NODE_ENV === 'production' ? '/data/recordings' : path.join(__dirname, '../data/recordings');

// Resolve FFmpeg binary — use FFMPEG_PATH env var, or fall back to 'ffmpeg' (expects it on PATH)
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

interface ActiveStream {
  agentId: number;
  agentName: string;
  ffmpegProcess: ChildProcess;
  recordingPath: string;
  recordingStream: fs.WriteStream;
  hlsDir: string;
  startedAt: number;
  totalBytes: number;
}

const activeStreams = new Map<number, ActiveStream>();

// Ensure directories exist
try {
  fs.mkdirSync(HLS_ROOT, { recursive: true });
  fs.mkdirSync(RECORDINGS_ROOT, { recursive: true });
} catch {
  // Dirs may already exist
}

// Create Fastify instance
const fastify = Fastify({
  logger: true
});

// Register plugins
async function registerPlugins() {
  await fastify.register(fastifyCors, {
    origin: true // Allow all origins for development
  });

  await fastify.register(fastifyWebsocket, {
    options: {
      maxPayload: 1024 * 1024 * 5 // 5MB max message size (video chunks)
    }
  });
}

// Broadcast message to all connected clients
function broadcast(message: WSMessage, excludeClient?: WebSocket) {
  const payload = JSON.stringify(message);
  let sentCount = 0;
  
  for (const client of clients) {
    if (client !== excludeClient && client.readyState === 1) { // 1 = OPEN
      client.send(payload);
      sentCount++;
    }
  }
  
  fastify.log.info(`Broadcast "${message.type}" to ${sentCount} clients`);
}

function getReadyStateSnapshot(): Record<number, boolean> {
  const snapshot: Record<number, boolean> = {};
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    snapshot[i] = agentReadyState.get(i) ?? false;
  }
  return snapshot;
}

function getNameSnapshot(): Record<number, string> {
  const snapshot: Record<number, string> = {};
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    snapshot[i] = agentNames.get(i) ?? '';
  }
  return snapshot;
}

function broadcastReadyState() {
  const message: ReadyStateMessage = {
    type: 'ready_state',
    agents: getReadyStateSnapshot(),
    names: getNameSnapshot()
  };
  broadcast(message);
}

function areAllConnectedReady(): boolean {
  if (agentReadyState.size === 0) {
    return false;
  }
  for (const ready of agentReadyState.values()) {
    if (!ready) {
      return false;
    }
  }
  return true;
}

function getAvailableAgentId(): number | null {
  for (let i = 1; i <= MAX_AGENTS; i += 1) {
    if (!agentReadyState.has(i)) {
      return i;
    }
  }
  return null;
}

// ── Stream Management ────────────────────────────────────────

function startStreamPipeline(agentId: number, agentName: string): ActiveStream {
  const hlsDir = path.join(HLS_ROOT, String(agentId));
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_') || `agent_${agentId}`;
  const recordingPath = path.join(RECORDINGS_ROOT, `${safeName}_${Date.now()}.webm`);

  // Wipe any stale segments/manifest from a previous stream
  fs.rmSync(hlsDir, { recursive: true, force: true });
  fs.mkdirSync(hlsDir, { recursive: true });

  // FFmpeg: reads WebM from stdin → HLS live output
  // Client sends H.264 in WebM container, so we copy the codec (no re-encoding)
  // and just remux into HLS/mpegts — this is nearly instant and uses minimal CPU.
  const ffmpegArgs = [
    // Low-latency input parsing
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-an',                       // No audio (client captures video only)
    // Copy codec — no re-encoding needed since client sends H.264
    '-c:v', 'copy',
    // HLS output
    '-f', 'hls',
    '-hls_time', '1',            // 1-second segments for lower latency
    '-hls_list_size', '4',       // Keep last 4 segments
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(hlsDir, `s${Date.now()}_%03d.ts`),
    path.join(hlsDir, 'stream.m3u8'),
  ];

  const ffmpeg = spawn(FFMPEG_BIN, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // CRITICAL: handle errors on stdin to prevent EPIPE crash
  ffmpeg.stdin?.on('error', (err) => {
    fastify.log.warn(`[FFmpeg agent ${agentId}] stdin error: ${err.message}`);
  });

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) {
      fastify.log.info(`[FFmpeg agent ${agentId}] ${msg}`);
    }
  });

  ffmpeg.on('close', (code) => {
    fastify.log.info(`[FFmpeg agent ${agentId}] exited with code ${code}`);
  });

  ffmpeg.on('error', (err) => {
    fastify.log.error({ err }, `[FFmpeg agent ${agentId}] process error`);
  });

  // Write raw WebM chunks directly to disk for recording
  const recordingStream = fs.createWriteStream(recordingPath);
  recordingStream.on('error', (err) => {
    fastify.log.warn(`[Recording agent ${agentId}] write error: ${err.message}`);
  });

  const stream: ActiveStream = {
    agentId,
    agentName,
    ffmpegProcess: ffmpeg,
    recordingPath,
    recordingStream,
    hlsDir,
    startedAt: Date.now(),
    totalBytes: 0,
  };

  activeStreams.set(agentId, stream);
  fastify.log.info(`[Stream] Pipeline started for agent ${agentId} (${agentName})`);
  return stream;
}

function handleVideoChunk(ws: WebSocket, chunk: Buffer) {
  const agentId = clientAgents.get(ws);
  if (!agentId) return;

  const stream = activeStreams.get(agentId);
  if (!stream) return;

  // Feed to FFmpeg for HLS transcoding
  if (stream.ffmpegProcess.stdin && !stream.ffmpegProcess.stdin.destroyed) {
    stream.ffmpegProcess.stdin.write(chunk);
  }
  // Write raw WebM to recording file
  if (stream.recordingStream && !stream.recordingStream.destroyed) {
    stream.recordingStream.write(chunk);
  }
  stream.totalBytes += chunk.length;
}

async function stopStreamAndUpload(agentId: number): Promise<void> {
  // Remove from activeStreams FIRST so no new chunks are written
  const stream = activeStreams.get(agentId);
  if (!stream) return;
  activeStreams.delete(agentId);

  fastify.log.info(`[Stream] Stopping pipeline for agent ${agentId}`);

  // Close recording stream
  try {
    if (stream.recordingStream && !stream.recordingStream.destroyed) {
      stream.recordingStream.end();
    }
  } catch {
    // stream may already be closed
  }

  // Close FFmpeg stdin to signal end-of-input
  try {
    if (stream.ffmpegProcess.stdin && !stream.ffmpegProcess.stdin.destroyed) {
      stream.ffmpegProcess.stdin.end();
    }
  } catch {
    // stdin may already be closed
  }

  // Wait for FFmpeg to finish (with safety timeout)
  await new Promise<void>((resolve) => {
    if (stream.ffmpegProcess.exitCode !== null) {
      // Already exited
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      fastify.log.warn(`[FFmpeg agent ${agentId}] Timed out, killing process`);
      stream.ffmpegProcess.kill('SIGKILL');
      resolve();
    }, 10000);

    stream.ffmpegProcess.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Upload recording to Convex
  try {
    await uploadToConvex(stream);
  } catch (err) {
    fastify.log.error({ err }, `[Stream] Failed to upload VOD for agent ${agentId}`);
  }

  // Clean up HLS segments
  try {
    fs.rmSync(stream.hlsDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  // Delete local recording after upload
  try {
    if (fs.existsSync(stream.recordingPath)) {
      fs.unlinkSync(stream.recordingPath);
    }
  } catch {
    // Ignore
  }

  broadcastStreamStatus();
  fastify.log.info(`[Stream] Pipeline stopped for agent ${agentId}`);
}

async function uploadToConvex(stream: ActiveStream): Promise<void> {
  const siteUrl = process.env.SITE_URL;
  const uploadApiKey = process.env.UPLOAD_API_KEY;

  if (!siteUrl || !uploadApiKey) {
    fastify.log.warn('[Upload] SITE_URL or UPLOAD_API_KEY not configured, skipping VOD upload');
    return;
  }

  if (!fs.existsSync(stream.recordingPath)) {
    fastify.log.warn(`[Upload] Recording file not found: ${stream.recordingPath}`);
    return;
  }

  const fileBuffer = fs.readFileSync(stream.recordingPath);
  if (fileBuffer.length === 0) {
    fastify.log.warn('[Upload] Recording file is empty, skipping upload');
    return;
  }

  fastify.log.info(`[Upload] Uploading VOD for ${stream.agentName} (${fileBuffer.length} bytes)`);

  // Step 1: Get upload URL from Convex via the Next.js API
  const urlRes = await fetch(`${siteUrl}/api/vod/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${uploadApiKey}`,
    },
  });

  if (!urlRes.ok) {
    throw new Error(`Failed to get upload URL: ${urlRes.status} ${urlRes.statusText}`);
  }

  const { uploadUrl } = await urlRes.json() as { uploadUrl: string };

  // Step 2: Upload the recording file to Convex storage
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'video/webm' },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload file: ${uploadRes.status} ${uploadRes.statusText}`);
  }

  const { storageId } = await uploadRes.json() as { storageId: string };

  // Step 3: Save VOD metadata in Convex
  const duration = Math.floor((Date.now() - stream.startedAt) / 1000);
  const saveRes = await fetch(`${siteUrl}/api/vod/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${uploadApiKey}`,
    },
    body: JSON.stringify({
      storageId,
      agentName: stream.agentName,
      agentId: stream.agentId,
      duration,
      recordedAt: new Date(stream.startedAt).toISOString(),
      fileSize: fileBuffer.length,
      mimeType: 'video/webm',
    }),
  });

  if (!saveRes.ok) {
    throw new Error(`Failed to save VOD metadata: ${saveRes.status} ${saveRes.statusText}`);
  }

  fastify.log.info(`[Upload] VOD uploaded for ${stream.agentName}: ${fileBuffer.length} bytes, ${duration}s`);
}

function broadcastStreamStatus() {
  const streams = Array.from(activeStreams.entries()).map(([agentId, stream]) => ({
    agentId,
    name: stream.agentName,
    hlsUrl: `/live/${agentId}/stream.m3u8`,
    startedAt: stream.startedAt,
  }));
  broadcast({ type: 'stream_status', streams });
}

// Handle incoming messages
function handleMessage(ws: WebSocket, data: string) {
  try {
    const message = JSON.parse(data) as WSMessage;
    fastify.log.info({ type: message.type }, 'Received message');

    switch (message.type) {
      case 'ready': {
        const readyMsg = message as ReadyMessage;
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Ready message from unassigned client');
          break;
        }
        agentReadyState.set(agentId, !!readyMsg.value);
        broadcastReadyState();
        break;
      }

      case 'set_name': {
        const nameMsg = message as SetNameMessage;
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Name message from unassigned client');
          break;
        }
        const cleanName = String(nameMsg.name ?? '').trim().slice(0, 32);
        agentNames.set(agentId, cleanName);
        broadcastReadyState();
        break;
      }

      case 'start_request': {
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Start message from unassigned client');
          break;
        }
        if (!areAllConnectedReady()) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'All connected users must be Ready to start'
          }));
          break;
        }
        // Use the timestamp from the client who triggered start
        const startMsg = message as { type: string; timestamp: number };
        const timestamp = startMsg.timestamp;
        const countdownDuration = 3000; // 3 seconds
        broadcast({ type: 'countdown', timestamp, duration: countdownDuration });
        const startMessage: StartBroadcastMessage = {
          type: 'start',
          timestamp,
          starterAgentId: agentId
        };
        broadcast(startMessage);
        break;
      }

      case 'travel_request': {
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Travel request from unassigned client');
          break;
        }
        // Reset all ready states for travel
        for (const [id] of agentReadyState) {
          agentReadyState.set(id, false);
        }
        travelMode = true;
        broadcast({ type: 'travel_mode', active: true });
        broadcastReadyState();
        break;
      }

      case 'execute_travel': {
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Execute travel from unassigned client');
          break;
        }
        if (!travelMode) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not in travel mode' }));
          break;
        }
        // Broadcast execute_travel - readied clients will press spacebar
        broadcast({ type: 'execute_travel' });
        // End travel mode
        travelMode = false;
        for (const [id] of agentReadyState) {
          agentReadyState.set(id, false);
        }
        broadcast({ type: 'travel_mode', active: false });
        broadcastReadyState();
        break;
      }

      case 'reset_raid': {
        travelMode = false;
        for (const [id] of agentReadyState) {
          agentReadyState.set(id, false);
        }
        broadcast({ type: 'travel_mode', active: false });
        broadcast({ type: 'reset' });
        broadcastReadyState();
        break;
      }

      case 'stream_start': {
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Stream start from unassigned client');
          break;
        }
        if (activeStreams.has(agentId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Already streaming' }));
          break;
        }
        const name = agentNames.get(agentId) ?? `Agent_${agentId}`;
        startStreamPipeline(agentId, name);
        broadcastStreamStatus();
        break;
      }

      case 'stream_stop': {
        const agentId = clientAgents.get(ws);
        if (!agentId) {
          fastify.log.warn('Stream stop from unassigned client');
          break;
        }
        // Run async stop in background — don't block the message handler
        stopStreamAndUpload(agentId).catch((err) => {
          fastify.log.error({ err }, `Error stopping stream for agent ${agentId}`);
        });
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
      }
      
      default:
        fastify.log.warn({ type: message.type }, 'Unknown message type');
    }
  } catch (e) {
    fastify.log.error({ error: e }, 'Failed to parse message');
  }
}

// Register routes
async function registerRoutes() {
  // Serve HLS segments as static files
  await fastify.register(fastifyStatic, {
    root: HLS_ROOT,
    prefix: '/live/',
    decorateReply: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache, no-store');
      }
      // Allow cross-origin requests for HLS from the Next.js site
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  });

  // Active streams endpoint
  fastify.get('/streams', async () => {
    return {
      streams: Array.from(activeStreams.entries()).map(([agentId, stream]) => ({
        agentId,
        name: stream.agentName,
        hlsUrl: `/live/${agentId}/stream.m3u8`,
        startedAt: stream.startedAt,
        durationSeconds: Math.floor((Date.now() - stream.startedAt) / 1000),
      })),
    };
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { 
      status: 'ok', 
      clients: clients.size,
      activeStreams: activeStreams.size,
      timestamp: new Date().toISOString()
    };
  });

  // WebSocket endpoint
  fastify.get('/ws', { websocket: true }, (socket, _req) => {
    const ws = socket as unknown as WebSocket;
    if (clients.size >= MAX_AGENTS) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server full (max 8 agents)'
      }));
      ws.close(1008, 'Server full');
      return;
    }

    const agentId = getAvailableAgentId();
    if (!agentId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'No available agent slots'
      }));
      ws.close(1008, 'No available agent slots');
      return;
    }

    clients.add(ws);
    clientAgents.set(ws, agentId);
    agentReadyState.set(agentId, false);
    agentNames.set(agentId, '');
    fastify.log.info(`Client connected as Agent ${agentId}. Total clients: ${clients.size}`);

    const assignedMessage: AgentAssignedMessage = {
      type: 'agent_assigned',
      agentId,
      agents: getReadyStateSnapshot(),
      names: getNameSnapshot()
    };

    ws.send(JSON.stringify(assignedMessage));
    broadcastReadyState();

    // Handle messages — binary frames are video chunks, text frames are JSON
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        handleVideoChunk(ws, data);
      } else {
        handleMessage(ws, data.toString());
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      clients.delete(ws);
      const disconnectedAgent = clientAgents.get(ws);
      if (disconnectedAgent) {
        // Stop stream if the agent was streaming
        if (activeStreams.has(disconnectedAgent)) {
          stopStreamAndUpload(disconnectedAgent).catch((err) => {
            fastify.log.error({ err }, `Error stopping stream on disconnect for agent ${disconnectedAgent}`);
          });
        }
        clientAgents.delete(ws);
        agentReadyState.delete(disconnectedAgent);
        agentNames.delete(disconnectedAgent);
        broadcastReadyState();
      }
      fastify.log.info(`Client disconnected. Total clients: ${clients.size}`);
    });

    // Handle errors
    ws.on('error', (error) => {
      fastify.log.error({ error }, 'WebSocket error');
      clients.delete(ws);
      const disconnectedAgent = clientAgents.get(ws);
      if (disconnectedAgent) {
        // Stop stream if the agent was streaming
        if (activeStreams.has(disconnectedAgent)) {
          stopStreamAndUpload(disconnectedAgent).catch((err) => {
            fastify.log.error({ err }, `Error stopping stream on error for agent ${disconnectedAgent}`);
          });
        }
        clientAgents.delete(ws);
        agentReadyState.delete(disconnectedAgent);
        agentNames.delete(disconnectedAgent);
        broadcastReadyState();
      }
    });
  });

  // Root endpoint with info
  fastify.get('/', async () => {
    return {
      name: 'SHD Overlay Server',
      version: '1.1.0',
      endpoints: {
        websocket: '/ws',
        health: '/health',
        streams: '/streams',
        live: '/live/:agentId/stream.m3u8',
      },
      connectedClients: clients.size,
      activeStreams: activeStreams.size,
    };
  });
}

// Start server
async function start() {
  try {
    await registerPlugins();
    await registerRoutes();

    const port = parseInt(process.env.PORT || '3001', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on http://${host}:${port}`);
    fastify.log.info(`WebSocket endpoint: ws://${host}:${port}/ws`);

    const shutdown = async (signal: string) => {
      fastify.log.info({ signal }, 'Shutting down server');
      try {
        await fastify.close();
      } catch (err) {
        fastify.log.error({ err }, 'Error during shutdown');
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // Prevent crashes from unhandled stream/pipe errors
    process.on('uncaughtException', (err) => {
      fastify.log.error({ err }, 'Uncaught exception (kept alive)');
    });
    process.on('unhandledRejection', (err) => {
      fastify.log.error({ err }, 'Unhandled rejection (kept alive)');
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
