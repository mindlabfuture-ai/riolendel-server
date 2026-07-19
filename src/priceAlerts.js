const db = require('./db');
const notify = require('./notify');

// How big a day-over-day move has to be before we alert subscribers.
// 1.5% is a reasonable "this is worth telling people about" threshold —
// gold typically moves under 1% on a quiet day.
const MOVE_THRESHOLD_PCT = 1.5;

async function checkForNotableMove(newPrice) {
  const previous = await db.getPreviousPrice();
  await db.recordPriceHistory(newPrice);

  if (previous === null) {
    console.log('[price-alerts] No prior price on record yet — skipping move check.');
    return;
  }

  const changePct = ((newPrice - previous) / previous) * 100;

  if (Math.abs(changePct) < MOVE_THRESHOLD_PCT) {
    return; // normal day, nothing to alert about
  }

  const direction = changePct > 0 ? 'jumped' : 'dropped';
  console.log(`[price-alerts] Notable move detected: gold ${direction} ${changePct.toFixed(2)}% (from $${previous} to $${newPrice}).`);

  // NOTE: this does not try to auto-detect *why* the price moved — that
  // needs either a paid news API or a human adding one line of context.
  // For now it sends a plain price-move alert; consider pairing this
  // with a quick manual check of gold news before sending, so the
  // message can say *why* (Fed decision, geopolitical event, etc.)
  // rather than just *that* it moved.
  const subscribers = await db.getSubscribers();
  if (subscribers.length === 0) {
    console.log('[price-alerts] No subscribers yet — nothing to send.');
    return;
  }

  const subject = `Gold just ${direction} ${Math.abs(changePct).toFixed(1)}% — here's what to know`;
  const message = `Gold ${direction} ${Math.abs(changePct).toFixed(1)}% today, now around $${newPrice.toFixed(2)}/oz. ` +
    `Check riolendel.com for the current peso price and context. Unsubscribe anytime by replying STOP to any of our emails.`;

  // Price alerts are EMAIL ONLY, regardless of a subscriber's channel
  // preference (email/sms/both) — this is the highest-volume trigger
  // in the whole system (fires every time gold moves ≥1.5% in a day),
  // so keeping it off Semaphore's per-SMS billing is the single biggest
  // cost lever available. Email is collected from every subscriber
  // (required field on the opt-in form), so this never excludes anyone
  // who wants the alert. SMS still gets used elsewhere — the one-time
  // welcome text in sequences.js — just not for this recurring trigger.
  let sent = 0;
  for (const sub of subscribers) {
    const result = await notify.sendEmail(sub.email, subject, message);
    if (result.ok) sent++;
  }
  console.log(`[price-alerts] Sent ${sent}/${subscribers.length} email alert(s).`);
}

module.exports = { checkForNotableMove, MOVE_THRESHOLD_PCT };
