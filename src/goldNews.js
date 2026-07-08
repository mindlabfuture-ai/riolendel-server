const cron = require('node-cron');
const db = require('./db');

// Curated list of outlets we consider reputable enough to surface.
// Currents API aggregates 14,000+ sources, including plenty of low-quality
// ones — filtering by domain keeps this section credible. Kept broad on
// purpose: a narrow list means an "empty results" day whenever none of a
// handful of exact domains happen to cover gold that day.
const TRUSTED_DOMAINS = new Set([
  // Global financial/business press
  'reuters.com', 'bloomberg.com', 'marketwatch.com', 'cnbc.com',
  'forbes.com', 'apnews.com', 'wsj.com', 'ft.com', 'businessinsider.com',
  'investing.com', 'kitco.com', 'finance.yahoo.com', 'yahoo.com',
  'theguardian.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'npr.org',
  'aljazeera.com', 'channelnewsasia.com', 'economist.com', 'barrons.com',
  'nasdaq.com', 'fortune.com', 'axios.com', 'time.com',
  // Philippine outlets — relevant to this audience, and often cover gold
  // prices in a peso/BSP context that global outlets won't
  'inquirer.net', 'rappler.com', 'philstar.com', 'mb.com.ph',
  'bworldonline.com', 'gmanetwork.com', 'abs-cbn.com', 'pna.gov.ph',
  'manilatimes.net', 'bilyonaryo.com',
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
    const msg = 'CURRENTS_API_KEY not set — skipping fetch.';
    console.warn(`[gold-news] ${msg}`);
    return { ok: false, reason: msg };
  }

  try {
    // Use a boolean phrase query (not a bare "gold" keyword) so unrelated
    // results don't slip through just for containing the word "gold" —
    // e.g. arts/entertainment articles about "golden age" or brand names.
    const query = '("gold price" OR "gold prices" OR "gold market" OR bullion OR "gold reserves" OR "spot gold" OR "gold demand")';
    const url = `https://api.currentsapi.services/v1/search?query=${encodeURIComponent(query)}&language=en&page_size=20`;
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Currents API responded ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = Array.isArray(data.news) ? data.news : [];
    const sampleDomains = raw.slice(0, 10).map(a => extractDomain(a.url));
    console.log(`[gold-news] Raw results from Currents API: ${raw.length}`);
    if (raw.length > 0) console.log('[gold-news] Sample domains in raw results:', sampleDomains.join(', '));

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
      const msg = `Currents API returned ${raw.length} raw articles, but none matched the trusted-domain list. Sample domains seen: ${sampleDomains.join(', ') || '(none)'}`;
      console.warn(`[gold-news] ${msg} — keeping previous cache.`);
      return { ok: false, reason: msg, rawCount: raw.length, sampleDomains };
    }

    cache = { articles: curated, fetchedAt: new Date().toISOString() };
    await db.saveNewsCache(curated);
    console.log(`[gold-news] Updated: ${curated.length} articles from trusted sources.`);
    return { ok: true, rawCount: raw.length, curatedCount: curated.length };
  } catch (err) {
    console.error('[gold-news] Fetch failed, keeping last known articles:', err.message);
    // Deliberately does not clear the cache on failure — same principle
    // as goldPrice.js: a bad fetch should never wipe out good data.
    return { ok: false, reason: err.message };
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
