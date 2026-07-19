// Sends real email (Resend) and SMS (Semaphore) to subscribers. Falls
// back to logging (not sending) if the relevant provider isn't
// configured yet, so the rest of the app (price alerts, sequences)
// keeps working end-to-end even before you add API keys.

const emailSender = require('./emailSender');
const smsSender = require('./smsSender');

async function sendEmail(to, subject, body) {
  const result = await emailSender.sendEmail({ to, subject, text: body });
  if (!result.ok) console.warn(`[notify] Email to ${to} not sent: ${result.error}`);
  return result;
}

async function sendSms(to, message) {
  const result = await smsSender.sendSms(to, message);
  if (!result.ok) console.warn(`[notify] SMS to ${to} not sent: ${result.error}`);
  return result;
}

async function notifySubscribers(subscribers, { subject, message }) {
  let sent = 0;
  for (const sub of subscribers) {
    if (sub.channel === 'email' || sub.channel === 'both') {
      const r = await sendEmail(sub.email, subject, message);
      if (r.ok) sent++;
    }
    if (sub.channel === 'sms' || sub.channel === 'both') {
      const r = await sendSms(sub.phone, message);
      if (r.ok) sent++;
    }
  }
  console.log(`[notify] Processed ${subscribers.length} subscriber(s), ${sent} message(s) sent.`);
}

module.exports = { sendEmail, sendSms, notifySubscribers };
