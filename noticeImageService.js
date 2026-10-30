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
    const isResult = notice.isResult === true;

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
          .pill-result { background: rgba(16, 185, 129, 0.25); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.5); }
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
            font-size: 38px;
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
              <p>${isResult ? 'Official Result Declaration' : 'Official Notification Alert'}</p>
            </div>
          </div>
          <div class="status-pill ${isResult ? 'pill-result' : isUrgent ? 'pill-urgent' : 'pill-normal'}">
            <span>${isResult ? '🎓 RESULT DECLARED' : isUrgent ? '🚨 URGENT NOTICE' : '🔔 OFFICIAL CIRCULAR'}</span>
          </div>
        </div>
        <div class="content">
          <div class="notice-meta">ID: #${notice.id || 'NEW'} &nbsp;|&nbsp; 🗓️ ${safeDate}</div>
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
 * Downloads notice PDF from BEU server and saves to local media folder
 */
async function downloadNoticePdf(pdfUrl, safeId) {
  const pdfFilename = `notice_${safeId}.pdf`;
  const pdfPath = path.join(MEDIA_DIR, pdfFilename);
  const relativePdfUrl = `/media/${pdfFilename}`;

  if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000) {
    return { success: true, pdfPath, relativePdfUrl, cached: true };
  }

  try {
    console.log(`[Notice Media] Downloading PDF from: ${pdfUrl}`);
    const res = await httpClient.get(pdfUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    // Validate that it's actually a PDF or valid file
    if (buffer.length < 500) {
      throw new Error('Downloaded file is too small to be a valid PDF');
    }

    fs.writeFileSync(pdfPath, buffer);
    console.log(`[Notice Media] ✅ PDF saved successfully: ${pdfPath} (${buffer.length} bytes)`);
    return { success: true, pdfPath, relativePdfUrl, buffer, size: buffer.length };
  } catch (err) {
    console.warn(`[Notice Media] Download PDF error for #${safeId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Generates an official BEU Result Declaration Bulletin PDF for results declared on result-one
 */
async function generateResultPdf(exam) {
  const rawId = String(exam.id || Date.now());
  const cleanId = rawId.replace(/^result_/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const pdfFilename = `result_${cleanId}.pdf`;
  const imageFilename = `result_${cleanId}.png`;
  const pdfPath = path.join(MEDIA_DIR, pdfFilename);
  const imagePath = path.join(MEDIA_DIR, imageFilename);
  const relativePdfUrl = `/media/${pdfFilename}`;
  const relativeImageUrl = `/media/${imageFilename}`;

  if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000) {
    return {
      success: true,
      pdfPath,
      imagePath: fs.existsSync(imagePath) ? imagePath : null,
      relativePdfUrl,
      relativeImageUrl,
      cached: true
    };
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });

    const publishDateStr = exam.publishDate
      ? new Date(exam.publishDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    const examTitle = exam.examName || exam.title || 'BEU Examination Result';
    const course = exam.courseName || exam.course || 'B.Tech / Technical';
    const session = exam.session || 'Academic Session';
    const batchYear = exam.batchYear || '';
    const examHeld = exam.examHeld || 'Recent Exam';
    const semId = exam.semId || '-';
    const examId = exam.examId || 'BEU';

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
          body {
            width: 800px;
            margin: 0 auto;
            background: #ffffff;
            color: #0f172a;
            padding: 48px 44px;
          }
          .header {
            text-align: center;
            padding-bottom: 24px;
            border-bottom: 3px double #0284c7;
            margin-bottom: 28px;
          }
          .univ-name-en {
            font-size: 24px;
            font-weight: 900;
            color: #0369a1;
            letter-spacing: -0.5px;
            text-transform: uppercase;
          }
          .univ-name-hi {
            font-size: 17px;
            font-weight: 700;
            color: #475569;
            margin-top: 4px;
          }
          .univ-sub {
            font-size: 11px;
            font-weight: 600;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-top: 6px;
          }
          .badge-box {
            display: inline-block;
            background: #ecfdf5;
            color: #065f46;
            border: 1px solid #a7f3d0;
            font-weight: 800;
            font-size: 13px;
            padding: 6px 18px;
            border-radius: 999px;
            margin-top: 14px;
            letter-spacing: 0.5px;
            text-transform: uppercase;
          }
          .bulletin-title {
            font-size: 20px;
            font-weight: 800;
            color: #0f172a;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .details-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 26px;
            background: #f8fafc;
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid #e2e8f0;
          }
          .details-table td {
            padding: 13px 18px;
            border-bottom: 1px solid #e2e8f0;
            font-size: 14px;
          }
          .details-table tr:last-child td {
            border-bottom: none;
          }
          .details-table td.label {
            width: 32%;
            font-weight: 700;
            color: #475569;
            background: #f1f5f9;
          }
          .details-table td.value {
            font-weight: 800;
            color: #0f172a;
          }
          .highlight {
            color: #0369a1;
            font-size: 15px;
          }
          .instruction-card {
            background: #f0fdf4;
            border: 1px solid #86efac;
            border-radius: 12px;
            padding: 20px 22px;
            margin-bottom: 26px;
          }
          .inst-hd {
            font-weight: 800;
            color: #166534;
            font-size: 14px;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .inst-list {
            list-style: none;
            counter-reset: inst-counter;
          }
          .inst-list li {
            counter-increment: inst-counter;
            margin-bottom: 8px;
            font-size: 13px;
            color: #1e293b;
            display: flex;
            align-items: flex-start;
            gap: 8px;
            line-height: 1.4;
          }
          .inst-list li::before {
            content: counter(inst-counter);
            background: #22c55e;
            color: white;
            font-weight: 800;
            font-size: 11px;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 1px;
          }
          .link-box {
            background: #0284c7;
            color: white;
            border-radius: 10px;
            padding: 14px 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 26px;
          }
          .link-url {
            font-family: 'JetBrains Mono', monospace;
            font-size: 14px;
            font-weight: 700;
            word-break: break-all;
          }
          .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-top: 18px;
            border-top: 1px solid #e2e8f0;
            font-size: 12px;
            color: #64748b;
          }
          .footer b { color: #0f172a; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="univ-name-en">Bihar Engineering University, Patna</div>
          <div class="univ-name-hi">बिहार अभियंत्रण विश्वविद्यालय, पटना</div>
          <div class="univ-sub">Official Examination Result Declaration Bulletin</div>
          <div class="badge-box">🎓 Official Result Published</div>
        </div>

        <div class="bulletin-title">
          <span>📢</span>
          <span>${examTitle}</span>
        </div>

        <table class="details-table">
          <tr>
            <td class="label">Course Name</td>
            <td class="value highlight">${course}</td>
          </tr>
          <tr>
            <td class="label">Examination</td>
            <td class="value">${examTitle}</td>
          </tr>
          <tr>
            <td class="label">Academic Session</td>
            <td class="value">${session} ${batchYear ? `(Batch: ${batchYear})` : ''}</td>
          </tr>
          <tr>
            <td class="label">Examination Held</td>
            <td class="value">${examHeld}</td>
          </tr>
          <tr>
            <td class="label">Publication Date</td>
            <td class="value">${publishDateStr}</td>
          </tr>
          <tr>
            <td class="label">Semester / Exam ID</td>
            <td class="value">Semester ${semId} &nbsp;|&nbsp; ID: ${examId}</td>
          </tr>
        </table>

        <div class="instruction-card">
          <div class="inst-hd">
            <span>ℹ️</span>
            <span>How to Check Your Individual Marksheet Online</span>
          </div>
          <ol class="inst-list">
            <li>Visit the official BEU Result Portal: <b>https://beu-bih.ac.in/result-one</b></li>
            <li>Find and click on <b>${examTitle}</b>.</li>
            <li>Enter your <b>BEU Registration Number</b> in the search box.</li>
            <li>Complete the Captcha verification and click <b>Show Result</b> to view your SGPA/CGPA.</li>
          </ol>
        </div>

        <div class="link-box">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.9; margin-bottom: 2px;">Official Result Link</div>
            <div class="link-url">https://beu-bih.ac.in/result-one</div>
          </div>
          <div style="font-size: 24px;">🌐</div>
        </div>

        <div class="footer">
          <div>🏛️ <b>BEU Patna (Bihar)</b> &nbsp;•&nbsp; Automated Notification System</div>
          <div>📢 <b>Apna College Bihar</b> WhatsApp Channel Update</div>
        </div>
      </body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });

    console.log(`[Result Media] ✅ Result PDF created: ${pdfPath}`);

    // Generate announcement banner card image for this result
    try {
      await generateAnnouncementBanner({
        id: safeId,
        title: examTitle,
        date: exam.publishDate,
        isResult: true,
        isUrgent: false
      }, imagePath);
    } catch {}

    return {
      success: true,
      pdfPath,
      imagePath: fs.existsSync(imagePath) ? imagePath : null,
      relativePdfUrl,
      relativeImageUrl: fs.existsSync(imagePath) ? relativeImageUrl : null
    };

  } catch (err) {
    console.error(`[Result Media] ❌ Error generating result PDF: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Main export: Downloads notice link and converts it to local image & PDF.
 * Returns { success, imagePath, relativeUrl, pdfPath, relativePdfUrl, isBanner, isResult, error }
 */
async function generateNoticeImage(notice) {
  // If this is a result declaration from result-one
  if (notice.isResult === true || String(notice.id).startsWith('result_')) {
    return await generateResultPdf(notice);
  }

  const rawId = String(notice.id || Date.now());
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanId = safeId.replace(/^(notice_|routine_)/, '');
  const prefix = safeId.startsWith('routine_') ? 'routine_' : 'notice_';
  const imageFilename = `${prefix}${cleanId}.png`;
  const pdfFilename = `${prefix}${cleanId}.pdf`;
  const imagePath = path.join(MEDIA_DIR, imageFilename);
  const pdfPath = path.join(MEDIA_DIR, pdfFilename);
  const relativeUrl = `/media/${imageFilename}`;
  const relativePdfUrl = `/media/${pdfFilename}`;

  // Check if both image and PDF already exist
  const hasImage = fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000;
  const hasPdf = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000;

  if (hasImage && hasPdf) {
    return {
      success: true,
      imagePath,
      relativeUrl,
      pdfPath,
      relativePdfUrl,
      cached: true
    };
  }

  const rawUrl = (notice.pdfLink || notice.link || '').trim();
  let pdfUrl = rawUrl;

  // Resolve relative backend PDF URL if needed
  if (pdfUrl && !pdfUrl.startsWith('http://') && !pdfUrl.startsWith('https://')) {
    pdfUrl = `https://beu-bih.ac.in/backend/${encodeURIComponent(pdfUrl)}`;
  }

  // Try 1: Download official file from BEU and save as PDF / render image
  if (pdfUrl && pdfUrl.startsWith('http')) {
    try {
      console.log(`[Notice Media] Downloading notice from: ${pdfUrl}`);
      const res = await httpClient.get(pdfUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(res.data);
      const contentType = (res.headers['content-type'] || '').toLowerCase();

      // If server returned an image directly
      if (contentType.includes('image') || pdfUrl.match(/\.(png|jpe?g|webp|gif)$/i)) {
        fs.writeFileSync(imagePath, buffer);
        console.log(`[Notice Media] Saved direct image: ${imagePath}`);
        return { success: true, imagePath, relativeUrl, pdfPath: null };
      }

      // Save official PDF
      fs.writeFileSync(pdfPath, buffer);
      console.log(`[Notice Media] Saved official PDF: ${pdfPath} (${buffer.length} bytes)`);

      // Render first page of PDF to image for channel banner preview
      console.log(`[Notice Media] Rendering PDF to image using PDF.js (${buffer.length} bytes)...`);
      await renderPdfToImage(buffer, imagePath);

      if (fs.existsSync(imagePath) && fs.statSync(imagePath).size > 1000) {
        console.log(`[Notice Media] ✅ PDF & Image rendered successfully: ${imagePath}`);
        return {
          success: true,
          imagePath,
          relativeUrl,
          pdfPath,
          relativePdfUrl
        };
      } else {
        return {
          success: true,
          imagePath: null,
          pdfPath,
          relativePdfUrl
        };
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
      return {
        success: true,
        imagePath,
        relativeUrl,
        pdfPath: fs.existsSync(pdfPath) ? pdfPath : null,
        relativePdfUrl: fs.existsSync(pdfPath) ? relativePdfUrl : null,
        isBanner: true
      };
    }
  } catch (err) {
    console.error(`[Notice Media] ❌ Banner generation failed: ${err.message}`);
  }

  return { success: false, imagePath: null, pdfPath: null, error: 'Could not generate image or PDF' };
}

/**
 * Builds the WhatsApp caption with:
 * 1. Title, course, semester and date
 * 2. Original Notice / PDF Download link
 * 3. User's WhatsApp Channel Link
 */
function buildCaption({
  title,
  pdfLink,
  date,
  isUrgent,
  channelLink,
  isResult = false,
  course = '',
  session = '',
  examHeld = ''
}) {
  const dateStr = date
    ? new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const lines = [];

  if (isResult) {
    lines.push('🎓 *BEU RESULT DECLARED!* 🚨');
    lines.push('');
    lines.push(`📌 *${(title || 'BEU Result Declared').trim()}*`);
    if (course) lines.push(`🏛️ *Course:* ${course}`);
    if (session) lines.push(`📚 *Session:* ${session}`);
    if (examHeld) lines.push(`🗓️ *Exam Held:* ${examHeld}`);
    lines.push(`📅 *Published Date:* ${dateStr}`);
    lines.push('');
    lines.push('🌐 *Check Your Result Online:*');
    lines.push('👉 https://beu-bih.ac.in/result-one');
    lines.push('');
    lines.push('📄 *Official Result Notification PDF attached below ⬇️*');
  } else {
    lines.push(isUrgent ? '🚨 *URGENT BEU NOTICE*' : '🔔 *New BEU Official Notice*');
    lines.push('');
    lines.push(`📌 *${(title || 'BEU Notice').trim()}*`);
    lines.push(`🗓️ *Date:* ${dateStr}`);
    lines.push('');

    if (pdfLink && pdfLink.trim()) {
      lines.push('📄 *Download Official PDF:*');
      lines.push(`👉 ${pdfLink.trim()}`);
      lines.push('');
    }
    lines.push('📄 *Official Notice PDF attached below ⬇️*');
  }

  lines.push('');
  if (channelLink && channelLink.trim()) {
    lines.push('📢 *Join WhatsApp Channel for Fastest Updates:*');
    lines.push(`👉 ${channelLink.trim()}`);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🎓 *Apna College Bihar* | Bihar Engineering University, Patna');
  lines.push('#BEU #BiharEngineering #Result #Notice #BEUUpdate');

  return lines.join('\n');
}

module.exports = {
  generateNoticeImage,
  generateResultPdf,
  downloadNoticePdf,
  buildCaption,
  renderPdfToImage,
  generateAnnouncementBanner,
  getChromePath,
  closeBrowser,
  MEDIA_DIR
};
