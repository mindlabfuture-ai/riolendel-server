// AI chatbot backend for the landing page.
// Uses Claude Haiku (claude-haiku-4-5) — Anthropic's lowest-cost current
// model at $1/$5 per million input/output tokens (pay-as-you-go).
// Requires ANTHROPIC_API_KEY in your environment (console.anthropic.com).
//
// Cost controls in this file:
//   - max_tokens capped at 400 per reply
//   - conversation history truncated to the last 8 messages
//   - each user message capped at 1,000 characters
//   - rate limiting is applied at the route level (see index.js)

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 400;
const MAX_HISTORY = 8;
const MAX_MSG_CHARS = 1000;

const SYSTEM_PROMPT = `You are the helpful assistant on riolendel.com, a gold education website for Filipino consumers, many of whom are past customers of a family jewelry business.

Your job:
- Answer questions about gold: physical gold, jewelry care, digital gold, how gold prices work, the difference between formats.
- Be warm and conversational. Taglish is welcome when the user writes in Tagalog or Taglish.
- Keep answers short (2-5 sentences typically) — this is a chat widget, not an essay.

Strict rules:
- You provide education, NOT financial advice. Never tell someone what to buy, how much to invest, or when. If asked, explain the general considerations and suggest they decide based on their own situation or consult a licensed professional.
- Never recommend specific investment platforms. You may explain what to check about ANY platform (BSP/SEC registration, real bullion backing, withdrawal testing, fees).
- If anything promises "guaranteed returns" on gold, say clearly that's a red flag for a scam.
- Never collect personal or financial information in chat. If someone wants updates, point them to the sign-up form on this page.
- If asked about things unrelated to gold, jewelry, or this site, politely steer back.
- Current gold prices: say the live ticker at the top of the page has today's price; don't invent numbers.`;

async function chat(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: 'Chat isn\u2019t configured yet. (Server owner: set ANTHROPIC_API_KEY.)',
    };
  }

  // Sanitize: keep only the last MAX_HISTORY messages, enforce roles, cap length.
  const cleaned = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));

  if (cleaned.length === 0 || cleaned[cleaned.length - 1].role !== 'user') {
    return { ok: false, error: 'No user message to respond to.' };
  }

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
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: cleaned,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[chat] Anthropic API error:', res.status, errBody.slice(0, 300));
      return { ok: false, error: 'The assistant is having trouble right now \u2014 please try again in a moment.' };
    }

    const data = await res.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return { ok: true, reply: reply || 'Sorry, I couldn\u2019t come up with a reply \u2014 try rephrasing?' };
  } catch (err) {
    console.error('[chat] Request failed:', err.message);
    return { ok: false, error: 'The assistant is having trouble right now \u2014 please try again in a moment.' };
  }
}

module.exports = { chat };
