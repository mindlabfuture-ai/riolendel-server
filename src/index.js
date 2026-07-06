require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const goldPrice = require('./goldPrice');

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

async function start() {
  await db.init();
  await goldPrice.init();
  app.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
}

start();
