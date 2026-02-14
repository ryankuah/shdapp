import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import type { WebSocket } from 'ws';

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
      maxPayload: 1024 * 64 // 64KB max message size
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
  // Health check endpoint
  fastify.get('/health', async () => {
    return { 
      status: 'ok', 
      clients: clients.size,
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

    // Handle messages
    ws.on('message', (data: Buffer) => {
      handleMessage(ws, data.toString());
    });

    // Handle disconnect
    ws.on('close', () => {
      clients.delete(ws);
      const disconnectedAgent = clientAgents.get(ws);
      if (disconnectedAgent) {
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
      version: '1.0.0',
      endpoints: {
        websocket: '/ws',
        health: '/health'
      },
      connectedClients: clients.size
    };
  });
}

// Start server
async function start() {
  try {
    await registerPlugins();
    await registerRoutes();

    const port = parseInt(process.env.PORT || '3000', 10);
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
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
