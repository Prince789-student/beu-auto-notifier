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
const {
  generateNoticeImage,
  generateResultPdf,
  downloadNoticePdf,
  buildCaption: buildNoticeCaption,
  MEDIA_DIR
} = require('./noticeImageService');

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

// Enable CORS for dashboard access from any client/origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || '';

// BEU Endpoints
const BEU_API_URL = process.env.BEU_API_URL || 'https://beu-bih.ac.in/backend/v1/notice/get-notice-board';
const RESULT_API_URL = process.env.RESULT_API_URL || 'https://beu-bih.ac.in/backend/v1/result/sem-get';
const ROUTINE_API_URL = process.env.ROUTINE_API_URL || 'https://beu-bih.ac.in/backend/v1/notice/get-programme-rt-notice';

const DATA_FILE = path.join(__dirname, 'data', 'notices.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MINUTES || '2');

// Default Apna College Bihar Newsletter JID
const DEFAULT_CHANNEL_JID = '120363404823253263@newsletter';
const DEFAULT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbC6FsH3wtb5UEDvrW0a';

// MongoDB
let mongoClient = null;
let mongoDb = null;

// ─── Ensure dirs ───────────────────────────────────────────────────────────
[path.join(__dirname, 'data'), AUTH_FOLDER, MEDIA_DIR, path.join(__dirname, 'public', 'vendor')].forEach(d => {
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
let resolvedChannelJid = DEFAULT_CHANNEL_JID;

// ─── Helpers ───────────────────────────────────────────────────────────────
function loadNotices() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveNotices(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log(`⚠️ Notices save error: ${err.message}`);
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        autoDispatch: s.autoDispatch !== undefined ? s.autoDispatch : (process.env.AUTO_DISPATCH !== 'false'),
        channelId: s.channelId !== undefined ? s.channelId : (process.env.WHATSAPP_CHANNEL_ID || DEFAULT_CHANNEL_JID),
        channelLink: s.channelLink !== undefined ? s.channelLink : (process.env.WHATSAPP_CHANNEL_LINK || DEFAULT_CHANNEL_LINK),
        sendImage: s.sendImage !== undefined ? s.sendImage : (process.env.AUTO_SEND_IMAGE !== 'false'),
        sendPdf: s.sendPdf !== undefined ? s.sendPdf : true,
        dispatchMode: s.dispatchMode || 'pdf' // 'pdf' | 'both' | 'image'
      };
    }
  } catch {}
  return {
    autoDispatch: process.env.AUTO_DISPATCH !== 'false',
    channelId: process.env.WHATSAPP_CHANNEL_ID || DEFAULT_CHANNEL_JID,
    channelLink: process.env.WHATSAPP_CHANNEL_LINK || DEFAULT_CHANNEL_LINK,
    sendImage: process.env.AUTO_SEND_IMAGE !== 'false',
    sendPdf: true,
    dispatchMode: 'pdf'
  };
}

function saveSettings(data) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log(`⚠️ Settings save error: ${err.message}`);
  }
}

function log(msg) {
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

function resolveBeuLink(rawLink) {
  if (!rawLink || typeof rawLink !== 'string') return '';
  const trimmed = rawLink.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://beu-bih.ac.in/backend/${encodeURIComponent(trimmed)}`;
}

// ─── WhatsApp via Baileys ─────────────────────────────────────────────────
async function initWhatsApp() {
  if (waStatus === 'connecting' || waStatus === 'connected') return;

  log('📱 WhatsApp (Baileys) initialize ho raha hai...');
  waStatus = 'connecting';

  try {
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
      logger: pino({ level: 'silent' }),
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
      if (qr) {
        log('📷 QR code ready — dashboard pe scan karein!');
        waStatus = 'qr_ready';
        try {
          waQrDataUrl = await qrcode.toDataURL(qr);
        } catch (e) { log('QR generate error: ' + e.message); }

        try {
          qrcode.toString(qr, { type: 'terminal', small: true }, (err, terminalQr) => {
            if (!err && terminalQr) console.log('\n' + terminalQr + '\n');
          });
        } catch {}
      }

      if (connection === 'open') {
        log('✅ WhatsApp connected!');
        waStatus = 'connected';
        waQrDataUrl = null;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        // Pre-resolve Channel JID
        const s = loadSettings();
        if (s.channelId) {
          getChannelJid(s.channelId).catch(() => {});
        }

        // Trigger immediate check to send any pending or new notices/results!
        setTimeout(() => {
          log('🚀 WhatsApp ready — checking for new or pending notices & results...');
          checkAndBroadcast();
        }, 3000);
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

async function getChannelJid(input) {
  const current = (input || '').trim();
  if (!current) return resolvedChannelJid;

  // If already numeric newsletter JID
  if (current.endsWith('@newsletter') && /^\d+@newsletter$/.test(current)) {
    resolvedChannelJid = current;
    return current;
  }
  if (/^\d+$/.test(current)) {
    resolvedChannelJid = `${current}@newsletter`;
    return resolvedChannelJid;
  }

  // Extract invite code from URL or string
  const match = current.match(/(?:whatsapp\.com\/channel\/)?([0-9A-Za-z_-]{20,})/);
  const code = match ? match[1] : current;

  if (waSocket && typeof waSocket.newsletterMetadata === 'function') {
    try {
      log(`🔍 Resolving channel code "${code}" via Baileys...`);
      const meta = await waSocket.newsletterMetadata('invite', code);
      if (meta && meta.id) {
        resolvedChannelJid = meta.id;
        const role = meta.viewer_metadata?.role || 'UNKNOWN';
        log(`📢 Channel found: "${meta.thread_metadata?.name?.text || meta.name || 'Channel'}" | JID: ${meta.id} | Role: ${role}`);
        return resolvedChannelJid;
      }
    } catch (err) {
      log(`⚠️ Could not resolve channel "${code}": ${err.message}`);
    }
  }

  return resolvedChannelJid || (current.includes('@') ? current : `${current}@newsletter`);
}

// ─── Send to WhatsApp Channel (PDF Document & Image Support) ──────────────
async function sendToWhatsApp(caption, options = {}) {
  if (!waSocket || waStatus !== 'connected') {
    return { success: false, reason: `WhatsApp not connected (status: ${waStatus})` };
  }

  const settings = loadSettings();
  const channelId = settings.channelId;
  if (!channelId) return { success: false, reason: 'Channel ID set nahi hai' };

  // Options can be string (legacy imagePath) or object
  let imagePath = null;
  let pdfPath = null;
  let fileName = null;

  if (typeof options === 'string') {
    imagePath = options;
  } else if (options && typeof options === 'object') {
    imagePath = options.imagePath || null;
    pdfPath = options.pdfPath || null;
    fileName = options.fileName || null;
  }

  try {
    const jid = await getChannelJid(channelId);
    log(`📤 Sending to Channel JID: ${jid} | PDF: ${pdfPath ? 'YES' : 'NO'} | Image: ${imagePath ? 'YES' : 'NO'}`);

    let sentMsg = null;
    let hasSentPdf = false;
    let hasSentImage = false;

    const shouldSendPdf = settings.sendPdf !== false && pdfPath && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 500;
    const shouldSendImage = settings.sendImage !== false && imagePath && fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000;
    const dispatchMode = settings.dispatchMode || 'pdf'; // 'pdf' | 'both' | 'image'

    // Priority 1: Send Original PDF Document directly into WhatsApp Channel!
    if (shouldSendPdf && dispatchMode !== 'image') {
      try {
        const pdfBuffer = fs.readFileSync(pdfPath);
        const cleanName = (fileName || path.basename(pdfPath).replace(/^notice_\d+_?/, '')).replace(/[^a-zA-Z0-9._-]/g, '_');
        const docFileName = cleanName.endsWith('.pdf') ? cleanName : `${cleanName}.pdf`;

        log(`📄 Dispatching PDF Document "${docFileName}" to WhatsApp Channel...`);
        sentMsg = await waSocket.sendMessage(jid, {
          document: pdfBuffer,
          mimetype: 'application/pdf',
          fileName: docFileName,
          caption: caption
        });
        hasSentPdf = true;
        log(`✅ PDF Document successfully delivered to ${jid}!`);
      } catch (pdfErr) {
        log(`⚠️ Sending as PDF document failed (${pdfErr.message}) — attempting fallback...`);
      }
    }

    // Priority 2: If dispatchMode is 'both' or PDF failed, send Image message
    if ((dispatchMode === 'both' || !sentMsg) && shouldSendImage) {
      try {
        const imageBuffer = fs.readFileSync(imagePath);
        const imgCaption = hasSentPdf ? '🖼️ *Official Announcement Visual*' : caption;

        const imgMsg = await waSocket.sendMessage(jid, {
          image: imageBuffer,
          caption: imgCaption
        });
        hasSentImage = true;
        if (!sentMsg) sentMsg = imgMsg;
        log(`✅ Image banner message sent to ${jid}`);
      } catch (imgErr) {
        log(`⚠️ Sending as image failed (${imgErr.message})`);
      }
    }

    // Priority 3: Fallback to text-only send if neither PDF nor Image could be sent
    if (!sentMsg) {
      sentMsg = await waSocket.sendMessage(jid, { text: caption });
      log(`✅ Text message successfully sent to ${jid}`);
    }

    totalSentToday++;
    return {
      success: true,
      jid,
      msgId: sentMsg?.key?.id,
      hasPdf: hasSentPdf,
      hasImage: hasSentImage
    };

  } catch (err) {
    log(`❌ Send error: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─── Multi-Source BEU Checker (Notices + Results on result-one) ───────────
async function checkAndBroadcast(forceAll = false) {
  if (isChecking) return { skipped: true, reason: 'Already in progress' };
  isChecking = true;
  lastCheckTime = new Date().toISOString();
  log('🔍 BEU multi-source scan shuru: Notice Board + result-one (Results)...');

  const settings = loadSettings();
  const localCache = loadNotices();
  let newCount = 0, sentCount = 0;

  try {
    const allItemsToProcess = [];

    // 1. Fetch Notice Board
    try {
      const resNotices = await axios.get(BEU_API_URL, { timeout: 20000 });
      const rawNotices = Array.isArray(resNotices.data) ? resNotices.data : [];
      log(`📋 [Notice Board] ${rawNotices.length} notices mili`);

      // Top 15 notices
      for (const n of rawNotices.slice(0, 15)) {
        allItemsToProcess.push({
          id: String(n.id),
          type: 'notice',
          isResult: false,
          title: (n.board || 'BEU Notice').trim(),
          pdfLink: resolveBeuLink(n.link),
          date: n.noticedate || new Date().toISOString().split('T')[0],
          isUrgent: n.isimportant === 1
        });
      }
    } catch (err) {
      log(`⚠️ Notice Board fetch error: ${err.message}`);
    }

    // 2. Fetch Exam Routine / Programme Notices
    try {
      const resRoutines = await axios.get(ROUTINE_API_URL, { timeout: 15000 });
      const rawRoutines = Array.isArray(resRoutines.data) ? resRoutines.data : [];
      log(`📅 [Exam Routines] ${rawRoutines.length} routine notices mili`);

      for (const r of rawRoutines.slice(0, 10)) {
        const id = `routine_${r.id}`;
        allItemsToProcess.push({
          id,
          type: 'routine',
          isResult: false,
          title: (r.board || 'BEU Examination Programme').trim(),
          pdfLink: resolveBeuLink(r.link),
          date: r.noticedate || new Date().toISOString().split('T')[0],
          isUrgent: r.isimportant === 1
        });
      }
    } catch (err) {
      log(`⚠️ Exam Routines fetch error: ${err.message}`);
    }

    // 3. Fetch Declared Results from https://beu-bih.ac.in/result-one
    try {
      const resResults = await axios.get(RESULT_API_URL, { timeout: 20000 });
      const rawCourses = Array.isArray(resResults.data) ? resResults.data : [];
      let totalExams = 0;

      rawCourses.forEach(course => {
        const courseName = course.courseName || 'BEU Course';
        const exams = Array.isArray(course.exams) ? course.exams : [];
        totalExams += exams.length;

        // Top 5 most recent exams per course
        for (const e of exams.slice(0, 5)) {
          const id = `result_${e.id}`;
          allItemsToProcess.push({
            id,
            type: 'result',
            isResult: true,
            title: `Result Declared: ${e.examName || 'BEU Examination'}`,
            examName: e.examName,
            courseName: courseName,
            session: e.session,
            batchYear: e.batchYear,
            semId: e.semId,
            examHeld: e.examHeld,
            examId: e.examId,
            pdfLink: 'https://beu-bih.ac.in/result-one',
            date: e.publishDate || e.createdAt || new Date().toISOString().split('T')[0],
            isUrgent: false
          });
        }
      });
      log(`🎓 [result-one] ${totalExams} declared exams across ${rawCourses.length} courses scanned`);
    } catch (err) {
      log(`⚠️ Results fetch error: ${err.message}`);
    }

    // Process all scanned items in reverse (oldest to newest)
    const itemsToEvaluate = allItemsToProcess.reverse();

    for (const item of itemsToEvaluate) {
      const id = String(item.id);
      const cached = localCache[id];

      // If already dispatched, skip unless forceAll is requested
      if (cached && cached.dispatched && !forceAll) {
        continue;
      }

      // Skip ancient items (> 14 days old) on fresh discovery so we don't spam
      const itemAgeDays = (Date.now() - new Date(item.date).getTime()) / (1000 * 60 * 60 * 24);
      if (itemAgeDays > 14 && !forceAll && !cached) {
        localCache[id] = {
          ...item,
          dispatched: true,
          archived: true,
          createdAt: new Date().toISOString()
        };
        saveNotices(localCache);
        continue;
      }

      newCount++;

      // 1. Build rich caption with official links + user's WhatsApp channel link
      const caption = buildNoticeCaption({
        title: item.title,
        pdfLink: item.pdfLink,
        date: item.date,
        isUrgent: item.isUrgent,
        channelLink: settings.channelLink,
        isResult: item.isResult,
        course: item.courseName,
        session: item.session,
        examHeld: item.examHeld
      });

      // 2. Generate/download assets (PDF & Image)
      let mediaAsset = {
        success: !!(cached?.pdfPath && fs.existsSync(cached.pdfPath)),
        pdfPath: cached?.pdfPath || null,
        imagePath: cached?.imagePath || null,
        imageUrl: cached?.imageUrl || null,
        pdfUrl: cached?.pdfUrl || null
      };

      if (!mediaAsset.success || !mediaAsset.pdfPath || !fs.existsSync(mediaAsset.pdfPath)) {
        try {
          log(`📦 Notice/Result #${id} ke liye PDF & Image ready ho raha hai...`);
          const genRes = await generateNoticeImage(item);
          if (genRes.success) {
            mediaAsset = {
              success: true,
              pdfPath: genRes.pdfPath || null,
              imagePath: genRes.imagePath || null,
              imageUrl: genRes.relativeUrl || genRes.relativeImageUrl || null,
              pdfUrl: genRes.relativePdfUrl || null
            };
          }
        } catch (mediaErr) {
          log(`⚠️ Asset generation error for #${id}: ${mediaErr.message}`);
        }
      }

      localCache[id] = {
        ...item,
        caption,
        pdfPath: mediaAsset.pdfPath || cached?.pdfPath || null,
        imagePath: mediaAsset.imagePath || cached?.imagePath || null,
        imageUrl: mediaAsset.imageUrl || cached?.imageUrl || null,
        pdfUrl: mediaAsset.pdfUrl || cached?.pdfUrl || null,
        dispatched: cached?.dispatched || false,
        createdAt: cached?.createdAt || new Date().toISOString()
      };
      saveNotices(localCache);

      // 3. Dispatch to WhatsApp channel
      if (settings.autoDispatch && settings.channelId) {
        if (!waSocket || waStatus !== 'connected') {
          log(`⏳ WhatsApp connect nahi hai — Item #${id} queue mein rahegi`);
          continue;
        }

        const fileName = `${item.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
        const r = await sendToWhatsApp(caption, {
          pdfPath: mediaAsset.pdfPath,
          imagePath: mediaAsset.imagePath,
          fileName,
          dispatchMode: settings.dispatchMode || 'pdf'
        });

        localCache[id].dispatched = r.success;
        localCache[id].dispatchedAt = new Date().toISOString();
        localCache[id].sentWithPdf = !!r.hasPdf;
        localCache[id].sentWithImage = !!r.hasImage;
        if (!r.success) {
          localCache[id].lastError = r.reason;
        }
        saveNotices(localCache);

        if (r.success) {
          sentCount++;
          log(`✅ Sent to WA: #${id} - ${item.title} (PDF: ${r.hasPdf ? 'YES' : 'NO'}, Image: ${r.hasImage ? 'YES' : 'NO'})`);
        } else {
          log(`⚠️ Send failed for #${id}: ${r.reason}`);
        }
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    log(`✅ Multi-source scan done — ${newCount} processed, ${sentCount} sent to WhatsApp`);
    return { success: true, newCount, sentCount };

  } catch (err) {
    log(`❌ Scan error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    isChecking = false;
  }
}

// ─── Cron ──────────────────────────────────────────────────────────────────
cron.schedule(`*/${CHECK_INTERVAL} * * * *`, () => {
  log(`⏰ Auto check running (interval: ${CHECK_INTERVAL}m)...`);
  checkAndBroadcast();
});
log(`✅ Cron scheduled: har ${CHECK_INTERVAL} minute`);

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, status: 'online', time: new Date().toISOString() }));

app.get('/api/status', (req, res) => {
  const s = loadSettings();
  const n = Object.values(loadNotices()).filter(x => x.id);
  const resultsCount = n.filter(x => x.isResult || String(x.id).startsWith('result_')).length;
  const noticesCount = n.filter(x => !x.isResult && !String(x.id).startsWith('result_')).length;

  res.json({
    ok: true,
    serverOnline: true,
    waStatus,
    hasQr: !!waQrDataUrl,
    lastCheckTime,
    isChecking,
    totalSentToday,
    autoDispatch: s.autoDispatch,
    sendPdf: s.sendPdf !== false,
    sendImage: s.sendImage !== false,
    dispatchMode: s.dispatchMode || 'pdf',
    channelId: s.channelId ? '✓ Set' : '✗ Not set',
    totalNotices: n.length,
    resultsCount,
    noticesCount,
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
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 60);
  res.json({ success: true, count: list.length, notices: list });
});

app.post('/api/sync', async (req, res) => {
  const result = await checkAndBroadcast(req.body?.forceAll === true);
  res.json(result);
});

app.post('/api/send-custom', async (req, res) => {
  const { message, title, pdfLink, imagePath } = req.body || {};
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });

  const settings = loadSettings();
  let fullMessage = message;

  if (pdfLink && !fullMessage.includes(pdfLink)) {
    fullMessage += `\n\n📄 *Notice Link:*\n👉 ${pdfLink}`;
  }
  if (settings.channelLink && !fullMessage.includes(settings.channelLink)) {
    fullMessage += `\n\n📢 *WhatsApp Channel:*\n👉 ${settings.channelLink}`;
  }

  const result = await sendToWhatsApp(fullMessage, { imagePath: imagePath || null });
  res.json(result);
});

// Send single notice/result to WhatsApp Channel with PDF
app.post('/api/notices/:id/send', async (req, res) => {
  const { id } = req.params;
  const localCache = loadNotices();
  const notice = localCache[id];

  if (!notice) {
    return res.status(404).json({ success: false, error: 'Notice not found' });
  }

  const settings = loadSettings();

  // Ensure PDF and Image exist
  let pdfPath = notice.pdfPath;
  let imagePath = notice.imagePath;

  if (!pdfPath || !fs.existsSync(pdfPath) || !imagePath || !fs.existsSync(imagePath)) {
    log(`🖼️ Item #${id} ke liye assets generate ho rahe hain...`);
    const genRes = await generateNoticeImage(notice);
    if (genRes.success) {
      pdfPath = genRes.pdfPath || pdfPath;
      imagePath = genRes.imagePath || imagePath;
      localCache[id].pdfPath = pdfPath;
      localCache[id].imagePath = imagePath;
      localCache[id].imageUrl = genRes.relativeUrl || genRes.relativeImageUrl;
      localCache[id].pdfUrl = genRes.relativePdfUrl;
      saveNotices(localCache);
    }
  }

  // Build latest caption
  const caption = buildNoticeCaption({
    title: notice.title,
    pdfLink: notice.pdfLink,
    date: notice.date,
    isUrgent: notice.isUrgent,
    channelLink: settings.channelLink,
    isResult: notice.isResult,
    course: notice.courseName,
    session: notice.session,
    examHeld: notice.examHeld
  });

  const fileName = `${notice.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  const result = await sendToWhatsApp(caption, {
    pdfPath,
    imagePath,
    fileName,
    dispatchMode: settings.dispatchMode || 'pdf'
  });

  if (result.success) {
    localCache[id].dispatched = true;
    localCache[id].dispatchedAt = new Date().toISOString();
    localCache[id].sentWithPdf = !!result.hasPdf;
    localCache[id].sentWithImage = !!result.hasImage;
    localCache[id].caption = caption;
    saveNotices(localCache);
  }

  res.json({ success: result.success, result, notice: localCache[id] });
});

// Re-generate image / PDF for a notice
app.post('/api/notices/:id/generate-image', async (req, res) => {
  const { id } = req.params;
  const localCache = loadNotices();
  const notice = localCache[id];

  if (!notice) {
    return res.status(404).json({ success: false, error: 'Notice not found' });
  }

  try {
    log(`🖼️ Manual generation request for #${id}...`);
    const genRes = await generateNoticeImage(notice);
    if (genRes.success) {
      localCache[id].imagePath = genRes.imagePath;
      localCache[id].pdfPath = genRes.pdfPath;
      localCache[id].imageUrl = genRes.relativeUrl || genRes.relativeImageUrl;
      localCache[id].pdfUrl = genRes.relativePdfUrl;
      saveNotices(localCache);
      return res.json({
        success: true,
        imageUrl: localCache[id].imageUrl,
        pdfUrl: localCache[id].pdfUrl
      });
    } else {
      return res.status(500).json({ success: false, error: genRes.error || 'Failed to generate asset' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/channel/info', async (req, res) => {
  if (!waSocket || waStatus !== 'connected') {
    return res.json({ connected: false, error: 'WhatsApp not connected' });
  }
  const settings = loadSettings();
  const rawId = settings.channelId || DEFAULT_CHANNEL_JID;
  try {
    const jid = await getChannelJid(rawId);
    const meta = await waSocket.newsletterMetadata('jid', jid);
    res.json({ success: true, rawId, jid, meta });
  } catch (err) {
    res.json({ success: false, rawId, error: err.message });
  }
});

app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const { autoDispatch, channelId, channelLink, sendImage, sendPdf, dispatchMode } = req.body || {};
  if (typeof autoDispatch === 'boolean') current.autoDispatch = autoDispatch;
  if (channelId !== undefined) current.channelId = channelId.trim();
  if (channelLink !== undefined) current.channelLink = channelLink.trim();
  if (typeof sendImage === 'boolean') current.sendImage = sendImage;
  if (typeof sendPdf === 'boolean') current.sendPdf = sendPdf;
  if (dispatchMode !== undefined) current.dispatchMode = dispatchMode;
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
  waQrDataUrl = null;
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  if (mongoDb) {
    try { await mongoDb.collection('wa_session').deleteMany({}); } catch {}
  }
  res.json({ success: true, message: 'Disconnected' });
});

app.post('/api/wa/reset-scanner', async (req, res) => {
  log('🔄 Scanner reset initiated — session files delete karke naya QR generate ho raha hai...');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (waSocket) {
    try { await waSocket.logout(); } catch (e) {
      try { waSocket.end(); } catch {}
    }
    waSocket = null;
  }
  waStatus = 'disconnected';
  waQrDataUrl = null;

  try {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  } catch (err) {
    log('⚠️ AUTH_FOLDER clear warning: ' + err.message);
  }

  if (mongoDb) {
    try {
      await mongoDb.collection('wa_session').deleteMany({});
      log('🍃 MongoDB wa_session cleared');
    } catch (e) {
      log('⚠️ MongoDB clear error: ' + e.message);
    }
  }

  setTimeout(() => {
    initWhatsApp();
  }, 1000);

  res.json({ success: true, message: 'Purana session hata diya gaya hai. Naya QR code ban raha hai...' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 Server: http://localhost:${PORT}`);
  log(`📡 BEU Monitoring Active: Notice Board + result-one (Results) + Programmes`);
  log(`⏰ Auto check interval: har ${CHECK_INTERVAL} min`);
});

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

  // Auto-connect WhatsApp if session exists
  setTimeout(() => {
    const hasFileSession = fs.existsSync(AUTH_FOLDER) && fs.readdirSync(AUTH_FOLDER).length > 0;
    if (mongoDb || hasFileSession) {
      log('🔄 Session mili — WhatsApp auto-connect...');
      initWhatsApp();
    } else {
      log('ℹ️ Dashboard se WhatsApp connect karein');
    }
  }, 1500);
}

start();
