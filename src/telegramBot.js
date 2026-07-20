/**
 * Telegram Bot — remote control for the video-scraping workflow, run
 * entirely through chat commands. Nothing here downloads video files;
 * it only searches, recommends, and manages the review queue. Actual
 * downloading stays a manual, human-reviewed step (see README) — this
 * bot just saves you from having to open the admin dashboard to search
 * and queue candidates.
 *
 * Commands:
 *   /scrape <keyword>   — search TikTok for candidate videos, biased
 *                          toward TikTok Shop-tagged content, message
 *                          back a ranked list for you to review. Note:
 *                          commission status can't be auto-verified —
 *                          check TikTok Shop's Affiliate Center and
 *                          Shopee's dashboard before downloading.
 *   /queue <url>         — save a specific link into the review queue
 *                          as "queued" (e.g. one you found yourself)
 *   /list                — show what's currently queued
 *   /status              — health check: what's configured, what's not,
 *                          and current queue/schedule counts
 *   /help                — show available commands
 *
 * Setup: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your env, then
 * call POST /api/admin/telegram/set-webhook (see index.js) once so
 * Telegram knows where to send updates. See .env.example for details.
 */

const videoScraper = require('./videoScraper');
const videoSearch = require('./videoSearch');
const db = require('./db');
const socialPoster = require('./socialPoster');
const scheduler = require('./scheduler');
const emailSender = require('./emailSender');
const smsSender = require('./smsSender');

const TELEGRAM_API = (token) => `https://api.telegram.org/bot${token}`;

function getConfig() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN,
    allowedChatId: process.env.TELEGRAM_CHAT_ID, // restrict who can issue commands
  };
}

async function sendMessage(chatId, text, options = {}) {
  const { token } = getConfig();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set.' };
  try {
    const res = await fetch(`${TELEGRAM_API(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: options.disablePreview !== false,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('[telegramBot] sendMessage failed:', err.message);
    return { ok: false, error: err.message };
  }
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Command handlers ----------

async function handleScrape(chatId, keyword) {
  if (!keyword) {
    await sendMessage(chatId, 'Usage: <code>/scrape 18k gold pawnable</code> — tell me what to search for on TikTok.');
    return;
  }

  await sendMessage(chatId, `🔍 Searching TikTok for "<b>${esc(keyword)}</b>"…`);

  const search = await videoSearch.searchVideos(keyword, { limit: 8 });

  if (!search.ok) {
    await sendMessage(chatId, `❌ Search failed: ${esc(search.error)}`);
    return;
  }

  if (search.manual) {
    // No search API configured — send manual search links instead.
    const lines = search.searchUrls.map(s => `• <a href="${esc(s.url)}">${esc(s.label)}</a>`).join('\n');
    await sendMessage(
      chatId,
      `⚠️ Auto-search isn't configured yet (no SEARCH_API_KEY).\n\nHere are manual search links for "<b>${esc(keyword)}</b>" instead:\n\n${lines}\n\nOpen one, find a video you like, then send me its URL with <code>/queue &lt;url&gt;</code>.`
    );
    return;
  }

  if (search.results.length === 0) {
    await sendMessage(chatId, `No TikTok results found for "<b>${esc(keyword)}</b>". Try a different keyword.`);
    return;
  }

  // Save all results to the queue as "queued" (unreviewed) and list them.
  const queued = [];
  for (const r of search.results) {
    const result = await videoScraper.queueRecommendation({
      videoUrl: r.link,
      title: r.title,
      description: r.snippet,
      platform: r.source,
      searchKeyword: keyword,
    });
    if (result.ok) queued.push({ ...r, id: result.id });
  }

  if (queued.length === 0) {
    await sendMessage(chatId, `Found ${search.results.length} result(s) but none saved to the queue (duplicates or invalid URLs?).`);
    return;
  }

  const lines = queued.map((r, i) =>
    `${i + 1}. <b>${esc(r.title)}</b>\n   TikTok · <a href="${esc(r.link)}">open</a> · queue #${r.id}`
  ).join('\n\n');

  const verifyLines = (search.verificationLinks || [])
    .map(v => `• <a href="${esc(v.url)}">${esc(v.label)}</a>`)
    .join('\n');

  await sendMessage(
    chatId,
    `✅ Found ${queued.length} candidate(s) for "<b>${esc(keyword)}</b>" — saved to your review queue:\n\n${lines}\n\n` +
    `<b>⚠️ Before downloading any of these:</b> search can't confirm commission status — that only lives inside each platform's own dashboard. Check the product has an active commission here:\n${verifyLines}\n\n` +
    `Once confirmed, download with SnapTik/SSSTik and upload in <code>/admin/videos.html</code> → Warm-Up &amp; Schedule tab.`
  );
}

async function handleQueue(chatId, url) {
  if (!url) {
    await sendMessage(chatId, 'Usage: <code>/queue https://www.tiktok.com/@user/video/123</code>');
    return;
  }
  const result = await videoScraper.queueRecommendation({ videoUrl: url, searchKeyword: null });
  if (!result.ok) {
    await sendMessage(chatId, `❌ Couldn't queue that link: ${esc(result.error || 'unknown error')}`);
    return;
  }
  await sendMessage(chatId, `✅ Queued (#${result.id}). Review it in the admin dashboard when you're ready to download.`);
}

async function handleList(chatId) {
  const videos = await videoScraper.listVideos({ status: 'queued', limit: 10 });
  if (videos.length === 0) {
    await sendMessage(chatId, 'Your queue is empty. Run <code>/scrape &lt;keyword&gt;</code> to find candidates.');
    return;
  }
  const lines = videos.map((v, i) =>
    `${i + 1}. <b>${esc(v.title || v.video_url)}</b>\n   ${esc(v.platform)} · <a href="${esc(v.video_url)}">open</a> · #${v.id}`
  ).join('\n\n');
  await sendMessage(chatId, `📋 Queued (${videos.length} shown, newest first):\n\n${lines}`);
}

async function handleStatus(chatId) {
  const checks = [];

  // Database
  checks.push(db.enabled
    ? '✅ Database — connected'
    : '❌ Database — not connected (DATABASE_URL not set, nothing persists)');

  // Search provider
  checks.push(process.env.SEARCH_API_KEY
    ? '✅ Web search — Serper.dev configured (auto-search enabled)'
    : '⚠️ Web search — not configured (/scrape falls back to manual search links)');

  // Email/SMS providers (opt-in nurture sequence + price alerts)
  checks.push(emailSender.isConfigured()
    ? '✅ Email (Resend) — configured'
    : '❌ Email (Resend) — not configured (nurture emails and price-alert emails won\'t send)');
  checks.push(smsSender.isConfigured()
    ? '✅ SMS (Semaphore) — configured'
    : '❌ SMS (Semaphore) — not configured (welcome texts and price-alert SMS won\'t send)');

  // Social platforms
  const platforms = socialPoster.getPlatformStatus();
  const platformLines = Object.entries(platforms).map(([name, s]) => {
    const icon = s.mode === 'api' ? '✅' : s.mode === 'manual' ? '⚠️' : '❌';
    let label;
    if (s.mode === 'api') label = s.via === 'buffer' ? 'connected via Buffer' : 'connected (raw API)';
    else if (s.mode === 'manual') label = 'manual/copy only';
    else label = 'not configured';
    return `${icon} ${name[0].toUpperCase()}${name.slice(1)} — ${label}`;
  });

  // Scheduler + queue counts
  let queueCount = 0, pendingCount = 0;
  try {
    const queued = await videoScraper.listVideos({ status: 'queued', limit: 200 });
    queueCount = queued.length;
  } catch (_) {}
  try {
    const pending = await scheduler.listScheduled({ status: 'pending', limit: 200 });
    pendingCount = pending.length;
  } catch (_) {}

  checks.push(`\n<b>Social platforms:</b>\n${platformLines.join('\n')}`);
  checks.push(`\n<b>Right now:</b>\n📋 ${queueCount} video(s) queued for review\n⏰ ${pendingCount} scheduled post(s) pending`);
  checks.push(`\n<b>Scheduler:</b> checking every ${esc(process.env.SCHEDULER_CRON || '*/5 * * * *')} (cron)`);

  await sendMessage(chatId, `<b>🩺 System Status</b>\n\n${checks.join('\n')}`);
}

async function handleHelp(chatId) {
  await sendMessage(
    chatId,
    `<b>Riolendel Scraper Bot</b>\n\n` +
    `<code>/scrape 18k gold pawnable</code>\n  Search TikTok for candidate videos, biased toward TikTok Shop-tagged content. Results are saved to your review queue, not downloaded. Commission status still needs manual verification in TikTok Shop's Affiliate Center and Shopee's affiliate dashboard.\n\n` +
    `<code>/queue &lt;url&gt;</code>\n  Manually add a specific video link you found yourself to the queue.\n\n` +
    `<code>/list</code>\n  Show what's currently in the queue.\n\n` +
    `<code>/status</code>\n  Health check — what's configured, what's not, queue and schedule counts.\n\n` +
    `Downloading and posting always stays manual — this bot only searches and organizes. Open <code>/admin/videos.html</code> to download, upload, and schedule.`
  );
}

// ---------- Update dispatcher ----------

/** Called by the webhook route in index.js with the raw Telegram update body. */
async function handleUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const { allowedChatId } = getConfig();

  // Restrict to a specific chat if configured — prevents strangers who
  // find your bot from triggering searches or filling your queue.
  if (allowedChatId && String(chatId) !== String(allowedChatId)) {
    await sendMessage(chatId, "Sorry, this bot is private.");
    return;
  }

  const text = message.text.trim();
  const [command, ...rest] = text.split(' ');
  const arg = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case '/scrape':
      await handleScrape(chatId, arg);
      break;
    case '/queue':
      await handleQueue(chatId, arg);
      break;
    case '/list':
      await handleList(chatId);
      break;
    case '/status':
      await handleStatus(chatId);
      break;
    case '/start':
    case '/help':
      await handleHelp(chatId);
      break;
    default:
      await sendMessage(chatId, `Unknown command. Try <code>/help</code>.`);
  }
}

/** Registers the webhook URL with Telegram — call once after deploying. */
async function setWebhook(publicUrl) {
  const { token } = getConfig();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set.' };
  try {
    const res = await fetch(`${TELEGRAM_API(token)}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: publicUrl }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { handleUpdate, setWebhook, sendMessage };
