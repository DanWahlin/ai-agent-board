import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WSMessage } from './types.js';
import { isValidToken } from './middleware/auth.js';
import { isAllowedWebSocketRequest, parseList } from './network-policy.js';

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

let wss: WebSocketServer;

const ALLOWED_HOSTS = parseList(process.env.ALLOWED_HOSTS, 'localhost,127.0.0.1');
const ALLOWED_ORIGINS = parseList(
  process.env.ALLOWED_ORIGINS,
  'http://localhost:8081,http://localhost:4175,http://localhost:4176',
);

export function createWSS(server: Server): WebSocketServer {
  if (wss) throw new Error('WSS already initialized');
  wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade — check auth token before accepting
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      if (!isAllowedWebSocketRequest(req, ALLOWED_HOSTS, ALLOWED_ORIGINS)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token') ?? undefined;

      if (!isValidToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (rawWs) => {
    const ws = rawWs as AliveWebSocket;
    ws.isAlive = true;
    console.log('[WS] client connected');
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => console.log('[WS] client disconnected'));
    ws.on('error', (err) => console.error('[WS] error:', err.message));
  });

  // Heartbeat to detect stale connections
  const interval = setInterval(() => {
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AliveWebSocket;
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

export function broadcast(message: WSMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
