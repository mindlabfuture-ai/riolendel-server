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

// ---------- Site tracking ----------
// Loose rate limit — this just guards against obvious abuse/bot spam
// inflating the counters, not real traffic (60/10min is generous).
const trackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const ALLOWED_SOURCES = /^[a-z0-9_-]{1,40}$/i;
function sanitizeSource(s) {
  return (typeof s === 'string' && ALLOWED_SOURCES.test(s)) ? s.toLowerCase() : 'direct';
}

app.post('/api/track/visit', trackLimiter, async (req, res) => {
  const source = sanitizeSource((req.body || {}).source);
  await db.recordVisit(source);
  res.json({ ok: true });
});

app.post('/api/track/click', trackLimiter, async (req, res) => {
  const { slug, source } = req.body || {};
  if (!slug || typeof slug !== 'string' || slug.length > 200) {
    return res.status(400).json({ ok: false, error: 'Invalid slug.' });
  }
  await db.recordClick(slug, sanitizeSource(source));
  res.json({ ok: true });
});

// GET /api/admin/stats?token=YOUR_ADMIN_TOKEN
// Total visits, total product clicks, click-through rate, and a top-10
// most-clicked-product breakdown, all counted since launch day.
app.get('/api/admin/stats', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN not configured.' });
  if (req.query.token !== adminToken) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const stats = await db.getStats();
  res.json({ ok: true, ...stats });
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
