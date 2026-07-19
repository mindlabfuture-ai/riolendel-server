/**
 * SMS Sender — Semaphore (semaphore.co) integration for PH mobile
 * numbers. Used for: (1) the opt-in nurture sequence's SMS leg, and
 * (2) major gold-price-move / news alerts (see priceAlerts.js).
 *
 * Setup: sign up at semaphore.co, load SMS credits, get your API key
 * from the dashboard, set SEMAPHORE_API_KEY. Optionally register a
 * Sender Name (e.g. "RIOLENDEL") — takes a few days for Semaphore to
 * approve — and set SEMAPHORE_SENDER_NAME once approved; without it,
 * messages send from Semaphore's shared default sender ID.
 */

const SEMAPHORE_API = 'https://api.semaphore.co/api/v4/messages';

function isConfigured() {
  return Boolean(process.env.SEMAPHORE_API_KEY);
}

// Normalize to Semaphore's expected format: 09xxxxxxxxx or 639xxxxxxxxx both work,
// but strip spaces/dashes either way.
function normalizePhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '');
}

/** Send a single SMS. Returns { ok, id, error }. */
async function sendSms(to, message) {
  if (!isConfigured()) {
    console.log(`[smsSender:STUB] Would send SMS to ${to}: "${message}" (SEMAPHORE_API_KEY not set)`);
    return { ok: false, error: 'Semaphore not configured (SEMAPHORE_API_KEY missing).' };
  }

  const body = {
    apikey: process.env.SEMAPHORE_API_KEY,
    number: normalizePhone(to),
    message,
  };
  if (process.env.SEMAPHORE_SENDER_NAME) body.sendername = process.env.SEMAPHORE_SENDER_NAME;

  try {
    const res = await fetch(SEMAPHORE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.message || `Semaphore responded ${res.status}` };
    // Semaphore returns an array of message objects, one per recipient split.
    const first = Array.isArray(data) ? data[0] : data;
    return { ok: true, id: first?.message_id, status: first?.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendSms, isConfigured, normalizePhone };
