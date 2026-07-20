/**
 * Video Search — finds publicly discoverable TikTok videos matching a
 * keyword (e.g. "18k gold pawnable"), for human review. This does NOT
 * download or scrape any video content — it only returns links, titles,
 * and snippets, the same as a search engine results page would.
 *
 * Scoped to TikTok only, biased toward TikTok Shop-tagged content (videos
 * with a product attached via TikTok Shop are inherently commission-
 * eligible — that's how the creator program works).
 *
 * IMPORTANT — "verified commission" isn't something a web search can
 * check. Whether a specific product actually has an active commission
 * on TikTok Shop or Shopee lives inside each platform's own affiliate
 * dashboard, not in public search results. So this module surfaces
 * candidates; a manual check in TikTok Shop's Affiliate Center and
 * Shopee's Affiliate dashboard is still required before you queue or
 * download anything — same as verifying rights/relevance already was.
 *
 * Provider: Serper.dev (a thin wrapper around Google Search results,
 * cheap — ~$0.001/search on the free-to-start plan). Swap in any other
 * provider by changing searchVideos() below; the rest of the pipeline
 * (Telegram formatting, DB queueing) doesn't care which one you use.
 *
 * If no SEARCH_API_KEY is configured, falls back to returning ready-
 * made search URLs the admin can open manually in a browser — so the
 * feature still "works" (in the sense of being usable) with zero
 * additional signup, just without auto-fetched results.
 */

const SERPER_URL = 'https://google.serper.dev/search';

// Where to manually confirm a product's commission is actually live,
// per platform — these are reference links, not search results.
const VERIFICATION_LINKS = [
  { label: 'TikTok Shop Affiliate Center (check commission)', url: 'https://affiliate.tiktokshop.com' },
  { label: 'Shopee Affiliate Dashboard (check commission)', url: 'https://affiliate.shopee.ph' },
];

function buildManualSearchUrls(keyword) {
  const q = encodeURIComponent(keyword);
  return [
    { label: 'TikTok search', url: `https://www.tiktok.com/search?q=${q}` },
    { label: 'TikTok search (Shop-tagged)', url: `https://www.tiktok.com/search?q=${encodeURIComponent(keyword + ' tiktok shop')}` },
    { label: 'Google (site:tiktok.com)', url: `https://www.google.com/search?q=site:tiktok.com+${q}` },
    ...VERIFICATION_LINKS,
  ];
}

/**
 * Search TikTok for a keyword, biased toward TikTok Shop-tagged content.
 * Returns { ok, results: [{title, link, snippet, source}], manual,
 * verificationLinks }.
 */
async function searchVideos(keyword, { limit = 8 } = {}) {
  const apiKey = process.env.SEARCH_API_KEY;
  const cleanKeyword = String(keyword || '').trim();
  if (!cleanKeyword) return { ok: false, error: 'No keyword provided.' };

  if (!apiKey) {
    // No search provider configured — return manual search links instead.
    return {
      ok: true,
      manual: true,
      searchUrls: buildManualSearchUrls(cleanKeyword),
      results: [],
      note: 'SEARCH_API_KEY not set — showing manual search links instead of auto-fetched results. See .env.example to enable auto-search.',
    };
  }

  try {
    // TikTok only. Biasing the query toward "tiktok shop" surfaces
    // Shop-tagged videos more often — those are the ones with an
    // actual commission structure attached, as opposed to a random
    // TikTok video that merely shows gold jewelry with no product link.
    const q = `site:tiktok.com ${cleanKeyword} tiktok shop`;

    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: limit }),
    });

    if (!res.ok) {
      return { ok: false, error: `Search request failed (${res.status}).` };
    }

    const data = await res.json();
    const organic = data.organic || [];
    const results = organic
      .filter(item => /tiktok\.com/i.test(item.link || ''))
      .map(item => ({
        title: item.title || '(untitled)',
        link: item.link,
        snippet: item.snippet || '',
        source: 'tiktok',
      }))
      .slice(0, limit);

    return { ok: true, manual: false, results, verificationLinks: VERIFICATION_LINKS };
  } catch (err) {
    return { ok: false, error: `Search failed: ${err.message}` };
  }
}

module.exports = { searchVideos, buildManualSearchUrls };
