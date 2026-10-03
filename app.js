/**
 * AutoNotify — BEU Command Center
 * Standalone admin dashboard for controlling BEU auto-notifications
 * Connects to: https://apnacollegebihar.online (production server)
 */

// ═══════════════════════════════════
// CONFIG — Change API_BASE if running locally
// ═══════════════════════════════════
const API_BASE = 'https://apnacollegebihar.online';

// ═══════════════════════════════════
// STATE
// ═══════════════════════════════════
let serverOnline = false;
let noticeData = [];
let pushSubscription = null;
let pollInterval = null;
let lastNoticeIds = new Set();
let nextCheckTimer = null;

// ═══════════════════════════════════
// INIT
// ═══════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  checkServerHealth();
  loadConfig();
  loadNotices();

  // Re-check server every 30s
  setInterval(checkServerHealth, 30000);

  // Poll for new notices every 2 minutes (mirrors server cron)
  pollInterval = setInterval(() => {
    loadNotices(true);
  }, 120000);

  updateNextCheckTime();
  setInterval(updateNextCheckTime, 1000);

  checkBrowserPushStatus();
});

// ═══════════════════════════════════
// CLOCK
// ═══════════════════════════════════
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('headerTime').textContent =
      now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  tick();
  setInterval(tick, 1000);
}

// ═══════════════════════════════════
// NEXT CHECK TIMER
// ═══════════════════════════════════
let lastPollTime = Date.now();
function updateNextCheckTime() {
  const elapsed = Date.now() - lastPollTime;
  const remaining = Math.max(0, 120000 - elapsed);
  const secs = Math.ceil(remaining / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const el = document.getElementById('nextCheckTime');
  if (el) el.textContent = `${m}m ${s.toString().padStart(2,'0')}s`;
}

// ═══════════════════════════════════
// SERVER HEALTH CHECK
// ═══════════════════════════════════
async function checkServerHealth() {
  const dot = document.getElementById('serverDot');
  const label = document.getElementById('serverLabel');
  const stServer = document.getElementById('st-server');

  try {
    const res = await fetch(`${API_BASE}/_health`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      serverOnline = true;
      dot.className = 'status-dot online';
      label.textContent = 'Server Online';
      setBadge(stServer, 'OK', 'badge--ok');
    } else {
      throw new Error('Non-OK');
    }
  } catch {
    serverOnline = false;
    dot.className = 'status-dot offline';
    label.textContent = 'Server Offline';
    setBadge(stServer, 'OFFLINE', 'badge--offline');
  }
}

// ═══════════════════════════════════
// LOAD CONFIG — Broadcast Settings
// ═══════════════════════════════════
async function loadConfig() {
  const btn = document.getElementById('btnRefreshConfig');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Loading…'; }

  try {
    const res = await fetch(`${API_BASE}/api/beu/config-status`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    // WhatsApp Bot status
    const stWa = document.getElementById('st-wa');
    const stAi = document.getElementById('st-ai');
    const stFcm = document.getElementById('st-fcm');

    setBadge(stWa, data.botConnected ? 'CONNECTED' : (data.botStatus === 'initializing' ? 'STARTING' : 'OFFLINE'),
             data.botConnected ? 'badge--ok' : 'badge--offline');
    setBadge(stAi, data.hasGeminiKey ? 'OK' : 'NO KEY', data.hasGeminiKey ? 'badge--ok' : 'badge--offline');
    setBadge(stFcm, 'FIREBASE OK', 'badge--ok');

    // Toggle switches
    const swWaCentral = document.getElementById('sw-wa-central');
    const swWaCollege = document.getElementById('sw-wa-college');
    const lblWaCentral = document.getElementById('lbl-wa-central');
    const lblWaCollege = document.getElementById('lbl-wa-college');

    if (swWaCentral) {
      swWaCentral.checked = !!data.autoDispatchWhatsApp;
      lblWaCentral.textContent = data.autoDispatchWhatsApp ? 'AUTO ON' : 'OFF';
      lblWaCentral.className = 'tr-status ' + (data.autoDispatchWhatsApp ? 'on' : 'off');
    }

    if (swWaCollege) {
      swWaCollege.checked = !!data.autoDispatchCollegeNotices;
      lblWaCollege.textContent = data.autoDispatchCollegeNotices ? 'AUTO ON' : 'OFF';
      lblWaCollege.className = 'tr-status ' + (data.autoDispatchCollegeNotices ? 'on' : 'off');
    }

    // Last check time
    if (data.lastAutoCheck) {
      const d = new Date(data.lastAutoCheck);
      document.getElementById('lastCheckTime').textContent = d.toLocaleTimeString('en-IN', { hour12: false });
    }

    showToast('✅', 'Config loaded!', 'success');

  } catch (err) {
    showToast('❌', 'Config load failed — server unreachable', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
}

// ═══════════════════════════════════
// UPDATE BROADCAST SETTING
// ═══════════════════════════════════
async function updateBroadcastSetting(key, value) {
  const body = {};
  body[key] = value;

  const lblKey = key === 'autoDispatchWhatsApp' ? 'lbl-wa-central' : 'lbl-wa-college';
  const lbl = document.getElementById(lblKey);

  if (lbl) {
    lbl.textContent = value ? 'AUTO ON' : 'OFF';
    lbl.className = 'tr-status ' + (value ? 'on' : 'off');
  }

  try {
    const res = await fetch(`${API_BASE}/api/beu/update-broadcast-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });

    const data = await res.json();
    if (data.success) {
      showToast('✅', `${key === 'autoDispatchWhatsApp' ? 'WhatsApp BEU' : 'WhatsApp Colleges'} → ${value ? 'AUTO ON' : 'OFF'}`, 'success');
    } else {
      showToast('⚠️', 'Setting update failed. Auth required?', 'warn');
    }
  } catch {
    showToast('❌', 'Network error — setting may not have saved', 'error');
  }
}

// ═══════════════════════════════════
// TRIGGER MANUAL BEU SYNC
// ═══════════════════════════════════
async function triggerSync() {
  const btn = document.getElementById('btnSync');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.querySelector('.ab-title').textContent = 'Syncing…';
  btn.querySelector('.ab-icon').textContent = '⏳';

  showResult(null, null, null);

  try {
    const res = await fetch(`${API_BASE}/api/beu/sync-and-broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceAll: false }),
      signal: AbortSignal.timeout(60000)
    });

    const data = await res.json();
    lastPollTime = Date.now();

    if (data.success) {
      showResult('✅', 'Sync Successful!',
        `New notices: ${data.data?.newCount ?? 0}\nAI processed: ${data.data?.aiCount ?? 0}\n${data.message || ''}`
      , 'success');
      showToast('✅', `Sync done! ${data.data?.newCount ?? 0} new notices.`, 'success');
      loadNotices(true);
      // Update stats
      updateStatIfPresent('stat-ai', data.data?.aiCount);
    } else {
      showResult('❌', 'Sync Failed', data.message || 'Unknown error', 'error');
      showToast('❌', 'Sync failed!', 'error');
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      showResult('⏳', 'Still Running…', 'Sync is taking time — check back in a minute. Server is working in background.', 'success');
      showToast('⏳', 'Sync running in background…', 'warn');
    } else {
      showResult('❌', 'Network Error', err.message, 'error');
      showToast('❌', 'Connection failed', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.querySelector('.ab-title').textContent = 'BEU Sync Now';
    btn.querySelector('.ab-icon').textContent = '🔄';
  }
}

// ═══════════════════════════════════
// WHATSAPP TEST
// ═══════════════════════════════════
async function sendTestWhatsApp() {
  const btn = document.getElementById('btnTestWA');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.querySelector('.ab-title').textContent = 'Sending…';

  try {
    const res = await fetch(`${API_BASE}/api/beu/whatsapp-test-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();

    if (data.success) {
      showResult('✅', 'WhatsApp Test Sent!', 'Test message WhatsApp Channel par bheja gaya ✅', 'success');
      showToast('✅', 'WhatsApp test message sent!', 'success');
    } else {
      showResult('❌', 'WhatsApp Send Failed', JSON.stringify(data.result || data.message, null, 2), 'error');
      showToast('❌', 'WhatsApp send failed — bot connected?', 'error');
    }
  } catch (err) {
    showResult('❌', 'Error', err.message, 'error');
    showToast('❌', 'WhatsApp test failed', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.ab-title').textContent = 'WhatsApp Test';
  }
}

// ═══════════════════════════════════
// BROWSER PUSH NOTIFICATION
// ═══════════════════════════════════
function checkBrowserPushStatus() {
  const lbl = document.getElementById('lbl-browser-push');
  const stBrowser = document.getElementById('st-browser');
  const btn = document.getElementById('btnBrowserPush');

  if (!('Notification' in window)) {
    if (lbl) lbl.textContent = 'NOT SUPPORTED';
    if (stBrowser) setBadge(stBrowser, 'N/A', 'badge--offline');
    return;
  }

  if (Notification.permission === 'granted') {
    if (lbl) { lbl.textContent = 'ENABLED'; lbl.className = 'tr-status on'; }
    if (btn) { btn.textContent = 'Disable'; btn.className = 'btn btn--ghost btn--sm'; }
    if (stBrowser) setBadge(stBrowser, 'ENABLED', 'badge--ok');
  } else if (Notification.permission === 'denied') {
    if (lbl) { lbl.textContent = 'BLOCKED'; lbl.className = 'tr-status off'; }
    if (btn) btn.textContent = 'Blocked (Settings se enable karo)';
    if (stBrowser) setBadge(stBrowser, 'BLOCKED', 'badge--offline');
  } else {
    if (lbl) { lbl.textContent = 'NOT ENABLED'; lbl.className = 'tr-status'; }
    if (btn) { btn.textContent = 'Enable'; btn.className = 'btn btn--accent btn--sm'; }
    if (stBrowser) setBadge(stBrowser, 'OFF', 'badge--checking');
  }
}

async function toggleBrowserPush() {
  if (!('Notification' in window)) {
    showToast('❌', 'Is browser mein push notifications supported nahi hain', 'error');
    return;
  }

  if (Notification.permission === 'granted') {
    showToast('ℹ️', 'Browser push already enabled hai', 'warn');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    showToast('✅', 'Browser push notifications enabled!', 'success');
    // Test notification
    new Notification('🔔 BEU AutoNotify', {
      body: 'Browser notifications enable ho gaye! Ab aapko BEU ki sabhi nayi notices ki notification milegi.',
      icon: 'https://apnacollegebihar.online/favicon.ico',
      badge: 'https://apnacollegebihar.online/favicon.ico',
      tag: 'beu-enabled'
    });
  } else if (permission === 'denied') {
    showToast('❌', 'Permission blocked — browser settings se enable karo', 'error');
  }
  checkBrowserPushStatus();
}

async function sendTestBrowserNotif() {
  if (!('Notification' in window)) {
    showToast('❌', 'Browser push supported nahi hai', 'error');
    return;
  }
  if (Notification.permission !== 'granted') {
    await toggleBrowserPush();
    return;
  }

  new Notification('🚨 BEU Test Notification', {
    body: 'Ye ek test notification hai — BEU AutoNotify system kaafi acha kaam kar raha hai! ✅',
    icon: 'https://apnacollegebihar.online/favicon.ico',
    tag: 'beu-test-' + Date.now()
  });
  showToast('🔔', 'Test browser notification bheja gaya!', 'success');
}

// ═══════════════════════════════════
// CUSTOM NOTIFICATION SENDER
// ═══════════════════════════════════
async function sendCustomNotification() {
  const title = document.getElementById('customTitle').value.trim();
  const msg = document.getElementById('customMsg').value.trim();
  const pdfUrl = document.getElementById('customPdf').value.trim();
  const sendWA = document.getElementById('sendWA').checked;
  const sendBrowser = document.getElementById('sendBrowser').checked;

  if (!title) { showToast('⚠️', 'Title bharna zaroori hai!', 'warn'); return; }
  if (!msg) { showToast('⚠️', 'Message likho pehle!', 'warn'); return; }
  if (!sendWA && !sendBrowser) { showToast('⚠️', 'Kam se kam ek channel select karo!', 'warn'); return; }

  const btn = document.getElementById('btnSendCustom');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span> Bhej raha hai…';

  let results = [];

  // Browser Push
  if (sendBrowser) {
    if (Notification.permission === 'granted') {
      new Notification(`🔔 ${title}`, {
        body: msg.substring(0, 200),
        icon: 'https://apnacollegebihar.online/favicon.ico',
        tag: 'beu-custom-' + Date.now()
      });
      results.push('✅ Browser push notification bheja gaya');
    } else {
      results.push('⚠️ Browser push: permission nahi hai — pehle enable karo');
    }
  }

  // WhatsApp
  if (sendWA) {
    try {
      const fullCaption = msg + (pdfUrl ? `\n\n📄 Notice Link:\n👉 ${pdfUrl}` : '');
      const res = await fetch(`${API_BASE}/api/beu/dispatch-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noticeId: 'custom_' + Date.now(),
          caption: fullCaption,
          title: title,
          pdfUrl: pdfUrl || ''
        }),
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json();
      if (data.success && data.result?.status === 'SENT') {
        results.push('✅ WhatsApp Channel par bheja gaya');
      } else {
        results.push(`⚠️ WhatsApp: ${data.result?.status || 'Failed'} — ${data.result?.reason || ''}`);
      }
    } catch (err) {
      results.push('❌ WhatsApp error: ' + err.message);
    }
  }

  showResult(
    results.every(r => r.startsWith('✅')) ? '✅' : '⚠️',
    'Send Results',
    results.join('\n'),
    results.every(r => r.startsWith('✅')) ? 'success' : 'warn'
  );

  showToast(results.every(r => r.startsWith('✅')) ? '✅' : '⚠️', 'Custom notification processed!', 'success');

  btn.disabled = false;
  btn.innerHTML = '<span>🚀</span> Abhi Bhejo';
}

// ═══════════════════════════════════
// LOAD & DISPLAY NOTICES
// ═══════════════════════════════════
async function loadNotices(checkForNew = false) {
  lastPollTime = Date.now();

  try {
    const res = await fetch(`${API_BASE}/api/beu/notices`, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    if (!data.success) return;

    const notices = (data.notices || []).slice(0, 50);
    const newIds = new Set(notices.map(n => String(n.id)));

    // Check for new notices (after initial load)
    if (checkForNew && lastNoticeIds.size > 0) {
      const brandNew = notices.filter(n => !lastNoticeIds.has(String(n.id)));
      if (brandNew.length > 0) {
        brandNew.forEach(n => {
          showToast('🆕', `Nayi notice: ${n.title?.substring(0, 60)}…`, 'success');
          if (Notification.permission === 'granted') {
            new Notification('🔔 Nayi BEU Notice!', {
              body: n.title,
              icon: 'https://apnacollegebihar.online/favicon.ico',
              tag: 'beu-new-' + n.id
            });
          }
        });
      }
    }

    lastNoticeIds = newIds;
    noticeData = notices;
    renderNotices(notices, checkForNew ? new Set(notices.filter(n => !lastNoticeIds.has(String(n.id))).map(n => String(n.id))) : new Set());

    // Update stats
    const total = notices.length;
    const sent = notices.filter(n => n.whatsappDispatched).length;
    const aiDone = notices.filter(n => n.aiProcessed).length;
    const pending = notices.filter(n => n.aiProcessed && !n.whatsappDispatched).length;

    setStatNum('stat-notices', total);
    setStatNum('stat-sent', sent);
    setStatNum('stat-ai', aiDone);
    setStatNum('stat-pending', pending);

    // Update last check time
    if (data.lastAutoCheck) {
      const d = new Date(data.lastAutoCheck);
      const el = document.getElementById('lastCheckTime');
      if (el) el.textContent = d.toLocaleTimeString('en-IN', { hour12: false });
    }

  } catch {
    // Silent fail — will retry on next poll
  }
}

function renderNotices(notices, newIds) {
  const feed = document.getElementById('noticeFeed');
  if (!feed) return;

  if (!notices.length) {
    feed.innerHTML = '<div class="feed-loading"><span>Koi notice nahi mili abhi</span></div>';
    return;
  }

  feed.innerHTML = notices.map((n, i) => {
    const isNew = newIds.has(String(n.id));
    const isCollege = !!(n.isCollegeNotice || String(n.id).startsWith('col_'));
    const dateStr = n.date || n.noticedate || '';
    const formattedDate = dateStr ? new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
    const pdfUrl = n.pdfUrl || n.link || '#';

    return `
      <div class="notice-card ${isNew ? 'is-new' : ''}" onclick="window.open('${pdfUrl}', '_blank')" style="animation-delay: ${i * 30}ms" title="${n.title || ''}">
        <div class="nc-header">
          <span class="nc-tag">${isCollege ? '🏛 ' + (n.shortName || 'COLLEGE') : '📋 BEU PATNA'}</span>
          <span class="nc-date">${formattedDate}</span>
        </div>
        <div class="nc-title">${n.title || n.board || 'BEU Notice'}</div>
        <div class="nc-status">
          ${n.aiProcessed ? '<span class="nc-chip">🤖 AI</span>' : ''}
          ${n.whatsappDispatched ? '<span class="nc-chip sent">✅ WA</span>' : ''}
          ${n.isimportant == 1 ? '<span class="nc-chip" style="background:oklch(65% 0.22 25 / 0.15);color:oklch(65% 0.22 25)">🚨 URGENT</span>' : ''}
          ${isNew ? '<span class="nc-chip" style="background:oklch(72% 0.22 150/0.2);color:var(--color-accent)">NEW</span>' : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════
// CHARACTER COUNT
// ═══════════════════════════════════
function updateCharCount() {
  const ta = document.getElementById('customMsg');
  const cnt = document.getElementById('charCount');
  if (ta && cnt) cnt.textContent = ta.value.length;
}

// ═══════════════════════════════════
// RESULT PANEL
// ═══════════════════════════════════
function showResult(icon, title, body, type) {
  const panel = document.getElementById('resultPanel');
  if (!panel) return;

  if (!icon) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  panel.className = 'result-panel ' + (type || '');
  document.getElementById('resultIcon').textContent = icon;
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultBody').textContent = body;

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ═══════════════════════════════════
// TOAST
// ═══════════════════════════════════
function showToast(icon, message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ═══════════════════════════════════
// HELPERS
// ═══════════════════════════════════
function setBadge(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = `si-badge ${cls}`;
}

function setStatNum(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined) el.textContent = val;
}

function updateStatIfPresent(id, val) {
  if (val !== undefined && val !== null) setStatNum(id, val);
}
