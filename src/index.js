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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // CSP off by default since the page loads Google Fonts + hotlinked images; tighten this once your asset list is final
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  await goldNews.fetchFromCurrentsApi();
  res.json({ ok: true, cached: goldNews.getCached() });
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

async function start() {
  await db.init();
  await goldPrice.init();
  await goldNews.init();
  app.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
}

start();
