/**
 * Video Search — finds publicly discoverable videos/posts matching a
 * keyword (e.g. "18k gold pawnable"), for human review. This does NOT
 * download or scrape any video content — it only returns links, titles,
 * and snippets, the same as a search engine results page would.
 *
 * Provider: Serper.dev (a thin wrapper around Google Search results,
 * cheap — ~$0.001/search on the free-to-start plan). Swap in any other
 * provider by changing searchWeb() below; the rest of the pipeline
 * (Telegram formatting, DB queueing) doesn't care which one you use.
 *
 * If no SEARCH_API_KEY is configured, falls back to returning ready-
 * made search URLs the admin can open manually in a browser — so the
 * feature still "works" (in the sense of being usable) with zero
 * additional signup, just without auto-fetched results.
 */

const SERPER_URL = 'https://google.serper.dev/search';

function buildManualSearchUrls(keyword) {
  const q = encodeURIComponent(keyword);
  return [
    { label: 'TikTok search', url: `https://www.tiktok.com/search?q=${q}` },
    { label: 'Shopee search', url: `https://shopee.ph/search?keyword=${q}` },
    { label: 'Google (site:tiktok.com)', url: `https://www.google.com/search?q=site:tiktok.com+${q}` },
  ];
}

/**
 * Search the web for a keyword, biased toward TikTok/Shopee results.
 * Returns { ok, results: [{title, link, snippet, source}], manual }.
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
    // Run two queries: one biased to TikTok, one to Shopee, merge results.
    const queries = [
      `site:tiktok.com ${cleanKeyword}`,
      `site:shopee.ph ${cleanKeyword}`,
    ];

    const allResults = [];
    for (const q of queries) {
      const res = await fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: Math.ceil(limit / queries.length) }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const organic = data.organic || [];
      for (const item of organic) {
        allResults.push({
          title: item.title || '(untitled)',
          link: item.link,
          snippet: item.snippet || '',
          source: /tiktok\.com/i.test(item.link) ? 'tiktok' : /shopee\./i.test(item.link) ? 'shopee' : 'other',
        });
      }
    }

    return { ok: true, manual: false, results: allResults.slice(0, limit) };
  } catch (err) {
    return { ok: false, error: `Search failed: ${err.message}` };
  }
}

module.exports = { searchVideos, buildManualSearchUrls };
