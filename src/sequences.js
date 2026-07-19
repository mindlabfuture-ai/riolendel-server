/**
 * Sequences — the opt-in nurture drip that runs after someone signs up
 * (live on the landing page, or bulk-imported via CSV). Two channels:
 *
 *   EMAIL steps (Resend): welcome + PDF link → jewelry care tips two
 *   days later → soft nudge toward /shop five days later.
 *
 *   SMS step (Semaphore): a single immediate welcome text, separate
 *   from the price-move / news alerts in priceAlerts.js. Price alerts
 *   are EMAIL ONLY (see priceAlerts.js for why) — the welcome text
 *   itself is the only SMS this system ever sends per contact.
 *
 * CSV imports can set a custom `startAt` so admin decides when the
 * first message goes out (e.g. "not at 2am") — every later step is
 * offset from that same startAt, not from real "now".
 */

const db = require('./db');
const notify = require('./notify');
const cron = require('node-cron');

let cronTask = null;

const SITE_URL = process.env.SITE_URL || 'https://riolendel.com';

// ---------- Content templates ----------

function emailSteps(fullName) {
  const firstName = (fullName || '').split(' ')[0] || 'there';
  return [
    {
      step: 1,
      offsetHours: 0,
      subject: "Your free Gold Owner's Guide is here 🪙",
      body:
        `Hi ${firstName},\n\n` +
        `Thanks for signing up! Here's your free Gold Owner's Guide — a short, plain-language PDF on buying gold safely and caring for the jewelry you already own:\n\n` +
        `${SITE_URL}/gold-guide.pdf\n\n` +
        `You'll also get our weekly price note and a heads-up if gold makes a notable move. Reply STOP anytime to unsubscribe.\n\n` +
        `— Riolendel`,
    },
    {
      step: 2,
      offsetHours: 48,
      subject: '3 things that quietly damage gold jewelry (and how to avoid them)',
      body:
        `Hi ${firstName},\n\n` +
        `A quick one — the most common ways gold jewelry gets damaged aren't accidents, they're habits: swimming/showering with it on, tossing pieces in one drawer together, and cleaning with the wrong products.\n\n` +
        `Full care steps (and a "do this, not that" list) are on our site: ${SITE_URL}/#jewelry-care\n\n` +
        `— Riolendel`,
    },
    {
      step: 3,
      offsetHours: 120,
      subject: 'A few 18K pieces worth a look',
      body:
        `Hi ${firstName},\n\n` +
        `If you're ever in the market for a new piece, we've put together a small curated list of 18K gold jewelry from Shopee and TikTok Shop — real reviews, proper karat markings, sellers with track records:\n\n` +
        `${SITE_URL}/shop/\n\n` +
        `No pressure either way — just here if it's useful.\n\n` +
        `— Riolendel`,
    },
  ];
}

function smsWelcomeStep(fullName) {
  const firstName = (fullName || '').split(' ')[0] || 'there';
  return {
    step: 1,
    offsetHours: 0,
    subject: null,
    body: `Hi ${firstName}! Thanks for signing up sa Riolendel. Check your email for your free Gold Owner's Guide — that's also where we'll email you if gold prices make a big move. Reply STOP to unsubscribe.`,
  };
}

/**
 * SMS for CSV-imported contacts (existing customers/leads pulled in
 * via /admin/contacts.html) — NOT the live opt-in form. These people
 * haven't actively signed up on riolendel.com yet, so the message
 * introduces the site instead of thanking them for something they
 * didn't do, and invites them to opt in for the free PDF + calculator
 * rather than assuming consent already given.
 */
function smsIntroStep(fullName) {
  const firstName = (fullName || '').split(' ')[0] || 'there';
  return {
    step: 1,
    offsetHours: 0,
    subject: null,
    // Kept plain ASCII (no em dash/curly quotes) and under 160 chars so
    // this bills as ONE Semaphore SMS segment, not several — special
    // characters push SMS into Unicode encoding, which caps a segment
    // at 67 chars instead of 160 and can silently multiply the cost.
    body: `Hi ${firstName}! Riolendel here - gold education for PH families. Free Gold Guide + price calculator: ${SITE_URL.replace(/^https?:\/\//, '')}. Reply STOP to opt out.`,
  };
}

// ---------- Enrollment ----------

/**
 * Enroll one contact into the drip. `channel` is 'email' | 'sms' | 'both'
 * (matches the optins.channel convention already used across the app).
 * `startAt` (Date, optional) lets CSV imports pick a send time instead
 * of firing immediately — defaults to now. `batchSource` also picks
 * which SMS content is used: 'csv_import' contacts get an introduction
 * (they haven't opted in live), everyone else gets the welcome text
 * (they just did).
 */
async function enrollContact({ fullName, email, phone, channel }, { startAt, batchSource } = {}) {
  const base = startAt ? new Date(startAt) : new Date();
  const source = batchSource || 'landing_page';
  const enqueued = [];

  if ((channel === 'email' || channel === 'both') && email) {
    for (const step of emailSteps(fullName)) {
      const scheduledFor = new Date(base.getTime() + step.offsetHours * 60 * 60 * 1000);
      const result = await db.enqueueSequenceMessage({
        fullName, email, phone: null, channel: 'email',
        step: step.step, subject: step.subject, body: step.body,
        scheduledFor, batchSource: source,
      });
      if (result.persisted) enqueued.push(result.id);
    }
  }

  if ((channel === 'sms' || channel === 'both') && phone) {
    const step = source === 'csv_import' ? smsIntroStep(fullName) : smsWelcomeStep(fullName);
    const scheduledFor = new Date(base.getTime() + step.offsetHours * 60 * 60 * 1000);
    const result = await db.enqueueSequenceMessage({
      fullName, email: null, phone, channel: 'sms',
      step: step.step, subject: null, body: step.body,
      scheduledFor, batchSource: source,
    });
    if (result.persisted) enqueued.push(result.id);
  }

  return { ok: true, enqueued: enqueued.length, messageIds: enqueued };
}

/** Enroll a batch of contacts (e.g. from a CSV import) with a shared start time. */
async function enrollBatch(contacts, { startAt, batchSource } = {}) {
  let totalEnqueued = 0;
  for (const c of contacts) {
    const result = await enrollContact(c, { startAt, batchSource: batchSource || 'csv_import' });
    totalEnqueued += result.enqueued;
  }
  return { ok: true, contactsEnrolled: contacts.length, messagesEnqueued: totalEnqueued };
}

// ---------- Sending ----------

async function runDueSequence() {
  const due = await db.getDueSequenceMessages(30);
  if (due.length === 0) return { checked: 0, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const msg of due) {
    try {
      let result;
      if (msg.channel === 'email') {
        result = await notify.sendEmail(msg.email, msg.subject || 'Riolendel', msg.body);
      } else {
        result = await notify.sendSms(msg.phone, msg.body);
      }
      await db.markSequenceMessageSent(msg.id, result.ok, result.ok ? null : result.error);
      if (result.ok) sent++; else failed++;
    } catch (err) {
      await db.markSequenceMessageSent(msg.id, false, err.message);
      failed++;
    }
  }
  console.log(`[sequences] Checked ${due.length} due message(s): ${sent} sent, ${failed} failed.`);
  return { checked: due.length, sent, failed };
}

async function getStats() {
  return db.getSequenceStats();
}

async function listMessages({ status, limit } = {}) {
  return db.getSequenceMessages({ status, limit });
}

// ---------- Cron wiring ----------

function start(cronExpression = '*/10 * * * *') {
  if (cronTask) return;
  cronTask = cron.schedule(cronExpression, () => {
    runDueSequence().catch(err => console.error('[sequences] Tick failed:', err.message));
  });
  console.log(`[sequences] Started — checking for due messages on schedule "${cronExpression}".`);
}

function stop() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
}

module.exports = { enrollContact, enrollBatch, runDueSequence, getStats, listMessages, start, stop };
