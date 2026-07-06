// This module is a STUB. It does not actually send email or SMS yet —
// it logs what *would* be sent, so you can verify the trigger logic
// before wiring up a real provider.
//
// To make this real:
//
// EMAIL — pick one:
//   - Resend (resend.com) — simple API, generous free tier
//   - Postmark (postmarkapp.com) — great deliverability, paid
//   Both give you an API key and a `send(to, subject, body)` call.
//
// SMS (Philippines) — pick one:
//   - Semaphore (semaphore.co) — popular PH SMS gateway, pay-per-SMS
//   - Movider (movider.co) — similar, international + PH support
//   Both give you an API key and a `send(to, message)` call.
//
// Once you have API keys, replace the console.log calls below with real
// fetch() calls to your provider's API, and add the keys to your .env /
// Railway variables (e.g. RESEND_API_KEY, SEMAPHORE_API_KEY).

async function sendEmail(to, subject, body) {
  console.log(`[notify:STUB] Would send EMAIL to ${to} — "${subject}"`);
  console.log(`[notify:STUB]   ${body}`);
  // TODO: replace with a real call, e.g.:
  // await fetch('https://api.resend.com/emails', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ from: 'alerts@riolendel.com', to, subject, text: body }),
  // });
}

async function sendSms(to, message) {
  console.log(`[notify:STUB] Would send SMS to ${to}: "${message}"`);
  // TODO: replace with a real call, e.g. (Semaphore):
  // await fetch('https://api.semaphore.co/api/v4/messages', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ apikey: process.env.SEMAPHORE_API_KEY, number: to, message }),
  // });
}

async function notifySubscribers(subscribers, { subject, message }) {
  let sent = 0;
  for (const sub of subscribers) {
    if (sub.channel === 'email' || sub.channel === 'both') {
      await sendEmail(sub.email, subject, message);
      sent++;
    }
    if (sub.channel === 'sms' || sub.channel === 'both') {
      await sendSms(sub.phone, message);
      sent++;
    }
  }
  console.log(`[notify:STUB] Processed ${subscribers.length} subscriber(s), ${sent} message(s) "sent".`);
}

module.exports = { sendEmail, sendSms, notifySubscribers };
