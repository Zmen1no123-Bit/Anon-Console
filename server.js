const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MSG_TTL = Number(process.env.MSG_TTL_MS) || 10 * 60 * 1000; // 10 min por padrão
const MAX_MESSAGES = 300;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(16).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ---------- Convites (apenas em RAM) ----------
const invites = new Map(); // code -> { active }

function newInvite(code) {
  code = (code || crypto.randomBytes(4).toString('hex')).toUpperCase();
  invites.set(code, { active: true });
  return code;
}

function revokeInvite(code) {
  const inv = invites.get(code);
  if (!inv) return false;
  inv.active = false;
  for (const [ws, s] of sessions) {
    if (s.invite === code) {
      send(ws, { type: 'auth_error', reason: 'Convite revogado.' });
      ws.close(4001, 'revoked');
    }
  }
  return true;
}

(process.env.INVITES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((c) => newInvite(c));

if (invites.size === 0) {
  console.log('[SYSTEM] Convite inicial criado:', newInvite());
}
if (!process.env.ADMIN_TOKEN) {
  console.log('[ADMIN] ADMIN_TOKEN não definido. Token temporário:', ADMIN_TOKEN);
}

// ---------- Salas e sessões (apenas em RAM) ----------
const GENERAL = { key: 'general', name: 'GENERAL', code: null, messages: [], clients: new Set() };
const rooms = new Map([[GENERAL.key, GENERAL]]);
const sessions = new Map(); // ws -> { nick, invite, room, lastMsg, fails }

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const broadcast = (room, obj) => room.clients.forEach((ws) => send(ws, obj));
const usersOf = (room) => [...room.clients].map((ws) => sessions.get(ws).nick);
const publicMsg = (m) => ({ id: m.id, nick: m.nick, text: m.text, ts: m.ts, expiresAt: m.expiresAt });

const cleanNick = (s) => String(s || '').replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 16);
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 20);
const cleanCode = (s) => String(s || '').trim().toUpperCase();
const findRoomByCode = (code) => {
  for (const r of rooms.values()) if (r.code === code) return r;
  return null;
};

function login(ws, d) {
  const invite = cleanCode(d.invite);
  const nick = cleanNick(d.nick);
  const inv = invites.get(invite);

  if (!inv || !inv.active) return send(ws, { type: 'auth_error', reason: 'Convite inválido ou revogado.' });
  if (nick.length < 2) return send(ws, { type: 'auth_error', reason: 'Apelido deve ter de 2 a 16 caracteres.' });
  for (const s of sessions.values()) {
    if (s.nick.toLowerCase() === nick.toLowerCase()) {
      return send(ws, { type: 'auth_error', reason: 'Apelido já está em uso.' });
    }
  }

  sessions.set(ws, { nick, invite, room: null, lastMsg: 0, fails: 0 });
  send(ws, { type: 'welcome', nick });
  enterRoom(ws, GENERAL);
}

function leaveRoom(ws) {
  const s = sessions.get(ws);
  if (!s || !s.room) return;
  const room = rooms.get(s.room);
  s.room = null;
  if (!room) return;
  room.clients.delete(ws);
  broadcast(room, { type: 'system', text: `${s.nick} saiu da sala` });
  broadcast(room, { type: 'users', list: usersOf(room) });
}

function enterRoom(ws, room) {
  const s = sessions.get(ws);
  leaveRoom(ws);
  room.clients.add(ws);
  s.room = room.key;
  send(ws, {
    type: 'room',
    name: room.name,
    messages: room.messages.map(publicMsg),
  });
  broadcast(room, { type: 'system', text: `${s.nick} entrou na sala` });
  broadcast(room, { type: 'users', list: usersOf(room) });
}

function createRoom(ws, d) {
  const name = cleanName(d.name);
  const code = cleanCode(d.code);
  if (!name) return send(ws, { type: 'error', reason: 'Nome de sala inválido.' });
  if (!/^[A-Z0-9_-]{4,32}$/.test(code)) {
    return send(ws, { type: 'error', reason: 'Código: 4 a 32 caracteres (A-Z, 0-9, _ e -).' });
  }
  if (code === 'GENERAL' || findRoomByCode(code)) {
    return send(ws, { type: 'error', reason: 'Código já em uso.' });
  }
  const room = { key: crypto.randomUUID(), name, code, messages: [], clients: new Set() };
  rooms.set(room.key, room);
  enterRoom(ws, room);
}

function joinRoom(ws, d) {
  const s = sessions.get(ws);
  const room = findRoomByCode(cleanCode(d.code));
  if (!room) {
    s.fails++;
    if (s.fails > 10) return ws.close(4002, 'too many attempts');
    return send(ws, { type: 'error', reason: 'Código de sala inválido.' });
  }
  if (s.room === room.key) return;
  enterRoom(ws, room);
}

function postMessage(ws, d) {
  const s = sessions.get(ws);
  const now = Date.now();
  if (now - s.lastMsg < 300) return; // anti-spam simples

  const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 500);
  if (!text) return;

  const room = rooms.get(s.room);
  if (!room) return;

  s.lastMsg = now;
  const msg = { id: crypto.randomUUID(), nick: s.nick, text, ts: now, expiresAt: now + MSG_TTL };
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) {
    const removed = room.messages.shift();
    broadcast(room, { type: 'expire', ids: [removed.id] });
  }
  broadcast(room, { type: 'message', msg: publicMsg(msg) });
}

// ---------- Expiração automática ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = [];
    room.messages = room.messages.filter((m) => {
      if (m.expiresAt <= now) {
        expired.push(m.id);
        return false;
      }
      return true;
    });
    if (expired.length) broadcast(room, { type: 'expire', ids: expired });
    // Remove salas vazias e sem mensagens
    if (room !== GENERAL && room.clients.size === 0 && room.messages.length === 0) {
      rooms.delete(room.key);
    }
  }
}, 1000);

// ---------- Admin (convites) ----------
function adminRoute(req, res, url) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return reply(401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/admin/invites') {
    return reply(200, [...invites].map(([code, v]) => ({ code, active: v.active })));
  }
  if (req.method === 'POST' && url.pathname === '/admin/invites') {
    return reply(201, { code: newInvite() });
  }
  const m = url.pathname.match(/^\/admin\/invites\/([A-Z0-9]+)$/i);
  if (req.method === 'DELETE' && m) {
    const ok = revokeInvite(m[1].toUpperCase());
    return reply(ok ? 200 : 404, { revoked: ok });
  }
  reply(404, { error: 'not found' });
}

// ---------- HTTP (arquivos estáticos) ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/admin')) return adminRoute(req, res, url);
  if (url.pathname === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;

    if (!sessions.has(ws)) {
      if (d.type === 'login') return login(ws, d);
      return send(ws, { type: 'auth_error', reason: 'Faça login primeiro.' });
    }

    switch (d.type) {
      case 'create_room': return createRoom(ws, d);
      case 'join_room': return joinRoom(ws, d);
      case 'leave_room': return enterRoom(ws, GENERAL);
      case 'msg': return postMessage(ws, d);
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    sessions.delete(ws);
  });
});

// Detecta conexões mortas
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`ANON TERMINAL rodando na porta ${PORT}`));
