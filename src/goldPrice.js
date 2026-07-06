const cron = require('node-cron');
const db = require('./db');

// In-memory cache, backed by Postgres if available. Every visitor's
// request hits this cache, never GoldAPI.io directly — so your GoldAPI
// usage stays fixed at ~1-2 calls/day no matter how much traffic the
// site gets.
let cache = {
  price: null,
  changePct: 0,
  fetchedAt: null,
  fallback: true,
};

async function fetchFromGoldApi() {
  const apiKey = process.env.GOLDAPI_KEY;
  if (!apiKey) {
    console.warn('[gold-price] GOLDAPI_KEY not set — skipping fetch, ticker will show fallback data.');
    return;
  }

  try {
    const res = await fetch('https://www.goldapi.io/api/XAU/USD', {
      headers: { 'x-access-token': apiKey, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`GoldAPI responded ${res.status}`);
    const data = await res.json();
    if (!data.price) throw new Error('GoldAPI response missing price');

    cache = {
      price: data.price,
      changePct: data.chp || 0,
      fetchedAt: new Date().toISOString(),
      fallback: false,
    };
    await db.saveGoldPrice({ price: data.price, changePct: data.chp || 0 });
    console.log(`[gold-price] Updated: $${data.price}/oz (${data.chp}% )`);
  } catch (err) {
    console.error('[gold-price] Fetch failed, keeping last known price:', err.message);
    // Deliberately does NOT clear the cache — a failed fetch should
    // never wipe out the last good price, it should just try again
    // at the next scheduled run.
  }
}

async function init() {
  // On boot, try to restore the last known price from Postgres so a
  // redeploy doesn't show fallback data until the next cron tick.
  const persisted = await db.loadGoldPrice();
  if (persisted && persisted.price) {
    cache = {
      price: persisted.price,
      changePct: persisted.changePct,
      fetchedAt: persisted.fetchedAt,
      fallback: false,
    };
    console.log('[gold-price] Restored cached price from database.');
  } else {
    // No cached price anywhere yet — fetch once immediately so the
    // ticker has real data right after first deploy.
    await fetchFromGoldApi();
  }

  const schedule = process.env.GOLD_PRICE_CRON || '0 1 * * *'; // once daily, 01:00 UTC by default
  cron.schedule(schedule, fetchFromGoldApi);
  console.log(`[gold-price] Scheduled fetch: "${schedule}" (keep this to 1-2 times/day max — GoldAPI's free plan is ~100 requests/month)`);
}

function getCached() {
  return cache;
}

module.exports = { init, getCached, fetchFromGoldApi };
