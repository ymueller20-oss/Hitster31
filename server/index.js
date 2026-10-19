// HTTP-Server (liefert die App aus) + WebSocket-Server (Spielräume).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, GameError } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '' }));
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normPath(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    // Unbekannte Pfade (z. B. /join/ABCD) bekommen die App.
    const body = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    res.end(body);
  }
}

const server = http.createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500);
    res.end();
  });
});

// ---------- Räume ----------

const rooms = new Map(); // code -> Game
const sockets = new Map(); // code -> Set<ws>
const timers = new Map(); // code -> { roundId, handle }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(code) {
  const game = rooms.get(code);
  const set = sockets.get(code);
  if (!game || !set) return;
  syncTimer(game);
  for (const ws of set) {
    if (ws.playerId && game.players.has(ws.playerId)) send(ws, { type: 'state', state: game.viewFor(ws.playerId) });
  }
}

function syncTimer(game) {
  const t = timers.get(game.code);
  const want = game.phase === 'challenge' ? game.round.id : null;
  if (t && t.roundId === want) return;
  if (t) clearTimeout(t.handle);
  timers.delete(game.code);
  if (!want) return;
  const handle = setTimeout(() => {
    timers.delete(game.code);
    game.challengeTimeout(want);
    broadcast(game.code);
  }, Math.max(0, game.round.deadline - Date.now()));
  timers.set(game.code, { roundId: want, handle });
}

function attach(ws, game, player) {
  detach(ws);
  ws.playerId = player.id;
  ws.code = game.code;
  if (!sockets.has(game.code)) sockets.set(game.code, new Set());
  sockets.get(game.code).add(ws);
  game.setConnected(player.id, true);
  send(ws, { type: 'session', code: game.code, playerId: player.id, secret: player.secret });
}

function detach(ws) {
  if (!ws.code) return;
  const set = sockets.get(ws.code);
  set?.delete(ws);
  const game = rooms.get(ws.code);
  if (game && ws.playerId && ![...(set || [])].some((o) => o.playerId === ws.playerId)) {
    game.setConnected(ws.playerId, false);
  }
  const code = ws.code;
  ws.code = ws.playerId = null;
  broadcast(code);
}

function closeRoom(code, reason) {
  for (const ws of sockets.get(code) || []) {
    send(ws, { type: 'closed', reason });
    ws.code = ws.playerId = null;
  }
  const t = timers.get(code);
  if (t) clearTimeout(t.handle);
  timers.delete(code);
  sockets.delete(code);
  rooms.delete(code);
}

function handle(ws, msg) {
  const { type } = msg;
  if (type === 'create') {
    const game = new Game(newCode());
    rooms.set(game.code, game);
    attach(ws, game, game.addPlayer(msg.name));
    return broadcast(game.code);
  }
  if (type === 'join') {
    const code = String(msg.code || '').toUpperCase().trim();
    const game = rooms.get(code);
    if (!game) throw new GameError('Raum nicht gefunden. Stimmt der Code?');
    attach(ws, game, game.addPlayer(msg.name));
    return broadcast(code);
  }
  if (type === 'resume') {
    const game = rooms.get(msg.code);
    const p = game?.players.get(msg.playerId);
    if (!p || p.secret !== msg.secret) return send(ws, { type: 'resumeFailed' });
    attach(ws, game, p);
    return broadcast(game.code);
  }

  const game = ws.code && rooms.get(ws.code);
  if (!game || !game.players.has(ws.playerId)) throw new GameError('Du bist in keinem Raum.');
  const id = ws.playerId;

  switch (type) {
    case 'leave':
      if (id === game.hostId) return closeRoom(game.code, 'Der Host hat das Spiel beendet.');
      game.removePlayer(id);
      send(ws, { type: 'closed', reason: '' });
      sockets.get(game.code)?.delete(ws);
      ws.code = ws.playerId = null;
      break;
    case 'kick':
      game.requireHost(id);
      if (msg.playerId === id) throw new GameError('Du kannst dich nicht selbst entfernen.');
      game.removePlayer(msg.playerId);
      for (const o of sockets.get(game.code) || []) {
        if (o.playerId === msg.playerId) {
          send(o, { type: 'closed', reason: 'Du wurdest aus dem Raum entfernt.' });
          sockets.get(game.code).delete(o);
          o.code = o.playerId = null;
        }
      }
      break;
    case 'setPool': game.setPool(id, msg.tracks); break;
    case 'settings': game.updateSettings(id, msg.settings || {}); break;
    case 'start': game.start(id); break;
    case 'lobby': game.backToLobby(id); break;
    case 'slot': game.selectSlot(id, msg.slot); break;
    case 'guess': game.setGuess(id, msg.guess); return; // privat, kein Broadcast nötig
    case 'lockIn': game.lockIn(id); break;
    case 'skip': game.skipSong(id); break;
    case 'buy': game.buyCard(id); break;
    case 'challenge': game.challenge(id, msg.slot); break;
    case 'pass': game.pass(id); break;
    case 'next': game.next(id); break;
    default: throw new GameError('Unbekannte Aktion.');
  }
  broadcast(game.code);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    try {
      handle(ws, msg);
    } catch (e) {
      if (e instanceof GameError) send(ws, { type: 'error', message: e.message });
      else {
        console.error(e);
        send(ws, { type: 'error', message: 'Interner Fehler.' });
      }
    }
  });
  ws.on('close', () => detach(ws));
});

// Tote Verbindungen erkennen, Proxies wach halten, alte Räume aufräumen.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, game] of rooms) {
    if (now - game.lastActivity > ROOM_IDLE_MS) closeRoom(code, 'Der Raum wurde wegen Inaktivität geschlossen.');
  }
}, 25_000).unref();

server.listen(PORT, () => console.log(`Hit31 läuft auf http://localhost:${PORT}`));
