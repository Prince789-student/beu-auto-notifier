require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const BEU_API_URL = process.env.BEU_API_URL || 'https://beu-bih.ac.in/backend/v1/notice/get-notice-board';
const DATA_FILE = path.join(__dirname, 'data', 'notices.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MINUTES || '2');

// ─── Ensure data dir ───────────────────────────────────────────────────────
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// ─── State ─────────────────────────────────────────────────────────────────
let waClient = null;
let waStatus = 'disconnected'; // connecting | qr_ready | connected | disconnected
let waQrDataUrl = null;
let waQrCode = null;
let lastCheckTime = null;
let isChecking = false;
let totalSentToday = 0;
let serverStartTime = new Date();

// ─── Helpers ───────────────────────────────────────────────────────────────
function loadNotices() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveNotices(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return { autoDispatch: process.env.AUTO_DISPATCH !== 'false', channelId: process.env.WHATSAPP_CHANNEL_ID || '' };
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function log(msg) {
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─── WhatsApp Client ───────────────────────────────────────────────────────
function initWhatsApp() {
  log('📱 WhatsApp client initialize ho raha hai...');
  waStatus = 'connecting';

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wpp_session') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  waClient.on('qr', async (qr) => {
    waStatus = 'qr_ready';
    waQrCode = qr;
    try {
      waQrDataUrl = await qrcode.toDataURL(qr);
    } catch {}
    log('📷 QR code ready — dashboard pe scan karein');
    // Also print to terminal
    try {
      require('qrcode-terminal').generate(qr, { small: true });
    } catch {}
  });

  waClient.on('authenticated', () => {
    log('🔐 WhatsApp authenticated!');
    waStatus = 'connecting';
    waQrCode = null;
    waQrDataUrl = null;
  });

  waClient.on('ready', () => {
    log('✅ WhatsApp connected & ready!');
    waStatus = 'connected';
    waQrCode = null;
    waQrDataUrl = null;
  });

  waClient.on('disconnected', (reason) => {
    log(`❌ WhatsApp disconnected: ${reason}`);
    waStatus = 'disconnected';
    waClient = null;
  });

  waClient.initialize().catch(err => {
    log(`❌ WhatsApp init error: ${err.message}`);
    waStatus = 'disconnected';
  });
}

// ─── Send WhatsApp Message ─────────────────────────────────────────────────
async function sendToWhatsApp(caption, channelId) {
  if (!waClient || waStatus !== 'connected') {
    return { success: false, reason: 'WhatsApp not connected' };
  }

  const settings = loadSettings();
  const target = channelId || settings.channelId;
  if (!target) {
    return { success: false, reason: 'Channel ID set nahi hai' };
  }

  try {
    // Format: channel ID as WhatsApp chat ID
    const chatId = target.includes('@') ? target : `${target}@newsletter`;
    await waClient.sendMessage(chatId, caption);
    totalSentToday++;
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── BEU Notice Checker ────────────────────────────────────────────────────
async function checkAndBroadcast(forceAll = false) {
  if (isChecking) { log('⏳ Already checking, skip...'); return { skipped: true }; }

  isChecking = true;
  lastCheckTime = new Date().toISOString();
  log(`🔍 BEU notices check kar raha hai...`);

  const settings = loadSettings();
  const localCache = loadNotices();
  let newCount = 0;
  let sentCount = 0;
  const results = [];

  try {
    const res = await axios.get(BEU_API_URL, { timeout: 20000 });
    const rawNotices = Array.isArray(res.data) ? res.data : [];

    log(`📋 ${rawNotices.length} notices mili BEU se`);

    for (const n of rawNotices.slice(0, 15)) {
      const id = String(n.id);
      const existing = localCache[id];
      const isNew = !existing || forceAll;

      const title = (n.board || 'BEU Notice').trim();
      const pdfLink = n.link ? `https://beu-bih.ac.in/backend/${encodeURIComponent(n.link.trim())}` : '';
      const date = n.noticedate || new Date().toISOString().split('T')[0];
      const isUrgent = n.isimportant === 1;

      if (isNew) {
        newCount++;
        log(`🆕 Nayi notice: ${title}`);

        // Build WhatsApp caption
        const caption = buildCaption({ title, pdfLink, date, isUrgent });

        // Save to cache
        localCache[id] = {
          id, title, pdfLink, date, isUrgent,
          caption,
          dispatched: false,
          createdAt: new Date().toISOString()
        };
        saveNotices(localCache);

        // Auto dispatch
        if (settings.autoDispatch && settings.channelId) {
          const sendResult = await sendToWhatsApp(caption, settings.channelId);
          localCache[id].dispatched = sendResult.success;
          localCache[id].dispatchedAt = new Date().toISOString();
          saveNotices(localCache);

          if (sendResult.success) {
            sentCount++;
            log(`✅ Sent to WhatsApp: ${title}`);
          } else {
            log(`⚠️ WhatsApp send failed: ${sendResult.reason}`);
          }
        }

        results.push({ id, title, isNew: true, dispatched: localCache[id].dispatched });
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    log(`✅ Check done — ${newCount} new, ${sentCount} sent`);
    return { success: true, newCount, sentCount, results };

  } catch (err) {
    log(`❌ BEU check error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    isChecking = false;
  }
}

function buildCaption({ title, pdfLink, date, isUrgent }) {
  const dateStr = new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return [
    isUrgent ? '🚨 *URGENT BEU NOTICE*' : '🔔 *New BEU Notice*',
    '',
    `📌 *${title}*`,
    `🗓️ Date: ${dateStr}`,
    '',
    pdfLink ? `📄 *Download PDF:*\n👉 ${pdfLink}` : '',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '#BEU #BiharEngineering #Notice'
  ].filter(Boolean).join('\n');
}

// ─── Cron Job ──────────────────────────────────────────────────────────────
const cronExpr = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpr, () => {
  log(`⏰ Cron: BEU auto-check (har ${CHECK_INTERVAL} min)`);
  checkAndBroadcast();
});
log(`✅ Cron scheduled: har ${CHECK_INTERVAL} minute`);

// ─── API Routes ────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    waStatus,
    lastCheckTime,
    isChecking,
    totalSentToday
  });
});

// Status
app.get('/api/status', (req, res) => {
  const settings = loadSettings();
  const notices = loadNotices();
  const noticeList = Object.values(notices).filter(n => n.id);
  res.json({
    waStatus,
    hasQr: !!waQrCode,
    lastCheckTime,
    isChecking,
    totalSentToday,
    autoDispatch: settings.autoDispatch,
    channelId: settings.channelId ? '✓ Set' : '✗ Not set',
    totalNotices: noticeList.length,
    sentNotices: noticeList.filter(n => n.dispatched).length,
    pendingNotices: noticeList.filter(n => !n.dispatched).length,
    checkIntervalMins: CHECK_INTERVAL
  });
});

// QR Code (for WhatsApp login)
app.get('/api/qr', (req, res) => {
  if (waQrDataUrl) {
    res.json({ hasQr: true, qrDataUrl: waQrDataUrl });
  } else {
    res.json({ hasQr: false, waStatus });
  }
});

// All notices
app.get('/api/notices', (req, res) => {
  const notices = loadNotices();
  const list = Object.values(notices)
    .filter(n => n.id)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
  res.json({ success: true, count: list.length, notices: list });
});

// Manual sync
app.post('/api/sync', async (req, res) => {
  const forceAll = req.body?.forceAll === true;
  const result = await checkAndBroadcast(forceAll);
  res.json(result);
});

// Send custom message to WhatsApp
app.post('/api/send-custom', async (req, res) => {
  const { message, title, pdfLink } = req.body || {};
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });

  const settings = loadSettings();
  const caption = title
    ? buildCaption({ title, pdfLink: pdfLink || '', date: new Date().toISOString(), isUrgent: false }) + '\n\n' + message
    : message;

  const result = await sendToWhatsApp(caption, settings.channelId);
  res.json(result);
});

// Send a specific notice manually
app.post('/api/send-notice/:id', async (req, res) => {
  const notices = loadNotices();
  const n = notices[req.params.id];
  if (!n) return res.status(404).json({ success: false, error: 'Notice not found' });

  const result = await sendToWhatsApp(n.caption || buildCaption(n));
  if (result.success) {
    n.dispatched = true;
    n.dispatchedAt = new Date().toISOString();
    notices[req.params.id] = n;
    saveNotices(notices);
  }
  res.json(result);
});

// Get/Update settings
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const { autoDispatch, channelId } = req.body || {};
  if (typeof autoDispatch === 'boolean') current.autoDispatch = autoDispatch;
  if (channelId !== undefined) current.channelId = channelId.trim();
  saveSettings(current);
  res.json({ success: true, settings: current });
});

// WhatsApp connect/disconnect
app.post('/api/wa/connect', (req, res) => {
  if (waStatus === 'connected') return res.json({ success: true, message: 'Already connected' });
  initWhatsApp();
  res.json({ success: true, message: 'WhatsApp initialization started — QR scan karein' });
});

app.post('/api/wa/disconnect', async (req, res) => {
  if (waClient) {
    try { await waClient.destroy(); } catch {}
    waClient = null;
  }
  waStatus = 'disconnected';
  res.json({ success: true, message: 'WhatsApp disconnected' });
});

// Serve dashboard for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 BEU Auto Notifier server chalu hai: http://localhost:${PORT}`);
  log(`📡 BEU check: har ${CHECK_INTERVAL} minute`);
  log(`💬 WhatsApp: ${waStatus}`);
});

// Auto-start WhatsApp if session exists
setTimeout(() => {
  const sessionPath = path.join(__dirname, '.wpp_session');
  if (fs.existsSync(sessionPath)) {
    log('🔄 Purana WhatsApp session mila — auto-connect kar raha hai...');
    initWhatsApp();
  } else {
    log('ℹ️ WhatsApp session nahi mila — dashboard se connect karein');
  }
}, 1000);
