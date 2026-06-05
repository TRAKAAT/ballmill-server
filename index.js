const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_bags (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bm_sales (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bm_shifts (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bm_settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB tables ready');
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'ballmill' }));

app.get('/bags', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM bm_bags ORDER BY created_at DESC');
    res.json(rows.map(r => r.data));
  } catch (e) { console.error('GET /bags:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/bags', async (req, res) => {
  try {
    const bags = Array.isArray(req.body) ? req.body : [req.body];
    for (const bag of bags) {
      if (!bag.id) continue;
      await pool.query(
        `INSERT INTO bm_bags(id, data) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [bag.id, JSON.stringify(bag)]
      );
    }
    res.json({ ok: true, count: bags.length });
  } catch (e) { console.error('POST /bags:', e.message); res.status(500).json({ error: e.message }); }
});

app.delete('/bags/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bm_bags WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sales', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM bm_sales ORDER BY created_at DESC');
    res.json(rows.map(r => r.data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sales', async (req, res) => {
  try {
    const sales = Array.isArray(req.body) ? req.body : [req.body];
    for (const sale of sales) {
      if (!sale.id) continue;
      await pool.query(
        `INSERT INTO bm_sales(id, data) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET data=$2`,
        [sale.id, JSON.stringify(sale)]
      );
    }
    res.json({ ok: true, count: sales.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/shifts', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM bm_shifts ORDER BY created_at DESC');
    res.json(rows.map(r => r.data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/shifts', async (req, res) => {
  try {
    const shifts = Array.isArray(req.body) ? req.body : [req.body];
    for (const shift of shifts) {
      if (!shift.id) continue;
      await pool.query(
        `INSERT INTO bm_shifts(id, data) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET data=$2`,
        [shift.id, JSON.stringify(shift)]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, data FROM bm_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.data; });
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/settings', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, data] of entries) {
      await pool.query(
        `INSERT INTO bm_settings(key, data) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET data=$2, updated_at=NOW()`,
        [key, JSON.stringify(data)]
      );
    }
    res.json({ ok: true });
  } catch (e) { console.error('POST /settings:', e.message); res.status(500).json({ error: e.message }); }
});

// FULL SYNC
app.post('/sync', async (req, res) => {
  try {
    const { bags, sales, shifts, settings } = req.body;
    // Bags
    if (bags && bags.length) {
      for (const b of bags) {
        if (!b || !b.id) continue;
        await pool.query(
          `INSERT INTO bm_bags(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=$2,updated_at=NOW()`,
          [b.id, JSON.stringify(b)]
        );
      }
    }
    // Sales
    if (sales && sales.length) {
      for (const s of sales) {
        if (!s || !s.id) continue;
        await pool.query(
          `INSERT INTO bm_sales(id,data) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
          [s.id, JSON.stringify(s)]
        );
      }
    }
    // Shifts
    if (shifts && shifts.length) {
      for (const s of shifts) {
        if (!s || !s.id) continue;
        await pool.query(
          `INSERT INTO bm_shifts(id,data) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
          [s.id, JSON.stringify(s)]
        );
      }
    }
    // Settings - store each key separately
    if (settings && typeof settings === 'object') {
      for (const [key, data] of Object.entries(settings)) {
        if (data === undefined || data === null) continue;
        await pool.query(
          `INSERT INTO bm_settings(key,data) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET data=$2,updated_at=NOW()`,
          [key, JSON.stringify(data)]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// FULL PULL
app.get('/pull', async (req, res) => {
  try {
    const [bags, sales, shifts, settings] = await Promise.all([
      pool.query('SELECT data FROM bm_bags ORDER BY created_at DESC'),
      pool.query('SELECT data FROM bm_sales ORDER BY created_at DESC'),
      pool.query('SELECT data FROM bm_shifts ORDER BY created_at DESC'),
      pool.query('SELECT key, data FROM bm_settings')
    ]);
    const settingsObj = {};
    settings.rows.forEach(r => { settingsObj[r.key] = r.data; });
    res.json({
      bags: bags.rows.map(r => r.data),
      sales: sales.rows.map(r => r.data),
      shifts: shifts.rows.map(r => r.data),
      settings: settingsObj
    });
  } catch (e) {
    console.error('GET /pull error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('Ball Mill server running on port', PORT));
}).catch(e => {
  console.error('Failed to init DB:', e.message);
  process.exit(1);
});
