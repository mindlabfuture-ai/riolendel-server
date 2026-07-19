const { Pool } = require('pg');

// Railway injects DATABASE_URL automatically once you attach a Postgres
// plugin to your project. Locally, without one, db.enabled will be
// false and the app falls back to storing nothing (opt-ins still get
// validated and accepted, just not persisted) — enough to develop the
// front end without needing Postgres installed on your machine.
const connectionString = process.env.DATABASE_URL;
const enabled = Boolean(connectionString);

const pool = enabled
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

async function init() {
  if (!enabled) {
    console.warn('[db] DATABASE_URL not set — running without persistence. Attach a Postgres plugin on Railway for production.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS optins (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      source TEXT NOT NULL DEFAULT 'landing_page',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(email)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_price_cache (
      id INT PRIMARY KEY DEFAULT 1,
      price NUMERIC,
      change_pct NUMERIC,
      fetched_at TIMESTAMPTZ,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  // Keeps a short rolling history so we can detect meaningful day-over-day
  // swings (see src/priceAlerts.js) without needing a paid historical API.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_price_history (
      id SERIAL PRIMARY KEY,
      price NUMERIC NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Caches gold-related headlines fetched once or twice a day from
  // Currents API — never fetched per-visitor. See src/goldNews.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gold_news_cache (
      id INT PRIMARY KEY DEFAULT 1,
      articles JSONB,
      fetched_at TIMESTAMPTZ,
      CONSTRAINT single_row_news CHECK (id = 1)
    );
  `);

  // Scraped video references — admin adds these manually, no auto-upload.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scraped_videos (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'tiktok',
      video_url TEXT NOT NULL UNIQUE,
      thumbnail_url TEXT,
      title TEXT,
      description TEXT,
      creator TEXT,
      tags TEXT[] DEFAULT '{}',
      product_links JSONB DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Affiliate product links — curated 18K gold items from Shopee / TikTok Shop
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliate_products (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      product_url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'necklace',
      price_php NUMERIC,
      image_url TEXT,
      karat TEXT DEFAULT '18K',
      description TEXT,
      affiliate_link TEXT,
      is_featured BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Cross-platform social post log — tracks every post attempt
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id SERIAL PRIMARY KEY,
      message TEXT,
      link TEXT,
      image_url TEXT,
      video_url TEXT,
      platforms JSONB NOT NULL DEFAULT '{}',
      source_type TEXT DEFAULT 'manual',
      source_id INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Scheduled posts — powers the warm-up-then-convert campaign flow.
  // Phase 1 = still-frame warm-up post (no link). Phase 2 = real video +
  // fresh affiliate link, fired 1-2 days later. Also supports plain
  // one-off scheduled posts (phase = NULL).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id SERIAL PRIMARY KEY,
      message TEXT,
      link TEXT,
      image_urls JSONB DEFAULT '[]',
      video_url TEXT,
      platforms JSONB NOT NULL DEFAULT '[]',
      phase INT,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_for TIMESTAMPTZ NOT NULL,
      executed_at TIMESTAMPTZ,
      results JSONB,
      source_video_id INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts (status, scheduled_for);`);

  // Opt-in nurture sequence — queued email/SMS steps for both live
  // landing-page signups and CSV-imported contacts. Each row is one
  // scheduled message; src/sequences.js enrolls contacts and a cron
  // tick sends whatever's due.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sequence_messages (
      id SERIAL PRIMARY KEY,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      channel TEXT NOT NULL,
      step INT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error TEXT,
      batch_source TEXT DEFAULT 'landing_page',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sequence_messages_due ON sequence_messages (status, scheduled_for);`);

  console.log('[db] Connected and tables ready.');
}

async function saveOptIn({ fullName, email, phone, channel, source }) {
  if (!enabled) return { persisted: false };
  try {
    await pool.query(
      `INSERT INTO optins (full_name, email, phone, channel, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, channel = EXCLUDED.channel`,
      [fullName, email, phone, channel || 'email', source || 'landing_page']
    );
    return { persisted: true };
  } catch (err) {
    console.error('[db] Failed to save opt-in:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function getSubscribers() {
  if (!enabled) return [];
  try {
    const res = await pool.query('SELECT full_name, email, phone, channel FROM optins');
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load subscribers:', err.message);
    return [];
  }
}

async function getSubscribersDetailed() {
  if (!enabled) return [];
  try {
    const res = await pool.query('SELECT full_name, email, phone, channel, source, created_at FROM optins ORDER BY created_at DESC');
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load detailed subscribers:', err.message);
    return [];
  }
}

async function recordPriceHistory(price) {
  if (!enabled) return;
  try {
    await pool.query('INSERT INTO gold_price_history (price) VALUES ($1)', [price]);
    // keep only the last ~90 days of daily rows so this table doesn't grow forever
    await pool.query(`
      DELETE FROM gold_price_history
      WHERE id NOT IN (SELECT id FROM gold_price_history ORDER BY recorded_at DESC LIMIT 90)
    `);
  } catch (err) {
    console.error('[db] Failed to record price history:', err.message);
  }
}

async function getPreviousPrice() {
  if (!enabled) return null;
  try {
    const res = await pool.query('SELECT price FROM gold_price_history ORDER BY recorded_at DESC OFFSET 1 LIMIT 1');
    return res.rows.length ? Number(res.rows[0].price) : null;
  } catch (err) {
    console.error('[db] Failed to load previous price:', err.message);
    return null;
  }
}

async function saveNewsCache(articles) {
  if (!enabled) return;
  try {
    await pool.query(
      `INSERT INTO gold_news_cache (id, articles, fetched_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET articles = $1, fetched_at = now()`,
      [JSON.stringify(articles)]
    );
  } catch (err) {
    console.error('[db] Failed to save news cache:', err.message);
  }
}

async function loadNewsCache() {
  if (!enabled) return null;
  try {
    const res = await pool.query('SELECT articles, fetched_at FROM gold_news_cache WHERE id = 1');
    if (res.rows.length === 0) return null;
    return { articles: res.rows[0].articles, fetchedAt: res.rows[0].fetched_at };
  } catch (err) {
    console.error('[db] Failed to load news cache:', err.message);
    return null;
  }
}

async function saveGoldPrice({ price, changePct }) {
  if (!enabled) return;
  try {
    await pool.query(
      `INSERT INTO gold_price_cache (id, price, change_pct, fetched_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET price = $1, change_pct = $2, fetched_at = now()`,
      [price, changePct]
    );
  } catch (err) {
    console.error('[db] Failed to save gold price cache:', err.message);
  }
}

async function loadGoldPrice() {
  if (!enabled) return null;
  try {
    const res = await pool.query('SELECT price, change_pct, fetched_at FROM gold_price_cache WHERE id = 1');
    if (res.rows.length === 0) return null;
    return {
      price: Number(res.rows[0].price),
      changePct: Number(res.rows[0].change_pct),
      fetchedAt: res.rows[0].fetched_at,
    };
  } catch (err) {
    console.error('[db] Failed to load gold price cache:', err.message);
    return null;
  }
}

// ---------- Scraped Videos ----------

async function saveVideo({ platform, videoUrl, thumbnailUrl, title, description, creator, tags, productLinks, notes }) {
  if (!enabled) return { persisted: false };
  try {
    const res = await pool.query(
      `INSERT INTO scraped_videos (platform, video_url, thumbnail_url, title, description, creator, tags, product_links, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (video_url) DO UPDATE SET
         thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, scraped_videos.thumbnail_url),
         title = COALESCE(EXCLUDED.title, scraped_videos.title),
         description = COALESCE(EXCLUDED.description, scraped_videos.description),
         creator = COALESCE(EXCLUDED.creator, scraped_videos.creator),
         tags = EXCLUDED.tags,
         product_links = EXCLUDED.product_links,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING id`,
      [platform || 'tiktok', videoUrl, thumbnailUrl || null, title || null, description || null, creator || null, tags || [], JSON.stringify(productLinks || []), notes || null]
    );
    return { persisted: true, id: res.rows[0].id };
  } catch (err) {
    console.error('[db] Failed to save video:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function getVideos({ status, platform, limit } = {}) {
  if (!enabled) return [];
  try {
    let where = [];
    let params = [];
    let i = 1;
    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (platform) { where.push(`platform = $${i++}`); params.push(platform); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = limit ? `LIMIT $${i++}` : '';
    if (limit) params.push(limit);
    const res = await pool.query(`SELECT * FROM scraped_videos ${clause} ORDER BY created_at DESC ${lim}`, params);
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load videos:', err.message);
    return [];
  }
}

async function updateVideoStatus(id, status) {
  if (!enabled) return false;
  try {
    await pool.query('UPDATE scraped_videos SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
    return true;
  } catch (err) {
    console.error('[db] Failed to update video status:', err.message);
    return false;
  }
}

async function deleteVideo(id) {
  if (!enabled) return false;
  try {
    await pool.query('DELETE FROM scraped_videos WHERE id = $1', [id]);
    return true;
  } catch (err) {
    console.error('[db] Failed to delete video:', err.message);
    return false;
  }
}

// ---------- Affiliate Products ----------

async function saveProduct({ platform, productUrl, title, category, pricePHP, imageUrl, karat, description, affiliateLink, isFeatured }) {
  if (!enabled) return { persisted: false };
  try {
    const res = await pool.query(
      `INSERT INTO affiliate_products (platform, product_url, title, category, price_php, image_url, karat, description, affiliate_link, is_featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (product_url) DO UPDATE SET
         title = EXCLUDED.title, category = EXCLUDED.category, price_php = EXCLUDED.price_php,
         image_url = EXCLUDED.image_url, karat = EXCLUDED.karat, description = EXCLUDED.description,
         affiliate_link = EXCLUDED.affiliate_link, is_featured = EXCLUDED.is_featured
       RETURNING id`,
      [platform, productUrl, title, category || 'necklace', pricePHP || null, imageUrl || null, karat || '18K', description || null, affiliateLink || null, isFeatured || false]
    );
    return { persisted: true, id: res.rows[0].id };
  } catch (err) {
    console.error('[db] Failed to save product:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function getProducts({ category, platform, featured, active } = {}) {
  if (!enabled) return [];
  try {
    let where = [];
    let params = [];
    let i = 1;
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (platform) { where.push(`platform = $${i++}`); params.push(platform); }
    if (featured !== undefined) { where.push(`is_featured = $${i++}`); params.push(featured); }
    if (active !== undefined) { where.push(`is_active = $${i++}`); params.push(active); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const res = await pool.query(`SELECT * FROM affiliate_products ${clause} ORDER BY is_featured DESC, created_at DESC`, params);
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load products:', err.message);
    return [];
  }
}

async function deleteProduct(id) {
  if (!enabled) return false;
  try {
    await pool.query('DELETE FROM affiliate_products WHERE id = $1', [id]);
    return true;
  } catch (err) {
    console.error('[db] Failed to delete product:', err.message);
    return false;
  }
}

// ---------- Social Posts ----------

async function saveSocialPost({ message, link, imageUrl, videoUrl, platforms, sourceType, sourceId }) {
  if (!enabled) return { persisted: false };
  try {
    const res = await pool.query(
      `INSERT INTO social_posts (message, link, image_url, video_url, platforms, source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [message || null, link || null, imageUrl || null, videoUrl || null, JSON.stringify(platforms || {}), sourceType || 'manual', sourceId || null]
    );
    return { persisted: true, id: res.rows[0].id };
  } catch (err) {
    console.error('[db] Failed to save social post:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function updateSocialPostPlatform(id, platform, result) {
  if (!enabled) return false;
  try {
    await pool.query(
      `UPDATE social_posts SET platforms = jsonb_set(COALESCE(platforms, '{}'), $1, $2) WHERE id = $3`,
      [`{${platform}}`, JSON.stringify(result), id]
    );
    return true;
  } catch (err) {
    console.error('[db] Failed to update social post platform:', err.message);
    return false;
  }
}

async function getSocialPosts({ limit } = {}) {
  if (!enabled) return [];
  try {
    const lim = limit ? `LIMIT ${parseInt(limit)}` : 'LIMIT 50';
    const res = await pool.query(`SELECT * FROM social_posts ORDER BY created_at DESC ${lim}`);
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load social posts:', err.message);
    return [];
  }
}

// ---------- Scheduled Posts (warm-up campaigns) ----------

async function saveScheduledPost({ message, link, imageUrls, videoUrl, platforms, scheduledFor, phase, sourceVideoId }) {
  if (!enabled) return { persisted: false };
  try {
    const res = await pool.query(
      `INSERT INTO scheduled_posts (message, link, image_urls, video_url, platforms, phase, scheduled_for, source_video_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [message || null, link || null, JSON.stringify(imageUrls || []), videoUrl || null, JSON.stringify(platforms || []), phase || null, scheduledFor, sourceVideoId || null]
    );
    return { persisted: true, id: res.rows[0].id };
  } catch (err) {
    console.error('[db] Failed to save scheduled post:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function getDuePosts() {
  if (!enabled) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM scheduled_posts WHERE status = 'pending' AND scheduled_for <= now() ORDER BY scheduled_for ASC LIMIT 20`
    );
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load due posts:', err.message);
    return [];
  }
}

async function completeScheduledPost(id, results, status) {
  if (!enabled) return false;
  try {
    await pool.query(
      `UPDATE scheduled_posts SET status = $1, results = $2, executed_at = now() WHERE id = $3`,
      [status || 'completed', JSON.stringify(results || {}), id]
    );
    return true;
  } catch (err) {
    console.error('[db] Failed to complete scheduled post:', err.message);
    return false;
  }
}

async function updateScheduledPostLink(id, newLink) {
  if (!enabled) return { ok: false };
  try {
    const res = await pool.query(
      `UPDATE scheduled_posts SET link = $1 WHERE id = $2 AND status = 'pending' RETURNING id`,
      [newLink, id]
    );
    if (res.rows.length === 0) return { ok: false, error: 'Post not found or already executed.' };
    return { ok: true };
  } catch (err) {
    console.error('[db] Failed to update scheduled link:', err.message);
    return { ok: false, error: err.message };
  }
}

async function cancelScheduledPost(id) {
  if (!enabled) return { ok: false };
  try {
    const res = await pool.query(
      `UPDATE scheduled_posts SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id]
    );
    if (res.rows.length === 0) return { ok: false, error: 'Post not found or already executed.' };
    return { ok: true };
  } catch (err) {
    console.error('[db] Failed to cancel scheduled post:', err.message);
    return { ok: false, error: err.message };
  }
}

async function getScheduledPosts({ status, limit } = {}) {
  if (!enabled) return [];
  try {
    const where = status ? `WHERE status = $1` : '';
    const params = status ? [status] : [];
    const lim = limit ? parseInt(limit) : 100;
    const res = await pool.query(
      `SELECT * FROM scheduled_posts ${where} ORDER BY scheduled_for DESC LIMIT ${lim}`,
      params
    );
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load scheduled posts:', err.message);
    return [];
  }
}

// ---------- Sequence Messages (opt-in nurture drip) ----------

async function enqueueSequenceMessage({ fullName, email, phone, channel, step, subject, body, scheduledFor, batchSource }) {
  if (!enabled) return { persisted: false };
  try {
    const res = await pool.query(
      `INSERT INTO sequence_messages (full_name, email, phone, channel, step, subject, body, scheduled_for, batch_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [fullName || null, email || null, phone || null, channel, step, subject || null, body, scheduledFor, batchSource || 'landing_page']
    );
    return { persisted: true, id: res.rows[0].id };
  } catch (err) {
    console.error('[db] Failed to enqueue sequence message:', err.message);
    return { persisted: false, error: err.message };
  }
}

async function getDueSequenceMessages(limit = 30) {
  if (!enabled) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM sequence_messages WHERE status = 'pending' AND scheduled_for <= now() ORDER BY scheduled_for ASC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load due sequence messages:', err.message);
    return [];
  }
}

async function markSequenceMessageSent(id, ok, error) {
  if (!enabled) return false;
  try {
    await pool.query(
      `UPDATE sequence_messages SET status = $1, sent_at = now(), error = $2 WHERE id = $3`,
      [ok ? 'sent' : 'failed', error || null, id]
    );
    return true;
  } catch (err) {
    console.error('[db] Failed to mark sequence message sent:', err.message);
    return false;
  }
}

async function getSequenceStats() {
  if (!enabled) return { pending: 0, sent: 0, failed: 0 };
  try {
    const res = await pool.query(
      `SELECT status, count(*)::int AS count FROM sequence_messages GROUP BY status`
    );
    const stats = { pending: 0, sent: 0, failed: 0 };
    for (const row of res.rows) stats[row.status] = row.count;
    return stats;
  } catch (err) {
    console.error('[db] Failed to load sequence stats:', err.message);
    return { pending: 0, sent: 0, failed: 0 };
  }
}

async function getSequenceMessages({ status, limit } = {}) {
  if (!enabled) return [];
  try {
    const where = status ? `WHERE status = $1` : '';
    const params = status ? [status] : [];
    const lim = limit ? parseInt(limit) : 100;
    const res = await pool.query(
      `SELECT * FROM sequence_messages ${where} ORDER BY scheduled_for DESC LIMIT ${lim}`,
      params
    );
    return res.rows;
  } catch (err) {
    console.error('[db] Failed to load sequence messages:', err.message);
    return [];
  }
}

/**
 * Bulk-import contacts from a parsed CSV (array of {fullName, email,
 * phone, channel}). Reuses the optins table (ON CONFLICT by email
 * updates instead of duplicating), tagged with source='csv_import'.
 * Returns { imported, skipped, rows: [...] } where rows are the
 * successfully-saved contacts, ready to hand to sequences.enrollContact.
 */
async function bulkImportContacts(contacts) {
  if (!enabled) return { imported: 0, skipped: contacts.length, rows: [] };
  const rows = [];
  let skipped = 0;
  for (const c of contacts) {
    if (!c.email && !c.phone) { skipped++; continue; }
    try {
      await pool.query(
        `INSERT INTO optins (full_name, email, phone, channel, source)
         VALUES ($1, $2, $3, $4, 'csv_import')
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, channel = EXCLUDED.channel`,
        [c.fullName || '', c.email || `no-email-${Date.now()}-${rows.length}@placeholder.local`, c.phone || '', c.channel || 'email']
      );
      rows.push(c);
    } catch (err) {
      console.error('[db] Failed to import contact:', c.email || c.phone, err.message);
      skipped++;
    }
  }
  return { imported: rows.length, skipped, rows };
}

module.exports = {
  enabled, init, saveOptIn, saveGoldPrice, loadGoldPrice, getSubscribers, getSubscribersDetailed,
  recordPriceHistory, getPreviousPrice, saveNewsCache, loadNewsCache,
  saveVideo, getVideos, updateVideoStatus, deleteVideo,
  saveProduct, getProducts, deleteProduct,
  saveSocialPost, updateSocialPostPlatform, getSocialPosts,
  saveScheduledPost, getDuePosts, completeScheduledPost, updateScheduledPostLink,
  cancelScheduledPost, getScheduledPosts,
  enqueueSequenceMessage, getDueSequenceMessages, markSequenceMessageSent,
  getSequenceStats, getSequenceMessages, bulkImportContacts,
};
