// Lead agent: scores every opted-in lead and drafts a personalized email
// for each, producing a "send-ready" list FOR HUMAN REVIEW — nothing is
// sent automatically.
//
// IMPORTANT DESIGN DECISION — why this does NOT web-research individuals:
// Your subscribers consented to receive gold updates. Using their name/
// email/phone to profile them around the web goes beyond that consented
// purpose (PH Data Privacy Act purpose-limitation), and for private
// individuals it mostly returns noise anyway. So scoring here uses only
// first-party signals: what they gave you and how they signed up.
//
// Requires ANTHROPIC_API_KEY for the drafting step.

const db = require('./db');

const MODEL = 'claude-haiku-4-5';

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.com.ph', 'outlook.com', 'hotmail.com',
  'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com',
]);

// ---------- Scoring (rule-based, first-party signals only) ----------

function scoreLead(lead) {
  let score = 0;
  const reasons = [];

  // Channel choice signals engagement intent
  if (lead.channel === 'both') { score += 30; reasons.push('Opted into BOTH email and SMS (high engagement intent)'); }
  else if (lead.channel === 'sms') { score += 20; reasons.push('Chose SMS (higher-attention channel)'); }
  else { score += 10; reasons.push('Chose email'); }

  // Everyone in this table gave fresh, explicit consent
  score += 20; reasons.push('Fresh double opt-in consent on record');

  // Business-domain email suggests a professional / possible bulk buyer
  const domain = (lead.email.split('@')[1] || '').toLowerCase();
  if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
    score += 15; reasons.push(`Business/custom email domain (${domain})`);
  }

  // Recency: signed up in the last 7 days = hot
  if (lead.created_at) {
    const days = (Date.now() - new Date(lead.created_at).getTime()) / 86400000;
    if (days <= 7) { score += 25; reasons.push('Signed up within the last 7 days'); }
    else if (days <= 30) { score += 15; reasons.push('Signed up within the last 30 days'); }
    else { score += 5; reasons.push('Older signup \u2014 may need re-warming'); }
  }

  let tier = 'C';
  if (score >= 75) tier = 'A';
  else if (score >= 55) tier = 'B';

  return { score, tier, reasons };
}

// ---------- Email drafting via Claude ----------

async function draftEmail(lead, scored) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { subject: null, body: null, note: 'ANTHROPIC_API_KEY not set \u2014 drafting skipped.' };

  const firstName = (lead.full_name || '').trim().split(/\s+/)[0] || 'kaibigan';

  const prompt = `Draft a short, warm follow-up email for a new subscriber to riolendel.com, a gold-education site for Filipino consumers (many are past customers of a family jewelry business).

Subscriber details (first-party data only):
- First name: ${firstName}
- Preferred channel: ${lead.channel}
- Lead tier: ${scored.tier} (${scored.score}/100)

Requirements:
- Subject line + body. Body under 130 words.
- Tone: warm, personal, light Taglish welcome is good (audience is Filipino).
- Remind them their free Gold Owner's Guide PDF is available at riolendel.com if they haven't opened it.
- Mention they'll get gold price updates via their chosen channel.
- NO investment advice, NO platform recommendations, NO urgency tactics, NO guaranteed-return language.
- End with: they can reply STOP or unsubscribe anytime, no hard feelings.

Respond ONLY with JSON in this exact shape, no markdown fences:
{"subject": "...", "body": "..."}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { subject: parsed.subject, body: parsed.body };
  } catch (err) {
    console.error(`[lead-agent] Draft failed for ${lead.email}:`, err.message);
    return { subject: null, body: null, note: 'Drafting failed \u2014 write manually or retry.' };
  }
}

// ---------- The full agent run ----------

async function buildLeadReport({ withDrafts = true } = {}) {
  const leads = await db.getSubscribersDetailed();
  const report = [];

  for (const lead of leads) {
    const scored = scoreLead(lead);
    const entry = {
      name: lead.full_name,
      email: lead.email,
      phone: lead.phone,
      channel: lead.channel,
      signed_up: lead.created_at,
      score: scored.score,
      tier: scored.tier,
      why: scored.reasons,
      draft: null,
    };
    if (withDrafts) {
      entry.draft = await draftEmail(lead, scored);
    }
    report.push(entry);
  }

  // Highest-priority leads first
  report.sort((a, b) => b.score - a.score);

  return {
    generated_at: new Date().toISOString(),
    total_leads: report.length,
    tiers: {
      A: report.filter(r => r.tier === 'A').length,
      B: report.filter(r => r.tier === 'B').length,
      C: report.filter(r => r.tier === 'C').length,
    },
    note: 'Drafts are for YOUR review before sending. Nothing has been sent automatically.',
    leads: report,
  };
}

module.exports = { buildLeadReport, scoreLead };
