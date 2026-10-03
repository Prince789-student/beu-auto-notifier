/**
 * BEU Auto Notifier — Standalone Dashboard JS
 * Connects ONLY to localhost (own server) — zero external dependency
 */

const API = ''; // Same origin — server pe hi chal raha hai

let lastPollTime = Date.now();
let lastNoticeSet = new Set();
let checkInterval = 2; // minutes

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  checkStatus();
  loadNotices();
  loadSettings();

  setInterval(checkStatus, 15000);
  setInterval(() => { loadNotices(true); }, 120000);
  setInterval(updateCountdown, 1000);
  updateCountdown();
});

// ── Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('headerClock');
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// ── Countdown ─────────────────────────────────────────────────────────────
function updateCountdown() {
  const elapsed = Date.now() - lastPollTime;
  const rem = Math.max(0, checkInterval * 60000 - elapsed);
  const s = Math.ceil(rem / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const el = document.getElementById('nextCheck');
  if (el) el.textContent = `${m}m ${sec.toString().padStart(2,'0')}s`;
}

// ── Server Status ─────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(5000) });
    const d = await res.json();

    // Header pill
    const dot = document.getElementById('pillDot');
    const lbl = document.getElementById('pillLabel');
    dot.className = 'pill-dot online';
    lbl.textContent = 'Server Online';

    // WA status
    const waBadge = document.getElementById('waBadge');
    const stWa = document.getElementById('st-wa');
    setSlBadge(stWa, waStatusText(d.waStatus), waStatusClass(d.waStatus));
    if (waBadge) {
      waBadge.textContent = waStatusText(d.waStatus);
      waBadge.className = 'wa-status-badge ' + (d.waStatus === 'connected' ? 'connected' : d.waStatus === 'qr_ready' || d.waStatus === 'connecting' ? 'connecting' : '');
    }
    updateWaArea(d);

    // Other badges
    setSlBadge(document.getElementById('st-server'), 'ONLINE', 'ok');
    setSlBadge(document.getElementById('st-cron'), 'AUTO', 'ok');
    setSlBadge(document.getElementById('st-auto'), d.autoDispatch ? 'ON' : 'OFF', d.autoDispatch ? 'on' : 'off');

    // Stats
    setText('stat-total', d.totalNotices || 0);
    setText('stat-sent', d.sentNotices || 0);
    setText('stat-pending', d.pendingNotices || 0);
    setText('stat-today', d.totalSentToday || 0);

    // Last check
    if (d.lastCheckTime) {
      const t = new Date(d.lastCheckTime).toLocaleTimeString('en-IN', { hour12: false });
      setText('lastCheck', t);
    }

    checkInterval = d.checkIntervalMins || 2;

    // QR poll
    if (d.hasQr) loadQr();

  } catch {
    const dot = document.getElementById('pillDot');
    const lbl = document.getElementById('pillLabel');
    dot.className = 'pill-dot offline';
    lbl.textContent = 'Server Offline';
    setSlBadge(document.getElementById('st-server'), 'OFFLINE', 'err');
  }
}

function waStatusText(s) {
  return { connected: 'CONNECTED', qr_ready: 'SCAN QR', connecting: 'STARTING', disconnected: 'OFFLINE' }[s] || '—';
}

function waStatusClass(s) {
  return { connected: 'ok', qr_ready: 'warn', connecting: 'warn', disconnected: 'err' }[s] || '';
}

// ── WhatsApp Area ─────────────────────────────────────────────────────────
function updateWaArea(d) {
  const area = document.getElementById('waArea');
  if (!area) return;

  if (d.waStatus === 'connected') {
    area.innerHTML = `
      <div class="wa-connected">
        <div class="wa-check">✅</div>
        <div class="wa-conn-text">WhatsApp Connected!</div>
        <div class="wa-conn-sub">Auto-notifications ON hain — aap so sakte ho!</div>
        <button class="btn btn-ghost btn-sm" onclick="disconnectWa()">Disconnect</button>
      </div>`;
  } else if (d.waStatus === 'qr_ready') {
    loadQr();
  } else if (d.waStatus === 'connecting') {
    area.innerHTML = `
      <div class="wa-placeholder">
        <div class="wa-icon-big">⏳</div>
        <p class="wa-msg">WhatsApp start ho raha hai… thoda wait karo</p>
      </div>`;
  } else {
    area.innerHTML = `
      <div class="wa-placeholder">
        <div class="wa-icon-big">📱</div>
        <p class="wa-msg">Connect karo aur QR scan karo</p>
        <button class="btn btn-primary" onclick="connectWhatsApp()">WhatsApp Connect Karo</button>
      </div>`;
  }
}

async function loadQr() {
  try {
    const res = await fetch(`${API}/api/qr`);
    const d = await res.json();
    if (d.hasQr && d.qrDataUrl) {
      const area = document.getElementById('waArea');
      if (area) {
        area.innerHTML = `
          <div class="qr-wrap">
            <img src="${d.qrDataUrl}" alt="WhatsApp QR Code" />
            <div class="qr-instructions">📱 WhatsApp kholo → Linked Devices → Link a Device → QR scan karo</div>
          </div>`;
      }
    }
  } catch {}
}

async function connectWhatsApp() {
  const btn = document.getElementById('btnWaConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    await fetch(`${API}/api/wa/connect`, { method: 'POST' });
    showToast('⏳', 'WhatsApp start ho raha hai — QR aayega…', 'warn');
    setTimeout(checkStatus, 3000);
    setInterval(checkStatus, 5000);
  } catch {
    showToast('❌', 'Connect failed', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'WhatsApp Connect Karo'; }
  }
}

async function disconnectWa() {
  try {
    await fetch(`${API}/api/wa/disconnect`, { method: 'POST' });
    showToast('✅', 'WhatsApp disconnected', 'ok');
    checkStatus();
  } catch {
    showToast('❌', 'Disconnect failed', 'err');
  }
}

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch(`${API}/api/settings`);
    const d = await res.json();
    const inp = document.getElementById('channelIdInput');
    const tog = document.getElementById('autoDispatchToggle');
    if (inp) inp.value = d.channelId || '';
    if (tog) tog.checked = d.autoDispatch !== false;
  } catch {}
}

async function saveSettings() {
  const channelId = document.getElementById('channelIdInput')?.value.trim() || '';
  const autoDispatch = document.getElementById('autoDispatchToggle')?.checked !== false;

  try {
    const res = await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, autoDispatch })
    });
    const d = await res.json();
    if (d.success) {
      showToast('✅', 'Settings save ho gaye!', 'ok');
      checkStatus();
    }
  } catch {
    showToast('❌', 'Save failed', 'err');
  }
}

async function toggleAutoDispatch(val) {
  try {
    await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoDispatch: val })
    });
    showToast(val ? '✅' : '⏸️', `Auto dispatch: ${val ? 'ON' : 'OFF'}`, val ? 'ok' : 'warn');
  } catch {}
}

// ── Sync Now ──────────────────────────────────────────────────────────────
async function syncNow() {
  const btn = document.getElementById('btnSync');
  if (btn) { btn.disabled = true; btn.querySelector('.ac-title').textContent = 'Checking…'; }
  showResult(null);

  try {
    const res = await fetch(`${API}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceAll: false }),
      signal: AbortSignal.timeout(60000)
    });
    const d = await res.json();
    lastPollTime = Date.now();

    if (d.skipped) {
      showResult('⏳ Already checking hai — wait karo', 'warn');
    } else if (d.success) {
      showResult(`✅ Done!\nNew notices: ${d.newCount}\nSent: ${d.sentCount}`, 'ok');
      showToast('✅', `Check done! ${d.newCount} new, ${d.sentCount} sent`, 'ok');
      loadNotices(true);
    } else {
      showResult(`❌ Error: ${d.error || 'Unknown'}`, 'err');
    }
  } catch (err) {
    showResult(err.name === 'TimeoutError' ? '⏳ Server chal raha hai background mein…' : `❌ ${err.message}`, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.ac-title').textContent = 'BEU Check Now'; }
  }
}

// ── Test Message ──────────────────────────────────────────────────────────
async function sendTestMsg() {
  const btn = document.getElementById('btnTest');
  if (btn) { btn.disabled = true; btn.querySelector('.ac-title').textContent = 'Sending…'; }

  try {
    const res = await fetch(`${API}/api/send-custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '🔔 *BEU Auto Notifier — Test Message*\n\nYe ek test notification hai.\nSystem sahi kaam kar raha hai! ✅\n\n#BEU #Test' })
    });
    const d = await res.json();
    if (d.success) {
      showResult('✅ Test message WhatsApp pe bheja gaya!', 'ok');
      showToast('✅', 'Test sent!', 'ok');
    } else {
      showResult(`❌ Send failed: ${d.reason || 'Unknown'}`, 'err');
      showToast('❌', 'Send failed — WhatsApp connected hai?', 'err');
    }
  } catch (err) {
    showResult(`❌ ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.ac-title').textContent = 'Test Message'; }
  }
}

// ── Custom Send ───────────────────────────────────────────────────────────
async function sendCustom() {
  const msg = document.getElementById('msgBody')?.value.trim();
  const title = document.getElementById('msgTitle')?.value.trim();
  const link = document.getElementById('msgLink')?.value.trim();

  if (!msg) { showToast('⚠️', 'Message likhna zaroori hai!', 'warn'); return; }

  const btn = document.getElementById('btnSendCustom');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Bhej raha hai…'; }

  try {
    const res = await fetch(`${API}/api/send-custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, title: title || undefined, pdfLink: link || undefined })
    });
    const d = await res.json();
    if (d.success) {
      showToast('✅', 'WhatsApp pe bheja gaya!', 'ok');
      document.getElementById('msgBody').value = '';
      document.getElementById('msgTitle').value = '';
      document.getElementById('msgLink').value = '';
      updateCount();
    } else {
      showToast('❌', `Failed: ${d.reason || 'Unknown'}`, 'err');
    }
  } catch (err) {
    showToast('❌', err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 WhatsApp pe Bhejo'; }
  }
}

// ── Notice Feed ───────────────────────────────────────────────────────────
async function loadNotices(checkNew = false) {
  lastPollTime = Date.now();
  try {
    const res = await fetch(`${API}/api/notices`, { signal: AbortSignal.timeout(10000) });
    const d = await res.json();
    if (!d.success) return;

    const notices = d.notices || [];
    const newSet = new Set(notices.map(n => String(n.id)));

    if (checkNew && lastNoticeSet.size > 0) {
      notices.filter(n => !lastNoticeSet.has(String(n.id))).forEach(n => {
        showToast('🆕', `Nayi notice: ${n.title?.substring(0, 50)}…`, 'ok');
        if (Notification.permission === 'granted') {
          new Notification('🔔 Nayi BEU Notice!', { body: n.title });
        }
      });
    }

    lastNoticeSet = newSet;
    renderNotices(notices, checkNew ? new Set(notices.filter(n => !lastNoticeSet.has(String(n.id))).map(n => String(n.id))) : new Set());
  } catch {}
}

function renderNotices(list, newIds) {
  const el = document.getElementById('noticeList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div class="notice-loading"><span>Koi notice nahi mili abhi</span></div>';
    return;
  }

  el.innerHTML = list.map((n, i) => {
    const date = n.date ? new Date(n.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    const pdfUrl = n.pdfLink || '#';
    const isNew = newIds.has(String(n.id));

    return `
      <div class="notice-item ${isNew ? 'is-new' : ''}" onclick="window.open('${pdfUrl}','_blank')" style="animation-delay:${i*25}ms">
        <div class="ni-top">
          <span class="ni-tag">📋 BEU PATNA</span>
          <span class="ni-date">${date}</span>
        </div>
        <div class="ni-title">${n.title || 'BEU Notice'}</div>
        <div class="ni-chips">
          ${n.dispatched ? '<span class="chip chip-sent">✅ WA SENT</span>' : '<span class="chip chip-pending">⏳ PENDING</span>'}
          ${n.isUrgent ? '<span class="chip chip-urgent">🚨 URGENT</span>' : ''}
          ${isNew ? '<span class="chip chip-new">NEW</span>' : ''}
        </div>
      </div>`;
  }).join('');
}

// ── Result Box ────────────────────────────────────────────────────────────
function showResult(text, type) {
  const el = document.getElementById('resultBox');
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.className = `result-box ${type || ''}`;
  el.textContent = text;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(icon, msg, type = 'ok') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  stack.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 3500);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function setSlBadge(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = `sl-badge ${cls}`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function updateCount() {
  const ta = document.getElementById('msgBody');
  const cnt = document.getElementById('msgCount');
  if (ta && cnt) cnt.textContent = ta.value.length;
}
