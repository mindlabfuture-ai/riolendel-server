const cron = require('node-cron');
const db = require('./db');

// Curated list of outlets we consider reputable enough to surface.
// Currents API aggregates 14,000+ sources, including plenty of low-quality
// ones — filtering by domain keeps this section credible.
const TRUSTED_DOMAINS = new Set([
  'reuters.com', 'bloomberg.com', 'marketwatch.com', 'cnbc.com',
  'forbes.com', 'apnews.com', 'wsj.com', 'ft.com', 'businessinsider.com',
  'investing.com', 'kitco.com', 'finance.yahoo.com', 'yahoo.com',
  'theguardian.com', 'bbc.com', 'bbc.co.uk',
]);

let cache = { articles: [], fetchedAt: null };

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function fetchFromCurrentsApi() {
  const apiKey = process.env.CURRENTS_API_KEY;
  if (!apiKey) {
    console.warn('[gold-news] CURRENTS_API_KEY not set — skipping fetch.');
    return;
  }

  try {
    const url = 'https://api.currentsapi.services/v1/search?keywords=gold%20price&language=en&page_size=30';
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error(`Currents API responded ${res.status}`);
    const data = await res.json();
    const raw = Array.isArray(data.news) ? data.news : [];

    const curated = raw
      .map(a => ({
        title: a.title,
        description: (a.description || '').slice(0, 220),
        url: a.url,
        domain: extractDomain(a.url),
        published: a.published,
      }))
      .filter(a => TRUSTED_DOMAINS.has(a.domain) && a.title && a.url)
      .slice(0, 6);

    if (curated.length === 0) {
      console.warn('[gold-news] Fetch succeeded but no articles matched the trusted-domain list — keeping previous cache.');
      return;
    }

    cache = { articles: curated, fetchedAt: new Date().toISOString() };
    await db.saveNewsCache(curated);
    console.log(`[gold-news] Updated: ${curated.length} articles from trusted sources.`);
  } catch (err) {
    console.error('[gold-news] Fetch failed, keeping last known articles:', err.message);
    // Deliberately does not clear the cache on failure — same principle
    // as goldPrice.js: a bad fetch should never wipe out good data.
  }
}

async function init() {
  const persisted = await db.loadNewsCache();
  if (persisted && persisted.articles && persisted.articles.length) {
    cache = { articles: persisted.articles, fetchedAt: persisted.fetchedAt };
    console.log('[gold-news] Restored cached articles from database.');
  } else {
    await fetchFromCurrentsApi();
  }

  const schedule = process.env.GOLD_NEWS_CRON || '30 1 * * *'; // once daily, offset from the price fetch
  cron.schedule(schedule, fetchFromCurrentsApi);
  console.log(`[gold-news] Scheduled fetch: "${schedule}"`);
}

function getCached() {
  return cache;
}

module.exports = { init, getCached, fetchFromCurrentsApi };
