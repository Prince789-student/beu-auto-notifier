const puppeteer = require('puppeteer-core');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, 'public', 'media');
const VENDOR_DIR = path.join(__dirname, 'public', 'vendor');

// Ensure directories exist
[MEDIA_DIR, VENDOR_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Axios client with SSL bypass and realistic headers for BEU
const httpClient = axios.create({
  timeout: 35000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,image/*,*/*;q=0.8'
  }
});

/**
 * Locate Chrome or Edge executable on the system
 */
function getChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let activeBrowser = null;
let browserTimer = null;

async function getBrowser() {
  if (activeBrowser && activeBrowser.connected) {
    if (browserTimer) clearTimeout(browserTimer);
    browserTimer = setTimeout(() => closeBrowser(), 60000); // Auto-close after 60s idle
    return activeBrowser;
  }

  const chromePath = getChromePath();
  if (!chromePath) {
    throw new Error('Chrome/Edge executable not found on system. Set CHROME_PATH in .env');
  }

  activeBrowser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions'
    ]
  });

  browserTimer = setTimeout(() => closeBrowser(), 60000);
  return activeBrowser;
}

async function closeBrowser() {
  if (activeBrowser) {
    try { await activeBrowser.close(); } catch {}
    activeBrowser = null;
  }
  if (browserTimer) {
    clearTimeout(browserTimer);
    browserTimer = null;
  }
}

/**
 * Convert a PDF buffer into an image using local PDF.js in headless Chrome
 */
async function renderPdfToImage(pdfBuffer, outputPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });

    const pdfJsPath = path.join(VENDOR_DIR, 'pdf.min.js');
    const pdfWorkerPath = path.join(VENDOR_DIR, 'pdf.worker.min.js');

    // Read local script contents for offline injection
    const pdfJsCode = fs.existsSync(pdfJsPath)
      ? fs.readFileSync(pdfJsPath, 'utf8')
      : '';
    const pdfWorkerCode = fs.existsSync(pdfWorkerPath)
      ? fs.readFileSync(pdfWorkerPath, 'utf8')
      : '';

    const base64Data = pdfBuffer.toString('base64');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { background: #ffffff; display: flex; justify-content: center; align-items: flex-start; }
          #canvas { display: block; box-shadow: 0 4px 20px rgba(0,0,0,0.15); max-width: 100%; height: auto; }
        </style>
        <script>${pdfJsCode}</script>
      </head>
      <body>
        <canvas id="canvas"></canvas>
        <script>
          ${pdfWorkerCode ? `
            const workerBlob = new Blob([${JSON.stringify(pdfWorkerCode)}], { type: 'text/javascript' });
            pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
          ` : `
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          `}

          async function renderNotice(b64) {
            try {
              const raw = atob(b64);
              const uint8 = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) uint8[i] = raw.charCodeAt(i);

              const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
              const page = await pdf.getPage(1);
              // Scale 2.0 produces crystal clear, high-resolution document images
              const viewport = page.getViewport({ scale: 2.0 });
              const canvas = document.getElementById('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              const ctx = canvas.getContext('2d');
              await page.render({ canvasContext: ctx, viewport }).promise;
              window.rendered = true;
            } catch (err) {
              window.error = err.message || String(err);
            }
          }
        </script>
      </body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate((b64) => window.renderNotice(b64), base64Data);

    await page.waitForFunction(() => window.rendered || window.error, { timeout: 30000 });
    const err = await page.evaluate(() => window.error);
    if (err) throw new Error(`PDF.js render error: ${err}`);

    const canvas = await page.$('#canvas');
    if (!canvas) throw new Error('Canvas element not found');

    await canvas.screenshot({ path: outputPath, type: 'png' });
    return true;
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Fallback: Generate a crisp, modern official BEU Notice Banner Card
 */
async function generateAnnouncementBanner(notice, outputPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 675, deviceScaleFactor: 2 });

    const safeTitle = (notice.title || 'Official BEU Notification')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeDate = notice.date
      ? new Date(notice.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const isUrgent = notice.isUrgent === true || notice.isimportant === 1;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
          body {
            width: 1200px;
            height: 675px;
            background: linear-gradient(135deg, #090d16 0%, #0f172a 45%, #1e1b4b 100%);
            color: #ffffff;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 56px 64px;
            position: relative;
            overflow: hidden;
          }
          .glow {
            position: absolute;
            width: 500px;
            height: 500px;
            border-radius: 50%;
            filter: blur(120px);
            pointer-events: none;
          }
          .glow-1 { top: -100px; right: -100px; background: rgba(99, 102, 241, 0.28); }
          .glow-2 { bottom: -120px; left: -100px; background: rgba(239, 68, 68, 0.22); }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: relative;
            z-index: 10;
          }
          .brand {
            display: flex;
            align-items: center;
            gap: 16px;
          }
          .logo-badge {
            width: 56px;
            height: 56px;
            border-radius: 16px;
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            box-shadow: 0 10px 25px rgba(59, 130, 246, 0.4);
          }
          .brand-text h2 {
            font-size: 22px;
            font-weight: 900;
            letter-spacing: -0.5px;
            text-transform: uppercase;
            color: #ffffff;
          }
          .brand-text p {
            font-size: 12px;
            font-weight: 700;
            color: #93c5fd;
            letter-spacing: 2px;
            text-transform: uppercase;
          }
          .status-pill {
            padding: 10px 24px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 1px;
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(8px);
          }
          .pill-urgent { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border-color: rgba(239, 68, 68, 0.4); }
          .pill-normal { background: rgba(59, 130, 246, 0.2); color: #bfdbfe; border-color: rgba(59, 130, 246, 0.4); }
          .content {
            margin: auto 0;
            position: relative;
            z-index: 10;
          }
          .notice-meta {
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px;
            font-weight: 700;
            color: #f59e0b;
            background: rgba(245, 158, 11, 0.12);
            border: 1px solid rgba(245, 158, 11, 0.3);
            display: inline-block;
            padding: 6px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .notice-title {
            font-size: 40px;
            font-weight: 900;
            line-height: 1.25;
            letter-spacing: -1px;
            color: #ffffff;
            max-height: 200px;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 4;
            -webkit-box-orient: vertical;
          }
          .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-top: 24px;
            border-top: 1px solid rgba(255, 255, 255, 0.12);
            position: relative;
            z-index: 10;
          }
          .footer-info {
            display: flex;
            align-items: center;
            gap: 24px;
            font-size: 14px;
            color: #94a3b8;
            font-weight: 700;
          }
          .footer-info b { color: #f8fafc; }
          .footer-tag {
            font-size: 14px;
            font-weight: 800;
            color: #38bdf8;
            background: rgba(56, 189, 248, 0.12);
            padding: 8px 18px;
            border-radius: 12px;
            border: 1px solid rgba(56, 189, 248, 0.3);
          }
        </style>
      </head>
      <body>
        <div class="glow glow-1"></div>
        <div class="glow glow-2"></div>
        <div class="header">
          <div class="brand">
            <div class="logo-badge">🏛️</div>
            <div class="brand-text">
              <h2>Bihar Engineering University</h2>
              <p>Official Notification Alert</p>
            </div>
          </div>
          <div class="status-pill ${isUrgent ? 'pill-urgent' : 'pill-normal'}">
            <span>${isUrgent ? '🚨 URGENT NOTICE' : '🔔 OFFICIAL CIRCULAR'}</span>
          </div>
        </div>
        <div class="content">
          <div class="notice-meta">NOTICE #${notice.id || 'NEW'} &nbsp;|&nbsp; 🗓️ ${safeDate}</div>
          <h1 class="notice-title">${safeTitle}</h1>
        </div>
        <div class="footer">
          <div class="footer-info">
            <div>🏛️ <b>BEU Patna (Bihar)</b></div>
            <div>📱 <b>Live WhatsApp Broadcast</b></div>
          </div>
          <div class="footer-tag">📢 Apna College Bihar</div>
        </div>
      </body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outputPath, type: 'png' });
    return true;
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Main export: Downloads notice link and converts it to a local image.
 * Returns { success, imagePath, relativeUrl, error }
 */
async function generateNoticeImage(notice) {
  const rawId = String(notice.id || Date.now());
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const imageFilename = `notice_${safeId}.png`;
  const imagePath = path.join(MEDIA_DIR, imageFilename);
  const relativeUrl = `/media/${imageFilename}`;

  // If already rendered and valid, return cached image immediately
  if (fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000) {
    return { success: true, imagePath, relativeUrl, cached: true };
  }

  const pdfUrl = (notice.pdfLink || notice.link || '').trim();

  // Try 1: Download file and convert PDF or save image
  if (pdfUrl) {
    try {
      console.log(`[Notice Media] Downloading notice from: ${pdfUrl}`);
      const res = await httpClient.get(pdfUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(res.data);
      const contentType = (res.headers['content-type'] || '').toLowerCase();

      // If server returned an image directly
      if (contentType.includes('image') || pdfUrl.match(/\.(png|jpe?g|webp|gif)$/i)) {
        fs.writeFileSync(imagePath, buffer);
        console.log(`[Notice Media] Saved direct image: ${imagePath}`);
        return { success: true, imagePath, relativeUrl };
      }

      // If server returned PDF
      const pdfPath = path.join(MEDIA_DIR, `notice_${safeId}.pdf`);
      fs.writeFileSync(pdfPath, buffer);

      console.log(`[Notice Media] Rendering PDF to image using PDF.js (${buffer.length} bytes)...`);
      await renderPdfToImage(buffer, imagePath);

      if (fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000) {
        console.log(`[Notice Media] ✅ PDF rendered successfully: ${imagePath}`);
        return { success: true, imagePath, relativeUrl };
      }
    } catch (err) {
      console.warn(`[Notice Media] PDF download/render warning (${err.message}). Generating announcement card...`);
    }
  }

  // Try 2: Generate beautiful announcement card fallback
  try {
    console.log(`[Notice Media] Generating announcement banner card for Notice #${safeId}...`);
    await generateAnnouncementBanner(notice, imagePath);
    if (fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000) {
      console.log(`[Notice Media] ✅ Announcement card ready: ${imagePath}`);
      return { success: true, imagePath, relativeUrl, isBanner: true };
    }
  } catch (err) {
    console.error(`[Notice Media] ❌ Banner generation failed: ${err.message}`);
  }

  return { success: false, imagePath: null, error: 'Could not generate image' };
}

/**
 * Builds the WhatsApp caption with:
 * 1. Title and date
 * 2. Original Notice / PDF Download link
 * 3. User's WhatsApp Channel Link
 */
function buildCaption({ title, pdfLink, date, isUrgent, channelLink }) {
  const dateStr = date
    ? new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const lines = [
    isUrgent ? '🚨 *URGENT BEU NOTICE*' : '🔔 *New BEU Notice*',
    '',
    `📌 *${(title || 'BEU Notice').trim()}*`,
    `🗓️ *Date:* ${dateStr}`,
    ''
  ];

  if (pdfLink && pdfLink.trim()) {
    lines.push('📄 *Download Official Notice PDF:*');
    lines.push(`👉 ${pdfLink.trim()}`);
    lines.push('');
  }

  if (channelLink && channelLink.trim()) {
    lines.push('📢 *Join WhatsApp Channel for Updates:*');
    lines.push(`👉 ${channelLink.trim()}`);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🎓 *Apna College Bihar* | BEU Patna');
  lines.push('#BEU #BiharEngineering #Notice #Exam #Semester');

  return lines.join('\n');
}

module.exports = {
  generateNoticeImage,
  buildCaption,
  renderPdfToImage,
  generateAnnouncementBanner,
  getChromePath,
  closeBrowser,
  MEDIA_DIR
};
