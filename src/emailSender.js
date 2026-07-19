/**
 * Email Sender — Resend integration for the opt-in nurture sequence
 * (welcome + PDF, price-alert emails, etc.) This is for PERMISSION-
 * BASED email only — people who submitted the opt-in form on
 * riolendel.com. It is not built for cold outreach; see the note in
 * README about Resend vs Smartlead.ai for why that's a different tool
 * for a different job.
 *
 * Setup: sign up at resend.com, verify your sending domain (riolendel.com),
 * get an API key, set RESEND_API_KEY and RESEND_FROM_EMAIL in your env.
 */

const RESEND_API = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

/**
 * Send a single email. `html` is optional — if omitted, `text` is sent
 * as plain text. Returns { ok, id, error }.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!isConfigured()) {
    console.log(`[emailSender:STUB] Would send EMAIL to ${to} — "${subject}" (RESEND_API_KEY/RESEND_FROM_EMAIL not set)`);
    return { ok: false, error: 'Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing).' };
  }

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [to],
        subject,
        html: html || undefined,
        text: html ? undefined : (text || ''),
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.message || `Resend responded ${res.status}` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, isConfigured };
