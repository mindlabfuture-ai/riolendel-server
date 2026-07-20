require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const goldPrice = require('./goldPrice');
const goldNews = require('./goldNews');
const chatbot = require('./chat');
const leadAgent = require('./leadAgent');
const { generateRssXml } = require('./rss');
const videoScraper = require('./videoScraper');
const socialPoster = require('./socialPoster');
const bufferPoster = require('./bufferPoster');
const videoProcessor = require('./videoProcessor');
const shopeeDownloader = require('./shopeeDownloader');
const scheduler = require('./scheduler');
const telegramBot = require('./telegramBot');
const sequences = require('./sequences');
const csvImport = require('./csvImport');
const emailSender = require('./emailSender');
const smsSender = require('./smsSender');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // CSP off by default since the page loads Google Fonts + hotlinked images; tighten this once your asset list is final

// Force www.riolendel.com -> riolendel.com (and http -> https) with a
// permanent redirect. This matters for two reasons: it stops Google from
// treating www and non-www as separate/competing URLs (our canonical tags
// already point to the non-www version), and if www was ever pointing at
// old content, this guarantees it now serves the real site instead.
app.use((req, res, next) => {
  if (req.path === '/healthz') return next(); // never redirect Railway's own health checks
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (host.startsWith('www.') || proto !== 'https') {
    const cleanHost = host.replace(/^www\./, '');
    return res.redirect(301, `https://${cleanHost}${req.originalUrl}`);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Video uploads land in a temp dir first; videoProcessor copies the final
// file into public/uploads/videos and cleans up the temp copy.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB cap
  fileFilter: (req, file, cb) => {
    const ok = /^video\//.test(file.mimetype) || /\.(mp4|mov|webm|m4v)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only video files are accepted.'), ok);
  },
});

// CSV contact imports stay in memory — these are small text files, no
// need to touch disk like video uploads do.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || /csv|text\/plain/.test(file.mimetype);
    cb(ok ? null : new Error('Only .csv files are accepted.'), ok);
  },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PH_MOBILE_RE = /^(09|\+639)\d{9}$/;

// Basic abuse protection: 5 opt-in submissions per IP every 10 minutes.
// Generous enough for real users retrying a typo, tight enough to stop
// a script from spamming your database.
const optinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' },
});

app.get('/api/gold-price', (req, res) => {
  const cached = goldPrice.getCached();
  res.json(cached);
});

app.get('/api/gold-news', (req, res) => {
  res.json(goldNews.getCached());
});

// GET /api/admin/refresh-news?token=YOUR_ADMIN_TOKEN
// Forces an immediate re-fetch instead of waiting for the next cron run
// — useful right after adding/changing CURRENTS_API_KEY.
app.get('/api/admin/refresh-news', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN not configured.' });
  if (req.query.token !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const diagnostics = await goldNews.fetchFromCurrentsApi();
  res.json({ diagnostics, cached: goldNews.getCached() });
});

app.post('/api/optin', optinLimiter, async (req, res) => {
  const { name, email, phone, consent, channel } = req.body || {};

  if (!name || !email || !phone) {
    return res.status(400).json({ ok: false, error: 'Name, email, and mobile number are all required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'That email address doesn\u2019t look right.' });
  }
  const normalizedPhone = phone.replace(/[\s-]/g, '');
  if (!PH_MOBILE_RE.test(normalizedPhone)) {
    return res.status(400).json({ ok: false, error: 'Enter a PH mobile number, e.g. 09xx xxx xxxx.' });
  }
  if (consent !== true) {
    return res.status(400).json({ ok: false, error: 'Consent is required to sign up.' });
  }
  const normalizedChannel = ['email', 'sms', 'both'].includes(channel) ? channel : 'email';

  const result = await db.saveOptIn({ fullName: name.trim(), email: email.trim().toLowerCase(), phone: normalizedPhone, channel: normalizedChannel });

  // Enroll immediately into the welcome/nurture drip — the PDF link is
  // also shown inline on the page, but this backs it up by email and
  // kicks off the follow-up sequence regardless of whether they click
  // the inline download link.
  sequences.enrollContact(
    { fullName: name.trim(), email: email.trim().toLowerCase(), phone: normalizedPhone, channel: normalizedChannel },
    { batchSource: 'landing_page' }
  ).catch(err => console.error('[optin] Sequence enrollment failed:', err.message));

  res.json({ ok: true, persisted: result.persisted });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/rss.xml', (req, res) => {
  res.type('application/rss+xml').send(generateRssXml());
});

// ---------- AI chat ----------
// Rate limit protects your Anthropic API budget from abuse: 20 messages
// per IP per 10 minutes is plenty for a real visitor, useless for a bot.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Slow down a little \u2014 try again in a few minutes.' },
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages } = req.body || {};
  const result = await chatbot.chat(messages);
  res.status(result.ok ? 200 : 400).json(result);
});

// ---------- Lead agent (admin only) ----------
// Protected by ADMIN_TOKEN env var. Call it like:
//   GET /api/admin/lead-report?token=YOUR_TOKEN
//   GET /api/admin/lead-report?token=YOUR_TOKEN&drafts=0   (skip AI drafting, faster/free)
app.get('/api/admin/lead-report', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN is not configured on the server.' });
  }
  if (req.query.token !== adminToken) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  const withDrafts = req.query.drafts !== '0';
  try {
    const report = await leadAgent.buildLeadReport({ withDrafts });
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[admin] Lead report failed:', err.message);
    res.status(500).json({ ok: false, error: 'Report generation failed \u2014 check server logs.' });
  }
});

// ---------- Public affiliate API ----------
// Serves published products for the /shop page — no auth needed.
app.get('/api/products', async (req, res) => {
  const { category, platform } = req.query;
  const products = await db.getProducts({ category, platform, active: true });
  res.json({ ok: true, products });
});

// Serves published videos for the /shop page.
app.get('/api/videos', async (req, res) => {
  const { platform } = req.query;
  const videos = await videoScraper.listVideos({ status: 'published', platform });
  res.json({ ok: true, videos });
});

// ---------- Admin: video scraper ----------
// All admin routes require ADMIN_TOKEN.
function requireAdmin(req, res) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) { res.status(503).json({ ok: false, error: 'ADMIN_TOKEN not configured.' }); return false; }
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== adminToken) { res.status(401).json({ ok: false, error: 'Unauthorized.' }); return false; }
  return true;
}

// Add a video
app.post('/api/admin/videos', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await videoScraper.addVideo(req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

// List all videos (admin sees all statuses)
app.get('/api/admin/videos', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { status, platform, limit } = req.query;
  const videos = await videoScraper.listVideos({ status, platform, limit: limit ? parseInt(limit) : undefined });
  res.json({ ok: true, videos });
});

// Update video status (draft → published → archived)
app.patch('/api/admin/videos/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { status } = req.body;
  const result = await videoScraper.setStatus(parseInt(req.params.id), status);
  res.status(result.ok ? 200 : 400).json(result);
});

// Delete a video
app.delete('/api/admin/videos/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await videoScraper.removeVideo(parseInt(req.params.id));
  res.json(result);
});

// ---------- Admin: affiliate products ----------
app.post('/api/admin/products', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { platform, productUrl, title, category, pricePHP, imageUrl, karat, description, affiliateLink, isFeatured } = req.body;
  if (!platform || !productUrl || !title) {
    return res.status(400).json({ ok: false, error: 'platform, productUrl, and title are required.' });
  }
  const result = await db.saveProduct({ platform, productUrl, title, category, pricePHP, imageUrl, karat, description, affiliateLink, isFeatured });
  res.status(result.persisted ? 200 : 400).json({ ok: result.persisted, id: result.id, error: result.error });
});

app.get('/api/admin/products', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const products = await db.getProducts(req.query);
  res.json({ ok: true, products });
});

app.delete('/api/admin/products/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const success = await db.deleteProduct(parseInt(req.params.id));
  res.json({ ok: success });
});

// ---------- Admin: cross-platform social posting ----------
// Get platform connection status
app.get('/api/admin/social/status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, platforms: socialPoster.getPlatformStatus() });
});

// One-time setup helper: lists your Buffer organizations + channels so
// you can copy each channel's id into BUFFER_CHANNEL_<PLATFORM> env vars.
app.get('/api/admin/buffer/channels', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!bufferPoster.isConfigured()) return res.status(503).json({ ok: false, error: 'BUFFER_API_KEY not set.' });
  const result = await bufferPoster.listChannels();
  res.json(result);
});

// Compose and post to one or more platforms
app.post('/api/admin/social/post', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { message, link, imageUrl, videoUrl, caption, title, platforms, privacyLevel } = req.body;
  if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ ok: false, error: 'Select at least one platform.' });
  }

  // Save the post record first
  const saved = await db.saveSocialPost({ message, link, imageUrl, videoUrl, platforms: {}, sourceType: 'manual' });
  const postId = saved.id;
  const results = {};

  // Post to each selected platform
  for (const platform of platforms) {
    const payload = {
      message: message || caption || '',
      caption: caption || message || '',
      title: title || (message || '').slice(0, 150),
      link,
      imageUrl,
      videoUrl,
      productUrl: link,
      privacyLevel,
    };
    const result = await socialPoster.postTo(platform, payload);
    results[platform] = result;
    // Update post record with per-platform result
    if (postId) await db.updateSocialPostPlatform(postId, platform, result);
  }

  res.json({ ok: true, postId, results });
});

// Post history
app.get('/api/admin/social/history', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const posts = await db.getSocialPosts({ limit: req.query.limit });
  res.json({ ok: true, posts });
});

// ---------- Admin: upload video & auto-extract JPEG frames ----------
// Accepts a video file (multipart/form-data, field name "video").
// Extracts 2-4 evenly-spaced JPEG stills, saves the video itself, and
// returns everything needed to build a warm-up campaign. Nothing is
// posted yet — this only prepares the assets.
app.post('/api/admin/videos/upload', upload.single('video'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ ok: false, error: 'No video file uploaded (field name must be "video").' });

  const frameCount = req.body.frameCount ? Math.max(2, Math.min(4, parseInt(req.body.frameCount))) : 3;

  try {
    const result = await videoProcessor.processUploadedVideo(req.file.path, req.file.originalname, { frameCount });
    fs.unlink(req.file.path, () => {}); // clean up multer's temp copy
    res.json({
      ok: true,
      video: { url: result.video.publicUrl },
      frames: result.frames.map(f => ({ url: f.publicUrl, timestamp: f.timestamp })),
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error('[admin] Video processing failed:', err.message);
    res.status(500).json({ ok: false, error: 'Video processing failed — check server logs (is ffmpeg installed?).' });
  }
});

// ---------- Admin: download a Shopee video from a pasted link ----------
// Admin pastes ONE Shopee product/video URL — server fetches that page,
// extracts the embedded video file, downloads it, and extracts JPEG
// frames the same way the file-upload route does. One link at a time,
// on demand — this is not a crawler. See src/shopeeDownloader.js for
// the honest caveat about how fragile page-scraping can be.
app.post('/api/admin/videos/download-shopee', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { url, frameCount } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'Pass a Shopee URL in the "url" field.' });

  const count = frameCount ? Math.max(2, Math.min(4, parseInt(frameCount))) : 3;

  const downloadResult = await shopeeDownloader.downloadFromShopeeUrl(url);
  if (!downloadResult.ok) {
    return res.status(422).json({ ok: false, error: downloadResult.error });
  }

  try {
    const frames = await videoProcessor.extractFrames(downloadResult.video.filePath, { count });
    res.json({
      ok: true,
      video: { url: downloadResult.video.url },
      frames: frames.map(f => ({ url: f.publicUrl, timestamp: f.timestamp })),
    });
  } catch (err) {
    console.error('[admin] Frame extraction failed for Shopee download:', err.message);
    res.status(500).json({ ok: false, error: 'Video downloaded but frame extraction failed — check server logs (is ffmpeg installed?).' });
  }
});

// ---------- Admin: warm-up campaigns & scheduled posting ----------

// Create a two-phase warm-up campaign: still frames now, real video +
// affiliate link `delayHours` later (default 36h).
app.post('/api/admin/schedule/warmup', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { message, warmupImages, videoUrl, affiliateLink, platforms, delayHours, sourceVideoId } = req.body;
  const result = await scheduler.createWarmupCampaign({ message, warmupImages, videoUrl, affiliateLink, platforms, delayHours, sourceVideoId });
  res.status(result.ok ? 200 : 400).json(result);
});

// Create a single one-off scheduled post (no warm-up phases).
app.post('/api/admin/schedule/post', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { message, link, imageUrls, videoUrl, platforms, scheduledFor, sourceVideoId } = req.body;
  const result = await scheduler.scheduleSinglePost({ message, link, imageUrls, videoUrl, platforms, scheduledFor, sourceVideoId });
  res.status(result.ok ? 200 : 400).json(result);
});

// Swap in a freshly-generated affiliate link before a pending post fires
// (useful right before Phase 2 if the original link's session expired).
app.patch('/api/admin/schedule/:id/link', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { link } = req.body;
  if (!link) return res.status(400).json({ ok: false, error: 'link is required.' });
  const result = await scheduler.updateScheduledLink(parseInt(req.params.id), link);
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete('/api/admin/schedule/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await scheduler.cancelScheduledPost(parseInt(req.params.id));
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/admin/schedule', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const posts = await scheduler.listScheduled({ status: req.query.status, limit: req.query.limit });
  res.json({ ok: true, posts });
});

// Manually trigger a schedule check (handy for testing without waiting for cron).
app.post('/api/admin/schedule/run-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await scheduler.runDueSchedule();
  res.json({ ok: true, ...result });
});

// ---------- Telegram bot ----------
// Telegram calls this every time someone messages your bot. No admin
// token here — Telegram itself doesn't support custom auth headers on
// webhooks, so access is controlled by TELEGRAM_CHAT_ID inside the bot
// (only that chat ID gets responses; everyone else is politely ignored).
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    await telegramBot.handleUpdate(req.body);
  } catch (err) {
    console.error('[telegram] Update handling failed:', err.message);
  }
  res.sendStatus(200); // always 200 quickly — Telegram retries on non-200
});

// One-time setup: registers your deployed URL as the webhook target.
// GET /api/admin/telegram/set-webhook?token=YOUR_TOKEN&url=https://riolendel.com/api/telegram/webhook
app.get('/api/admin/telegram/set-webhook', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'Pass ?url=https://yourdomain.com/api/telegram/webhook' });
  const result = await telegramBot.setWebhook(url);
  res.json(result);
});

// ---------- Admin: CSV contact import & nurture sequence ----------

// Upload a CSV (columns: name, email, phone, channel), import each
// contact, and enroll them into the nurture drip. `sendAt` (optional,
// ISO string in the request body) lets you pick when the first
// message goes out for this batch instead of firing immediately.
app.post('/api/admin/contacts/import', uploadCsv.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.status(400).json({ ok: false, error: 'No CSV uploaded (field name must be "file").' });

  try {
    const text = req.file.buffer.toString('utf-8');
    const contacts = csvImport.parseCsv(text);
    if (contacts.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid rows found — need at least an email or phone column.' });
    }

    const importResult = await db.bulkImportContacts(contacts);
    const startAt = req.body.sendAt ? new Date(req.body.sendAt) : undefined;
    const enrollResult = await sequences.enrollBatch(importResult.rows, { startAt, batchSource: 'csv_import' });

    res.json({
      ok: true,
      parsed: contacts.length,
      imported: importResult.imported,
      skipped: importResult.skipped,
      messagesEnqueued: enrollResult.messagesEnqueued,
      startAt: startAt ? startAt.toISOString() : new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin] CSV import failed:', err.message);
    res.status(500).json({ ok: false, error: 'Import failed — check server logs.' });
  }
});

// Sequence queue status
app.get('/api/admin/sequence/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = await sequences.getStats();
  res.json({ ok: true, stats });
});

// Email/SMS provider configuration status (separate from social platforms).
app.get('/api/admin/notify/status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    providers: {
      email: { name: 'Resend', configured: emailSender.isConfigured() },
      sms: { name: 'Semaphore', configured: smsSender.isConfigured() },
    },
  });
});

app.get('/api/admin/sequence/messages', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const messages = await sequences.listMessages({ status: req.query.status, limit: req.query.limit });
  res.json({ ok: true, messages });
});

// Manually trigger a sequence check (handy for testing without waiting for cron).
app.post('/api/admin/sequence/run-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await sequences.runDueSequence();
  res.json({ ok: true, ...result });
});

// Catches errors thrown by middleware before a route handler runs —
// most importantly multer's fileFilter rejections and file-size-limit
// errors on the video/CSV upload routes, which otherwise bypass our
// JSON responses entirely and fall through to Express's default HTML
// error page. Must be registered last, after every other app.use/route.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error('[server] Unhandled error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error.' });
  }
  next();
});

async function start() {
  await db.init();
  await goldPrice.init();
  await goldNews.init();
  scheduler.start(process.env.SCHEDULER_CRON || '*/5 * * * *');
  sequences.start(process.env.SEQUENCE_CRON || '*/10 * * * *');
  app.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
}

start();
