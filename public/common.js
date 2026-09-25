// Shared client helpers: socket with auto-reconnect, WebRTC config, small utils.
window.PTM = (() => {
  const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

  function connect({ onOpen, onMessage, onClose }) {
    let ws, closedByUs = false, backoff = 500;
    const queue = [];
    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { backoff = 500; while (queue.length) ws.send(queue.shift()); onOpen && onOpen(); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
      ws.onclose = () => { onClose && onClose(); if (!closedByUs) setTimeout(open, backoff = Math.min(backoff * 2, 8000)); };
      ws.onerror = () => ws.close();
    }
    open();
    return {
      send(msg) { const s = JSON.stringify(msg); if (ws && ws.readyState === 1) ws.send(s); else queue.push(s); },
      close() { closedByUs = true; ws && ws.close(); },
    };
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const ago = (t) => { const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? 'just now' : `${m} min ago`; };
  const ordinal = (n) => n === 1 ? 'next' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Only touch the DOM when the markup actually changed, so taps never land on a re-rendered element.
  const setHTML = (sel, html) => { const el = $(sel); if (el.__html !== html) { el.__html = html; el.innerHTML = html; } };

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeLock === null && window.__wantAwake) keepAwake(); });

  return { ICE, connect, $, setHTML, initials, mmss, ago, ordinal, esc, keepAwake };
})();
