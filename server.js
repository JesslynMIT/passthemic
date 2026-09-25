// Pass the Mic — signaling + queue server
// One process: serves the web app, keeps room state, relays WebRTC signaling.
// Audio itself never touches this server; it goes phone → host device over WebRTC.

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const AWAY_HAND_MS = Number(process.env.AWAY_HAND_MS || 5 * 60_000); // hand stays up this long after the phone is closed

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// QR code pointing at the join page for a room, served as SVG.
app.get('/qr.svg', async (req, res) => {
  const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!code) return res.status(400).end();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${req.headers.host}/?code=${code}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1f1d1a', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Room state ----------
/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code, name) {
    this.code = code;
    this.name = name || 'Session';
    this.host = null;            // ws of the host device (audio sink + room screen)
    this.members = new Map();    // id -> { id, name, ws, raisedAt, muted, facilitator }
    this.queue = [];             // member ids in order
    this.live = null;            // member id currently speaking
    this.liveSince = 0;
    this.createdAt = Date.now();
  }

  member(id) { return this.members.get(id); }

  publicState(forId) {
    const live = this.live ? this.member(this.live) : null;
    const me = forId ? this.member(forId) : null;
    return {
      type: 'state',
      room: {
        code: this.code,
        name: this.name,
        count: this.members.size,
        online: [...this.members.values()].filter(m => m.connected).length,
        hostConnected: !!this.host,
        live: live ? { id: live.id, name: live.name, since: this.liveSince, muted: !!live.muted } : null,
        queue: this.queue.map((id, i) => {
          const m = this.member(id);
          return { id, name: m.name, raisedAt: m.raisedAt, position: i + 1, onDeck: i === 0, away: !m.connected };
        }),
        members: [...this.members.values()].map(m => ({ id: m.id, name: m.name, facilitator: !!m.facilitator, away: !m.connected })),
      },
      you: me ? {
        id: me.id,
        name: me.name,
        facilitator: !!me.facilitator,
        handRaised: this.queue.includes(me.id),
        position: this.queue.indexOf(me.id) + 1 || null,
        onDeck: this.queue[0] === me.id,
        live: this.live === me.id,
        muted: !!me.muted,
      } : null,
    };
  }

  broadcast() {
    for (const m of this.members.values()) if (m.connected) safeSend(m.ws, this.publicState(m.id));
    if (this.host) safeSend(this.host, this.publicState(null));
  }

  raise(id) {
    if (!this.members.has(id) || this.queue.includes(id) || this.live === id) return;
    this.member(id).raisedAt = Date.now();
    this.queue.push(id);
  }

  lower(id) { this.queue = this.queue.filter(x => x !== id); }

  endLive(reason) {
    if (!this.live) return;
    const m = this.member(this.live);
    if (m) safeSend(m.ws, { type: 'live-ended', reason });
    if (this.host) safeSend(this.host, { type: 'live-ended', id: this.live, reason });
    this.live = null;
    this.liveSince = 0;
  }

  grant(id) {
    const target = this.member(id);
    if (!target || !target.connected) return false;
    this.endLive('replaced');
    this.lower(id);
    this.live = id;
    this.liveSince = Date.now();
    const m = this.member(id);
    m.muted = false;
    safeSend(m.ws, { type: 'go-live' });
    return true;
  }

  // Next = first person in the queue whose phone is actually open; closed phones keep their place but are skipped.
  next() {
    const id = this.queue.find(q => this.member(q) && this.member(q).connected);
    if (id) this.grant(id); else this.endLive('next');
  }

  // A phone that has been closed for a while with its hand up gets lowered so the queue doesn't fill with ghosts.
  sweep() {
    const cutoff = Date.now() - AWAY_HAND_MS;
    const before = this.queue.length;
    this.queue = this.queue.filter(id => { const m = this.member(id); return m && (m.connected || m.lastSeen > cutoff); });
    return this.queue.length !== before;
  }

  remove(id) {
    this.lower(id);
    if (this.live === id) this.endLive('left');
    this.members.delete(id);
  }
}

function safeSend(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function newCode() {
  const day = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date().getDay()];
  for (let i = 0; i < 50; i++) {
    const code = `${day}-${100 + crypto.randomInt(900)}`;
    if (!rooms.has(code)) return code;
  }
  return `${day}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function canControl(ws) {
  const r = ws.room;
  if (!r) return false;
  if (ws.role === 'host') return true;
  const m = r.member(ws.id);
  return !!(m && m.facilitator);
}

// ---------- WebSocket protocol ----------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const r = ws.room;

    switch (msg.type) {
      // --- host device ---
      case 'host:create': {
        let code = String(msg.code || '').toUpperCase();
        let room = rooms.get(code);
        if (!room) { code = newCode(); room = new Room(code, msg.name); rooms.set(code, room); }
        if (room.host && room.host !== ws) safeSend(room.host, { type: 'host-replaced' });
        room.host = ws; ws.role = 'host'; ws.room = room;
        if (msg.name) room.name = msg.name;
        safeSend(ws, { type: 'created', code });
        room.broadcast();
        break;
      }

      // --- participants ---
      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return safeSend(ws, { type: 'error', error: 'No session with that code. Check the room screen.' });
        const name = String(msg.name || 'Someone').slice(0, 40).trim() || 'Someone';
        let id = String(msg.id || '');
        const existing = id && room.members.get(id);
        if (existing) {
          // Same phone coming back (app reopened, screen unlocked, WiFi blip): keep its place, name and role.
          if (existing.ws && existing.ws !== ws) safeSend(existing.ws, { type: 'replaced' });
          existing.ws = ws; existing.connected = true; existing.lastSeen = Date.now(); existing.name = name || existing.name;
        } else {
          id = crypto.randomBytes(6).toString('hex');
          const facilitator = room.members.size === 0 && !!msg.claimFacilitator;
          room.members.set(id, { id, name, ws, raisedAt: 0, muted: false, facilitator, connected: true, lastSeen: Date.now() });
        }
        ws.role = 'member'; ws.id = id; ws.room = room;
        safeSend(ws, { type: 'joined', id, code });
        room.broadcast();
        break;
      }
      case 'leave': if (r && ws.role === 'member') { r.remove(ws.id); ws.room = null; r.broadcast(); } break;
      case 'raise': if (r && ws.role === 'member') { r.raise(ws.id); r.broadcast(); } break;
      case 'lower': if (r && ws.role === 'member') { r.lower(ws.id); r.broadcast(); } break;
      case 'mute': {
        const m = r && r.member(ws.id);
        if (m) { m.muted = !!msg.muted; r.broadcast(); }
        break;
      }
      case 'done': if (r && r.live === ws.id) { r.endLive(msg.reason || 'done'); r.broadcast(); } break;

      // --- controls (host or facilitator) ---
      case 'next': if (canControl(ws)) { r.next(); r.broadcast(); } break;
      case 'grant': if (canControl(ws)) { r.grant(msg.id); r.broadcast(); } break;
      case 'cut': if (canControl(ws)) { r.endLive('cut'); r.broadcast(); } break;
      case 'remove': if (canControl(ws)) { r.lower(msg.id); r.broadcast(); } break;
      case 'reorder': {
        if (!canControl(ws) || !Array.isArray(msg.queue)) break;
        const valid = msg.queue.filter(id => r.queue.includes(id));
        r.queue = [...valid, ...r.queue.filter(id => !valid.includes(id))];
        r.broadcast();
        break;
      }
      case 'handoff': {
        if (!canControl(ws)) break;
        const m = r.member(msg.id);
        if (!m) break;
        m.facilitator = !!msg.on;
        r.broadcast();
        break;
      }
      case 'rename': if (canControl(ws) && msg.name) { r.name = String(msg.name).slice(0, 60); r.broadcast(); } break;

      // --- WebRTC signaling relay ---
      case 'signal': {
        if (!r) break;
        if (ws.role === 'member' && r.live === ws.id) safeSend(r.host, { type: 'signal', from: ws.id, data: msg.data });
        else if (ws.role === 'host') { const m = r.member(msg.to); if (m) safeSend(m.ws, { type: 'signal', from: 'host', data: msg.data }); }
        break;
      }
      case 'ping': safeSend(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => {
    const r = ws.room;
    if (!r) return;
    if (ws.role === 'host' && r.host === ws) { r.host = null; r.endLive('host-left'); r.broadcast(); }
    if (ws.role === 'member') {
      const m = r.member(ws.id);
      if (m && m.ws === ws) {
        m.connected = false; m.lastSeen = Date.now();
        if (r.live === ws.id) r.endLive('left');
        r.broadcast();
      }
    }
    // Drop empty, host-less rooms after a grace period.
    setTimeout(() => { if (!r.host && ![...r.members.values()].some(m => m.connected)) rooms.delete(r.code); }, 3 * 60 * 60 * 1000);
  });
});

setInterval(() => { for (const r of rooms.values()) if (r.sweep()) r.broadcast(); }, 30_000);

// Keepalive so phone browsers behind NAT don't get silently dropped.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  }
}, 25_000);

server.listen(PORT, () => console.log(`Pass the Mic running on http://localhost:${PORT}`));
