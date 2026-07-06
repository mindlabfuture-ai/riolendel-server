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

module.exports = { enabled, init, saveOptIn, saveGoldPrice, loadGoldPrice, getSubscribers, recordPriceHistory, getPreviousPrice };
