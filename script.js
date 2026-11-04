const $ = (s) => document.querySelector(s);

const el = {
  login: $('#login'),
  chat: $('#chat'),
  loginForm: $('#login-form'),
  loginErr: $('#login-error'),
  boot: $('#boot'),
  log: $('#log'),
  users: $('#users'),
  room: $('#room-name'),
  dot: $('#dot'),
  status: $('#status-text'),
  msgForm: $('#msg-form'),
  msgInput: $('#msg-input'),
  joinForm: $('#join-form'),
  roomCode: $('#room-code'),
  createForm: $('#create-form'),
  newName: $('#new-name'),
  newCode: $('#new-code'),
  generalBtn: $('#general-btn'),
  soundBtn: $('#sound-btn'),
  themeBtn: $('#theme-btn'),
};

const prefs = {
  theme: localStorage.getItem('anon-theme') || 'hacker',
  sound: localStorage.getItem('anon-sound') !== 'off',
};

let ws = null;
let creds = null;
let me = null;
let authed = false;
let reconnectTimer = null;

document.body.className = prefs.theme;

// ---------- Sons (Web Audio, opcionais) ----------
let actx = null;
function beep(freq = 880, dur = 0.04, type = 'square') {
  if (!prefs.sound) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = 0.04;
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + dur);
  } catch { /* sem áudio */ }
}

// ---------- Renderização ----------
function typeLine(text, cls = 'system', target = el.log) {
  const div = document.createElement('div');
  div.className = `line ${cls}`;
  target.appendChild(div);
  let i = 0;
  const iv = setInterval(() => {
    div.textContent = text.slice(0, ++i);
    target.scrollTop = target.scrollHeight;
    if (i >= text.length) clearInterval(iv);
  }, 18);
}

function addMessage(m, silent = false) {
  const div = document.createElement('div');
  div.className = 'line' + (m.nick === me ? ' mine' : '');
  div.dataset.id = m.id;
  div.title = 'expira às ' + new Date(m.expiresAt).toLocaleTimeString('pt-BR');

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = m.nick + ': ';

  const text = document.createElement('span');
  text.textContent = m.text;

  div.append(time, nick, text);
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  if (!silent) beep(660, 0.03);
}

function expire(ids) {
  ids.forEach((id) => {
    const node = el.log.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (node) {
      node.classList.add('expiring');
      setTimeout(() => node.remove(), 600);
    }
  });
}

function renderUsers(list) {
  el.users.innerHTML = '';
  list.forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n + (n === me ? ' (você)' : '');
    el.users.appendChild(li);
  });
}

function setStatus(state, text) {
  el.dot.className = 'dot ' + state;
  el.status.textContent = text;
}

function showLogin() {
  authed = false;
  me = null;
  el.chat.classList.add('hidden');
  el.login.classList.remove('hidden');
  setStatus('off', 'OFFLINE');
}

// ---------- Conexão ----------
function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function send(obj) {
  if (isOpen()) ws.send(JSON.stringify(obj));
  else typeLine('[ERROR] Sem conexão com o servidor.', 'error');
}

function connect(invite, nick) {
  creds = { invite, nick };
  authed = false;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  setStatus('connecting', 'CONNECTING...');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'login', invite, nick }));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (!creds) return; // desconexão intencional (convite revogado, logout)
    if (!authed) {
      creds = null;
      el.loginErr.textContent = 'Não foi possível conectar.';
      return showLogin();
    }
    if (e.code === 4002) {
      typeLine('[SECURITY] Muitas tentativas. Sessão encerrada.', 'error');
      creds = null;
      return showLogin();
    }
    setStatus('connecting', 'RECONNECTING...');
    typeLine('[SYSTEM] Conexão perdida. Reconectando...', 'error');
    reconnectTimer = setTimeout(() => connect(creds.invite, creds.nick), 2500);
  };
}

function handle(d) {
  switch (d.type) {
    case 'welcome':
      authed = true;
      me = d.nick;
      el.loginErr.textContent = '';
      el.login.classList.add('hidden');
      el.chat.classList.remove('hidden');
      setStatus('on', 'ONLINE');
      el.msgInput.focus();
      beep(990, 0.12, 'sine');
      break;

    case 'room':
      el.log.innerHTML = '';
      el.room.textContent = d.name;
      el.log.classList.remove('room-switch');
      void el.log.offsetWidth; // reinicia animação
      el.log.classList.add('room-switch');
      d.messages.forEach((m) => addMessage(m, true));
      typeLine(`[ROOM] ${d.name}`);
      break;

    case 'message':
      addMessage(d.msg);
      break;

    case 'expire':
      expire(d.ids);
      break;

    case 'users':
      renderUsers(d.list);
      break;

    case 'system':
      typeLine(`[SYSTEM] ${d.text}`);
      break;

    case 'error':
      typeLine(`[ERROR] ${d.reason}`, 'error');
      break;

    case 'auth_error':
      creds = null;
      el.loginErr.textContent = d.reason;
      showLogin();
      break;
  }
}

// ---------- Eventos ----------
el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  el.loginErr.textContent = '';
  connect($('#invite').value.trim(), $('#nick').value.trim());
});

el.msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.msgInput.value.trim();
  if (!text) return;
  send({ type: 'msg', text });
  el.msgInput.value = '';
});

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = el.roomCode.value.trim();
  if (code) send({ type: 'join_room', code });
  el.roomCode.value = '';
});

el.createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.newName.value.trim();
  const code = el.newCode.value.trim();
  if (name && code) send({ type: 'create_room', name, code });
  el.newName.value = '';
  el.newCode.value = '';
});

el.generalBtn.addEventListener('click', () => send({ type: 'leave_room' }));

el.themeBtn.addEventListener('click', () => {
  prefs.theme = prefs.theme === 'hacker' ? 'minimal' : 'hacker';
  document.body.className = prefs.theme;
  localStorage.setItem('anon-theme', prefs.theme);
});

function renderSoundBtn() {
  el.soundBtn.textContent = `[som: ${prefs.sound ? 'on' : 'off'}]`;
}
el.soundBtn.addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  localStorage.setItem('anon-sound', prefs.sound ? 'on' : 'off');
  renderSoundBtn();
});
renderSoundBtn();

// ---------- Boot ----------
['ANON TERMINAL v1.0', '[SYSTEM] Secure session initialized', 'Aguardando convite...']
  .forEach((line, i) => setTimeout(() => typeLine(line, 'system', el.boot), i * 700));
