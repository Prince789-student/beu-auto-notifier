require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const { useMongoAuthState } = require('./mongoAuthState');

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || '';
const BEU_API_URL = process.env.BEU_API_URL || 'https://beu-bih.ac.in/backend/v1/notice/get-notice-board';
const DATA_FILE = path.join(__dirname, 'data', 'notices.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MINUTES || '2');

// MongoDB
let mongoClient = null;
let mongoDb = null;

// ─── Ensure dirs ───────────────────────────────────────────────────────────
[path.join(__dirname, 'data'), AUTH_FOLDER].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── State ─────────────────────────────────────────────────────────────────
let waSocket = null;
let waStatus = 'disconnected';
let waQrDataUrl = null;
let lastCheckTime = null;
let isChecking = false;
let totalSentToday = 0;
let serverStartTime = new Date();
let reconnectTimer = null;

// ─── Helpers ───────────────────────────────────────────────────────────────
function loadNotices() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  return {};
}
function saveNotices(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function loadSettings() {
  try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return { autoDispatch: process.env.AUTO_DISPATCH !== 'false', channelId: process.env.WHATSAPP_CHANNEL_ID || '' };
}
function saveSettings(data) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function log(msg) {
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─── WhatsApp via Baileys (No Chrome!) ────────────────────────────────────
async function initWhatsApp() {
  if (waStatus === 'connecting' || waStatus === 'connected') return;

  log('📱 WhatsApp (Baileys) initialize ho raha hai...');
  waStatus = 'connecting';

  try {
    // MongoDB auth — ya fallback to file
    let authState, saveCreds;
    if (mongoDb) {
      log('🍃 MongoDB session use ho rahi hai...');
      const mongoAuth = await useMongoAuthState(mongoDb);
      authState = mongoAuth.state;
      saveCreds = mongoAuth.saveCreds;
    } else {
      log('📁 File-based session use ho rahi hai...');
      const fileAuth = await useMultiFileAuthState(AUTH_FOLDER);
      authState = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: 'silent' }), // Quiet logs
      printQRInTerminal: false,
      browser: ['BEU Notifier', 'Chrome', '1.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      markOnlineOnConnect: false,
    });

    waSocket = sock;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      // QR Code mila — frontend ko denge
      if (qr) {
        log('📷 QR code ready — dashboard pe scan karein!');
        waStatus = 'qr_ready';
        try {
          waQrDataUrl = await qrcode.toDataURL(qr);
        } catch (e) { log('QR generate error: ' + e.message); }
      }

      if (connection === 'open') {
        log('✅ WhatsApp connected!');
        waStatus = 'connected';
        waQrDataUrl = null;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log(`⚠️ WhatsApp disconnected (code: ${code}) — reconnect: ${shouldReconnect}`);
        waStatus = 'disconnected';
        waSocket = null;
        waQrDataUrl = null;

        if (shouldReconnect) {
          log('🔄 15 second baad reconnect karega...');
          reconnectTimer = setTimeout(initWhatsApp, 15000);
        } else {
          log('🚪 Logged out — auth folder clear kar raha hai...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    log(`❌ WhatsApp init error: ${err.message}`);
    waStatus = 'disconnected';
    waSocket = null;
    reconnectTimer = setTimeout(initWhatsApp, 20000);
  }
}

let resolvedChannelJid = null;

async function getChannelJid(input) {
  if (!input) return null;
  const cleaned = input.trim();
  
  // If already numeric newsletter JID
  if (cleaned.endsWith('@newsletter') && /^\d+@newsletter$/.test(cleaned)) {
    resolvedChannelJid = cleaned;
    return cleaned;
  }
  if (/^\d+$/.test(cleaned)) {
    resolvedChannelJid = `${cleaned}@newsletter`;
    return resolvedChannelJid;
  }

  // Extract invite code from URL or string
  const match = cleaned.match(/(?:whatsapp\.com\/channel\/)?([0-9A-Za-z_-]{20,})/);
  const code = match ? match[1] : cleaned;

  if (waSocket && typeof waSocket.newsletterMetadata === 'function') {
    try {
      log(`🔍 Resolving channel code "${code}" via Baileys...`);
      const meta = await waSocket.newsletterMetadata('invite', code);
      if (meta && meta.id) {
        resolvedChannelJid = meta.id;
        const role = meta.viewer_metadata?.role || 'UNKNOWN';
        log(`📢 Channel found: "${meta.name || meta.thread_metadata?.name || 'Channel'}" | JID: ${meta.id} | Role: ${role}`);
        return resolvedChannelJid;
      }
    } catch (err) {
      log(`⚠️ Could not resolve channel "${code}": ${err.message}`);
    }
  }

  return cleaned.includes('@') ? cleaned : `${cleaned}@newsletter`;
}

// ─── Send to WhatsApp Channel ─────────────────────────────────────────────
async function sendToWhatsApp(caption) {
  if (!waSocket || waStatus !== 'connected') {
    return { success: false, reason: 'WhatsApp not connected' };
  }

  const settings = loadSettings();
  const channelId = settings.channelId;
  if (!channelId) return { success: false, reason: 'Channel ID set nahi hai' };

  try {
    const jid = await getChannelJid(channelId);
    log(`📤 Sending message to JID: ${jid}`);
    const sentMsg = await waSocket.sendMessage(jid, { text: caption });
    totalSentToday++;
    return { success: true, jid, msgId: sentMsg?.key?.id };
  } catch (err) {
    log(`❌ Send error: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─── BEU Notice Checker ────────────────────────────────────────────────────
async function checkAndBroadcast(forceAll = false) {
  if (isChecking) return { skipped: true };
  isChecking = true;
  lastCheckTime = new Date().toISOString();
  log('🔍 BEU check chal raha hai...');

  const settings = loadSettings();
  const localCache = loadNotices();
  let newCount = 0, sentCount = 0;

  try {
    const res = await axios.get(BEU_API_URL, { timeout: 20000 });
    const raw = Array.isArray(res.data) ? res.data : [];
    log(`📋 ${raw.length} notices BEU se mili`);

    for (const n of raw.slice(0, 15)) {
      const id = String(n.id);
      if (localCache[id] && !forceAll) continue;

      newCount++;
      const title = (n.board || 'BEU Notice').trim();
      const link = n.link ? `https://beu-bih.ac.in/backend/${encodeURIComponent(n.link.trim())}` : '';
      const date = n.noticedate || new Date().toISOString().split('T')[0];
      const isUrgent = n.isimportant === 1;
      const caption = buildCaption({ title, pdfLink: link, date, isUrgent });

      localCache[id] = { id, title, pdfLink: link, date, isUrgent, caption, dispatched: false, createdAt: new Date().toISOString() };
      saveNotices(localCache);

      if (settings.autoDispatch && settings.channelId) {
        const r = await sendToWhatsApp(caption);
        localCache[id].dispatched = r.success;
        localCache[id].dispatchedAt = new Date().toISOString();
        saveNotices(localCache);
        if (r.success) { sentCount++; log(`✅ Sent: ${title}`); }
        else log(`⚠️ Send failed: ${r.reason}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    log(`✅ Check done — ${newCount} new, ${sentCount} sent`);
    return { success: true, newCount, sentCount };

  } catch (err) {
    log(`❌ BEU error: ${err.message}`);
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
    pdfLink ? `\n📄 *Download PDF:*\n👉 ${pdfLink}` : '',
    '\n━━━━━━━━━━━━━━━━━━',
    '#BEU #BiharEngineering #Notice'
  ].filter(Boolean).join('\n');
}

// ─── Cron ──────────────────────────────────────────────────────────────────
cron.schedule(`*/${CHECK_INTERVAL} * * * *`, () => {
  log(`⏰ Auto check...`);
  checkAndBroadcast();
});
log(`✅ Cron scheduled: har ${CHECK_INTERVAL} minute`);

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => {
  const s = loadSettings();
  const n = Object.values(loadNotices()).filter(x => x.id);
  res.json({
    waStatus, hasQr: !!waQrDataUrl, lastCheckTime, isChecking,
    totalSentToday, autoDispatch: s.autoDispatch,
    channelId: s.channelId ? '✓ Set' : '✗ Not set',
    totalNotices: n.length,
    sentNotices: n.filter(x => x.dispatched).length,
    pendingNotices: n.filter(x => !x.dispatched).length,
    checkIntervalMins: CHECK_INTERVAL
  });
});

app.get('/api/qr', (req, res) => {
  if (waQrDataUrl) res.json({ hasQr: true, qrDataUrl: waQrDataUrl });
  else res.json({ hasQr: false, waStatus });
});

app.get('/api/notices', (req, res) => {
  const list = Object.values(loadNotices())
    .filter(n => n.id)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
  res.json({ success: true, count: list.length, notices: list });
});

app.post('/api/sync', async (req, res) => {
  const result = await checkAndBroadcast(req.body?.forceAll === true);
  res.json(result);
});

app.post('/api/send-custom', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });
  const result = await sendToWhatsApp(message);
  res.json(result);
});

app.get('/api/channel/info', async (req, res) => {
  if (!waSocket || waStatus !== 'connected') {
    return res.json({ connected: false, error: 'WhatsApp not connected' });
  }
  const settings = loadSettings();
  const rawId = settings.channelId || '';
  const match = rawId.match(/(?:whatsapp\.com\/channel\/)?([0-9A-Za-z_-]{20,})/);
  const code = match ? match[1] : rawId;
  try {
    const meta = await waSocket.newsletterMetadata('invite', code);
    res.json({ success: true, rawId, code, meta });
  } catch (err) {
    res.json({ success: false, rawId, code, error: err.message });
  }
});

app.get('/api/settings', (req, res) => res.json(loadSettings()));

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
  res.json({ success: true, message: 'WhatsApp start ho raha hai — QR aane ka wait karo' });
});

app.post('/api/wa/disconnect', async (req, res) => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (waSocket) { try { await waSocket.logout(); } catch {} waSocket = null; }
  waStatus = 'disconnected';
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 Server: http://localhost:${PORT}`);
  log(`📡 BEU auto-check: har ${CHECK_INTERVAL} min`);
});

// Connect MongoDB then start WhatsApp
async function start() {
  if (MONGODB_URI) {
    try {
      log('🍃 MongoDB connect ho raha hai...');
      mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await mongoClient.connect();
      mongoDb = mongoClient.db('beu-notifier');
      log('✅ MongoDB connected! Session persistent rahegi.');
    } catch (err) {
      log(`⚠️ MongoDB connect failed: ${err.message} — file session use ho rahi hai`);
      mongoDb = null;
    }
  } else {
    log('ℹ️ MONGODB_URI nahi mila — file session use ho rahi hai');
  }

  // Auto-connect WhatsApp
  setTimeout(() => {
    const hasFileSession = fs.existsSync(AUTH_FOLDER) && fs.readdirSync(AUTH_FOLDER).length > 0;
    if (mongoDb || hasFileSession) {
      log('🔄 Session mili — WhatsApp auto-connect...');
      initWhatsApp();
    } else {
      log('ℹ️ Dashboard se WhatsApp connect karein');
    }
  }, 2000);
}

start();
