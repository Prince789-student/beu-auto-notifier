/**
 * BEU Auto Notifier — Standalone Dashboard JS
 * Multi-Source: Notice Board + result-one (Results) + Programme Notices
 * Sends exact official / generated PDF documents to WhatsApp Channel
 */

const API = (window.location.protocol === 'file:' || (window.location.port !== '3001' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')))
  ? 'http://localhost:3001'
  : '';

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
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
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
  if (el) el.textContent = `${m}m ${sec.toString().padStart(2, '0')}s`;
}

// ── Server Status ─────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(5000) });
    const d = await res.json();

    // Header pill
    const dot = document.getElementById('pillDot');
    const lbl = document.getElementById('pillLabel');
    if (dot) dot.className = 'pill-dot online';
    if (lbl) lbl.textContent = 'Server Online';

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
    setSlBadge(document.getElementById('st-pdf'), d.sendPdf ? 'ON' : 'OFF', d.sendPdf ? 'ok' : 'off');
    setSlBadge(document.getElementById('st-auto'), d.autoDispatch ? 'ON' : 'OFF', d.autoDispatch ? 'on' : 'off');

    // Stats
    setText('stat-total', d.totalNotices || 0);
    setText('stat-sent', d.sentNotices || 0);
    setText('stat-results', d.resultsCount || 0);
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
    if (dot) dot.className = 'pill-dot offline';
    if (lbl) lbl.textContent = 'Server Offline';
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
        <div class="wa-conn-sub">Notice Board & result-one auto-notifications ON hain — PDFs WhatsApp channel pe auto send honge!</div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap;">
          <button class="btn btn-warning btn-sm" onclick="resetScanner()">🔄 Scanner Change / Naya Number</button>
          <button class="btn btn-ghost btn-sm" onclick="disconnectWa()">Disconnect</button>
        </div>
      </div>`;
  } else if (d.waStatus === 'qr_ready') {
    loadQr();
  } else if (d.waStatus === 'connecting') {
    area.innerHTML = `
      <div class="wa-placeholder">
        <div class="wa-icon-big">⏳</div>
        <p class="wa-msg">WhatsApp QR code ban raha hai… thoda wait karo (5-10 sec)</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="checkStatus()">🔄 Refresh Status</button>
      </div>`;
  } else {
    area.innerHTML = `
      <div class="wa-placeholder">
        <div class="wa-icon-big">📱</div>
        <p class="wa-msg">Connect button dabao ya naye account ke liye Scanner Change karo</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px;">
          <button class="btn btn-primary" onclick="connectWhatsApp()">WhatsApp Connect Karo</button>
          <button class="btn btn-warning" onclick="resetScanner()">🔄 Scanner Change (Naya QR)</button>
        </div>
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
            <div style="display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" onclick="loadQr()">🔄 Refresh QR</button>
              <button class="btn btn-warning btn-sm" onclick="resetScanner()">🔄 Reset / Naya QR Layein</button>
            </div>
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

async function resetScanner() {
  const confirmed = confirm('Kya aap WhatsApp scanner change karna chahte hain?\n\nIsse purana session delete ho jayega aur naye WhatsApp account ko link karne ke liye naya QR code banega.');
  if (!confirmed) return;

  try {
    showToast('⏳', 'Purana session reset ho raha hai, naya QR ban raha hai...', 'warn');
    const res = await fetch(`${API}/api/wa/reset-scanner`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('📷', data.message || 'Naya QR generate ho raha hai...', 'ok');
      let count = 0;
      const pollTimer = setInterval(async () => {
        count++;
        await checkStatus();
        if (count >= 8) clearInterval(pollTimer);
      }, 2000);
    } else {
      showToast('❌', data.message || 'Reset failed', 'err');
    }
  } catch (err) {
    showToast('❌', 'Error: ' + err.message, 'err');
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
    const inpId = document.getElementById('channelIdInput');
    const inpLink = document.getElementById('channelLinkInput');
    const togImg = document.getElementById('sendImageToggle');
    const togPdf = document.getElementById('sendPdfToggle');
    const selMode = document.getElementById('dispatchModeSelect');
    const togAuto = document.getElementById('autoDispatchToggle');

    if (inpId) inpId.value = d.channelId || '';
    if (inpLink) inpLink.value = d.channelLink || '';
    if (togImg) togImg.checked = d.sendImage !== false;
    if (togPdf) togPdf.checked = d.sendPdf !== false;
    if (selMode && d.dispatchMode) selMode.value = d.dispatchMode;
    if (togAuto) togAuto.checked = d.autoDispatch !== false;
  } catch {}
}

async function saveSettings() {
  const channelId = document.getElementById('channelIdInput')?.value.trim() || '';
  const channelLink = document.getElementById('channelLinkInput')?.value.trim() || '';
  const sendImage = document.getElementById('sendImageToggle')?.checked !== false;
  const sendPdf = document.getElementById('sendPdfToggle')?.checked !== false;
  const dispatchMode = document.getElementById('dispatchModeSelect')?.value || 'pdf';
  const autoDispatch = document.getElementById('autoDispatchToggle')?.checked !== false;

  try {
    const res = await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, channelLink, sendImage, sendPdf, dispatchMode, autoDispatch })
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

async function toggleSendPdf(val) {
  try {
    await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sendPdf: val })
    });
    showToast(val ? '📄' : '📝', `PDF Document mode: ${val ? 'ON' : 'OFF'}`, val ? 'ok' : 'warn');
    checkStatus();
  } catch {}
}

async function toggleSendImage(val) {
  try {
    await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sendImage: val })
    });
    showToast(val ? '🖼️' : '📝', `Image mode: ${val ? 'ON' : 'OFF'}`, val ? 'ok' : 'warn');
  } catch {}
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
  if (btn) { btn.disabled = true; btn.querySelector('.ac-title').textContent = 'Scanning…'; }
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
      showResult('⏳ Already scanning chal raha hai — thoda wait karo', 'warn');
    } else if (d.success) {
      showResult(`✅ Scan Done!\nTotal items checked: ${d.newCount}\nSent to WhatsApp: ${d.sentCount}`, 'ok');
      showToast('✅', `Scan complete! ${d.newCount} checked, ${d.sentCount} sent`, 'ok');
      loadNotices(true);
      checkStatus();
    } else {
      showResult(`❌ Error: ${d.error || 'Unknown'}`, 'err');
    }
  } catch (err) {
    showResult(err.name === 'TimeoutError' ? '⏳ Background mein scan chal raha hai…' : `❌ ${err.message}`, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.ac-title').textContent = 'Scan BEU Now'; }
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
      body: JSON.stringify({ message: '🔔 *BEU Auto Notifier — Test Message*\n\nNotice Board + result-one automated system sahi kaam kar raha hai! ✅\nOfficial PDFs WhatsApp channel pe auto send honge.\n\n#BEU #ApnaCollegeBihar #Test' })
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

// ── Notice & Result Feed ──────────────────────────────────────────────────
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
        showToast(n.isResult ? '🎓' : '🔔', `Naya Update: ${n.title?.substring(0, 45)}…`, 'ok');
        if (Notification.permission === 'granted') {
          new Notification(n.isResult ? '🎓 Naya BEU Result!' : '🔔 Nayi BEU Notice!', { body: n.title });
        }
      });
    }

    lastNoticeSet = newSet;
    renderNotices(notices, checkNew ? new Set(notices.filter(n => !lastNoticeSet.has(String(n.id))).map(n => String(n.id))) : new Set());
  } catch {}
}

let noticesById = {};
let activeModalNoticeId = null;

function renderNotices(list, newIds) {
  const el = document.getElementById('noticeList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div class="notice-loading"><span>Koi notice ya result nahi mili abhi</span></div>';
    return;
  }

  noticesById = {};
  list.forEach(n => { noticesById[String(n.id)] = n; });

  el.innerHTML = list.map((n, i) => {
    const date = n.date ? new Date(n.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const isNew = newIds.has(String(n.id));
    const hasImg = !!n.imageUrl;
    const hasPdf = !!(n.pdfUrl || n.pdfPath);
    const isResult = n.isResult || String(n.id).startsWith('result_');
    const isRoutine = n.type === 'routine' || String(n.id).startsWith('routine_');

    const pdfTarget = n.pdfUrl ? `${API}${n.pdfUrl}` : (n.pdfLink || '#');
    const portalUrl = isResult ? 'https://beu-bih.ac.in/result-one' : pdfTarget;

    const sourceTag = isResult ? '🎓 RESULT-ONE' : isRoutine ? '📅 EXAM ROUTINE' : '📋 NOTICE BOARD';

    return `
      <div class="notice-item ${isNew ? 'is-new' : ''} ${isResult ? 'notice-item--result' : ''}" style="animation-delay:${i * 20}ms">
        <div class="ni-top">
          <span class="ni-tag ${isResult ? 'ni-tag--result' : ''}">${sourceTag}</span>
          <span class="ni-date">${date}</span>
        </div>
        <div class="ni-title" onclick="window.open('${portalUrl}','_blank')">${n.title || 'BEU Notification'}</div>

        ${hasImg ? `
          <img class="notice-thumb" src="${n.imageUrl}" alt="Notice Preview" onclick="openImgModal('${n.id}')" title="Click to view full image & PDF" />
        ` : ''}

        <div class="ni-chips">
          ${n.dispatched ? '<span class="chip chip-sent">✅ WA SENT</span>' : '<span class="chip chip-pending">⏳ PENDING</span>'}
          ${isResult ? '<span class="chip chip-ok" style="background:rgba(16,185,129,0.15);color:#059669;border-color:rgba(16,185,129,0.3)">🎓 RESULT</span>' : ''}
          ${hasPdf ? '<span class="chip chip-ok" style="background:rgba(239,68,68,0.12);color:#dc2626;border-color:rgba(239,68,68,0.25)">📄 PDF READY</span>' : ''}
          ${hasImg ? '<span class="chip chip-ok" style="background:rgba(59,130,246,0.15);color:#2563eb;border-color:rgba(59,130,246,0.3)">🖼️ IMAGE</span>' : ''}
          ${n.isUrgent ? '<span class="chip chip-urgent">🚨 URGENT</span>' : ''}
          ${isNew ? '<span class="chip chip-new">NEW</span>' : ''}
        </div>

        <div class="ni-actions">
          ${hasImg ? `
            <button class="ni-btn ni-btn-img" onclick="openImgModal('${n.id}')">🖼️ View Card</button>
          ` : `
            <button class="ni-btn" onclick="generateImageForNotice('${n.id}', this)">🎨 Get PDF/Img</button>
          `}
          <a class="ni-btn" href="${pdfTarget}" target="_blank">📄 Open PDF</a>
          ${isResult ? `<a class="ni-btn" href="https://beu-bih.ac.in/result-one" target="_blank">🌐 Portal</a>` : ''}
          <button class="ni-btn ni-btn-wa" onclick="sendSingleNotice('${n.id}', this)">🚀 Send to WA</button>
        </div>
      </div>`;
  }).join('');
}

function openImgModal(id) {
  const n = noticesById[String(id)];
  if (!n) return;
  activeModalNoticeId = String(id);

  const modal = document.getElementById('imgModal');
  const img = document.getElementById('modalImg');
  const title = document.getElementById('modalTitle');
  const downloadBtn = document.getElementById('modalDownloadBtn');
  const pdfBtn = document.getElementById('modalPdfBtn');

  const pdfTarget = n.pdfUrl ? `${API}${n.pdfUrl}` : (n.pdfLink || '#');

  if (title) title.textContent = n.title || 'Notice & PDF Preview';
  if (img) img.src = n.imageUrl || '';
  if (downloadBtn) {
    downloadBtn.href = n.imageUrl || '';
    downloadBtn.download = `BEU_${n.id}.png`;
  }
  if (pdfBtn) {
    pdfBtn.href = pdfTarget;
  }

  if (modal) modal.style.display = 'flex';
}

function closeImgModal(e, force = false) {
  if (force || (e && e.target && e.target.id === 'imgModal')) {
    const modal = document.getElementById('imgModal');
    if (modal) modal.style.display = 'none';
    activeModalNoticeId = null;
  }
}

async function sendNoticeFromModal() {
  if (!activeModalNoticeId) return;
  const btn = document.getElementById('modalSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Bhej raha hai...'; }

  await sendSingleNotice(activeModalNoticeId);
  if (btn) { btn.disabled = false; btn.textContent = '🚀 Send with PDF to WA'; }
}

async function sendSingleNotice(id, btn = null) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending...'; }
  try {
    const res = await fetch(`${API}/api/notices/${id}/send`, { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      showToast('✅', `Item #${id} WhatsApp channel pe bhej diya gaya! (PDF: ${d.result?.hasPdf ? 'Haan' : 'Nahi'})`, 'ok');
      loadNotices();
      checkStatus();
    } else {
      showToast('❌', `Send failed: ${d.result?.reason || d.error || 'Check connection'}`, 'err');
    }
  } catch (err) {
    showToast('❌', err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Send to WA'; }
  }
}

async function generateImageForNotice(id, btn = null) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Rendering...'; }
  showToast('⏳', `Item #${id} ke liye PDF aur Image ban rahi hai...`, 'warn');
  try {
    const res = await fetch(`${API}/api/notices/${id}/generate-image`, { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      showToast('✅', `PDF aur Image ready ho gaye!`, 'ok');
      await loadNotices();
      openImgModal(id);
    } else {
      showToast('❌', `Generation failed: ${d.error || 'Error'}`, 'err');
    }
  } catch (err) {
    showToast('❌', err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎨 Get PDF/Img'; }
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setSlBadge(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = 'sl-badge ' + (cls || '');
}

function showResult(text, type) {
  const b = document.getElementById('resultBox');
  if (!b) return;
  if (!text) { b.style.display = 'none'; return; }
  b.className = `result-box rb-${type || 'info'}`;
  b.textContent = text;
  b.style.display = 'block';
}

function showToast(icon, text, type = '') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = `toast ${type ? 'toast-' + type : ''}`;
  t.innerHTML = `<span class="toast-icon">${icon}</span><span>${text}</span>`;
  stack.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, 3800);
}

function updateCount() {
  const val = document.getElementById('msgBody')?.value || '';
  const el = document.getElementById('msgCount');
  if (el) el.textContent = val.length;
}
