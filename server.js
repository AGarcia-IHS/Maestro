// Maestro prototype server: JSON API over SQLite + static front end. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, MONTHS, CLOSED_THROUGH, getMode } from './db.js';
import { listFolder, runImport } from './lib/importers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 4173;
const db = openDb();
const q = (sql) => db.prepare(sql);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const OPEN_MONTHS = MONTHS.filter((m) => m > CLOSED_THROUGH);

class Bad extends Error {}
const need = (cond, msg) => { if (!cond) throw new Bad(msg); };
const num = (v) => (v === '' || v == null ? null : Number(v));
const audit = (user, action, detail) => q('INSERT INTO audit (at, user, action, detail) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), user, action, detail);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---- campaign name matching ------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const grams = (s) => { const t = norm(s).replace(/ /g, ''); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
function similarity(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const g of A) if (B.has(g)) hit++;
  const dice = (2 * hit) / (A.size + B.size);
  const ta = norm(a).split(' '), tb = new Set(norm(b).split(' '));
  const tokens = ta.filter((t) => t.length > 2 && tb.has(t)).length / Math.max(1, ta.length);
  // "LSA" should find "Local Services Ads": credit a token that spells the other name's initials.
  const initials = (s) => norm(s).split(' ').map((w) => w[0]).join('');
  const acronym = ta.some((t) => t.length > 2 && t === initials(b)) || [...tb].some((t) => t.length > 2 && t === initials(a)) ? 0.5 : 0;
  return Math.min(1, dice * 0.7 + tokens * 0.3 + acronym + (norm(b).includes(norm(a)) || norm(a).includes(norm(b)) ? 0.15 : 0));
}

// ---- projected spend helpers -----------------------------------------------
function campaignLocations(campaignId, locationId) {
  const c = q('SELECT brand_id, location_ids FROM campaign WHERE id = ?').get(campaignId);
  need(c, 'Campaign not found');
  if (locationId) return [locationId];
  const used = q('SELECT DISTINCT location_id id FROM spend WHERE campaign_id = ?').all(campaignId).map((r) => r.id);
  if (used.length) return used;
  if (c.location_ids) return JSON.parse(c.location_ids);
  return q('SELECT id FROM location WHERE brand_id = ?').all(c.brand_id).map((r) => r.id);
}
function projectedTotal(campaignId, month, locs) {
  return q(`SELECT COALESCE(SUM(projected), 0) t FROM spend WHERE campaign_id = ? AND month = ? AND location_id IN (${locs.join(',')})`).get(campaignId, month).t;
}
// Set a campaign's projected spend for one open month, spread across locations in proportion to budget.
function setProjected(campaignId, month, amount, locationId) {
  need(OPEN_MONTHS.includes(month), 'Only open months can be re-forecast');
  need(Number.isFinite(amount) && amount >= 0, 'Amount must be zero or more');
  const locs = campaignLocations(campaignId, locationId);
  const weights = locs.map((l) => q('SELECT budget FROM spend WHERE campaign_id = ? AND location_id = ? AND month = ?').get(campaignId, l, month)?.budget || 0);
  const total = weights.reduce((a, b) => a + b, 0);
  let left = Math.round(amount);
  locs.forEach((l, i) => {
    const share = i === locs.length - 1 ? left : Math.round(amount * (total ? weights[i] / total : 1 / locs.length));
    left -= share;
    q(`INSERT INTO spend (campaign_id, location_id, month, budget, actual, projected) VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT (campaign_id, location_id, month) DO UPDATE SET projected = excluded.projected`).run(campaignId, l, month, share);
  });
}

// ---- API -------------------------------------------------------------------
const routes = {
  'GET /api/meta': () => ({
    brands: q('SELECT * FROM brand ORDER BY id').all(),
    locations: q('SELECT * FROM location ORDER BY id').all(),
    channels: q('SELECT * FROM channel ORDER BY sort').all(),
    level1: q('SELECT * FROM level1 ORDER BY id').all(),
    months: MONTHS, closedThrough: CLOSED_THROUGH, mode: getMode(db),
  }),

  'GET /api/facts': ({ query }) => {
    const p = { brand: num(query.brand), location: num(query.location) };
    return {
      campaigns: q('SELECT id, brand_id, level1_id, name, vendor, source, status FROM campaign WHERE (:brand IS NULL OR brand_id = :brand)').all({ brand: p.brand }),
      spend: q(`SELECT s.campaign_id, s.month, SUM(s.budget) budget, SUM(s.actual) actual, SUM(s.projected) projected
                FROM spend s JOIN location l ON l.id = s.location_id
                WHERE (:brand IS NULL OR l.brand_id = :brand) AND (:location IS NULL OR l.id = :location)
                GROUP BY s.campaign_id, s.month`).all(p),
      crm: q(`SELECT n.campaign_id, f.month, SUM(f.leads) leads, SUM(f.appts) appts, SUM(f.sales) sales, SUM(f.bookings) bookings
              FROM crm_fact f JOIN crm_name n ON n.id = f.crm_name_id JOIN location l ON l.id = f.location_id
              WHERE (:brand IS NULL OR l.brand_id = :brand) AND (:location IS NULL OR l.id = :location)
              GROUP BY n.campaign_id, f.month`).all(p),
      gl: q('SELECT month, level1_id, SUM(amount) amount FROM gl WHERE (:brand IS NULL OR brand_id = :brand) AND (:location IS NULL OR location_id = :location) GROUP BY month, level1_id').all(p),
    };
  },

  'POST /api/projected': ({ body, user }) => tx(() => {
    const before = projectedTotal(body.campaign_id, body.month, campaignLocations(body.campaign_id, num(body.location_id)));
    setProjected(body.campaign_id, body.month, Number(body.amount), num(body.location_id));
    const c = q('SELECT name FROM campaign WHERE id = ?').get(body.campaign_id);
    audit(user, 'reforecast', `${c.name} ${body.month}: $${Math.round(before)} → $${Math.round(body.amount)}`);
    return { ok: true };
  }),

  'POST /api/reallocate': ({ body, user }) => tx(() => {
    const amount = Number(body.amount), loc = num(body.location_id);
    need(body.from !== body.to, 'Pick two different campaigns');
    need(amount > 0, 'Amount must be more than zero');
    const brandOf = (id) => q('SELECT brand_id FROM campaign WHERE id = ?').get(id)?.brand_id;
    need(brandOf(body.from) && brandOf(body.from) === brandOf(body.to), 'Both campaigns must belong to the same brand');
    const fromNow = projectedTotal(body.from, body.month, campaignLocations(body.from, loc));
    const toNow = projectedTotal(body.to, body.month, campaignLocations(body.to, loc));
    need(amount <= fromNow, `Only $${Math.round(fromNow)} is projected on the source campaign for that month`);
    setProjected(body.from, body.month, fromNow - amount, loc);
    setProjected(body.to, body.month, toNow + amount, loc);
    const name = (id) => q('SELECT name FROM campaign WHERE id = ?').get(id).name;
    audit(user, 'reallocate', `${body.month}: moved $${Math.round(amount)} from ${name(body.from)} to ${name(body.to)}`);
    return { ok: true };
  }),

  'GET /api/campaigns': ({ query }) =>
    q(`SELECT c.*, b.name brand, l.name level1 FROM campaign c JOIN brand b ON b.id = c.brand_id JOIN level1 l ON l.id = c.level1_id
       WHERE (:brand IS NULL OR c.brand_id = :brand) ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, c.id DESC`).all({ brand: num(query.brand) }),

  'POST /api/campaigns': ({ body, user }) => tx(() => {
    const brand = q('SELECT * FROM brand WHERE id = ?').get(body.brand_id);
    const l1 = q('SELECT * FROM level1 WHERE id = ?').get(body.level1_id);
    need(brand && l1, 'Brand and Level 1 are required');
    need(body.descriptor?.trim(), 'A short campaign descriptor is required');
    need(MONTHS.includes(body.start_month) && MONTHS.includes(body.end_month) && body.start_month <= body.end_month, 'Pick a valid service period');
    need(Array.isArray(body.location_ids) && body.location_ids.length, 'Pick at least one market location');
    const clean = (s) => s.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const name = `${brand.code}_${clean(l1.name)}_${clean(body.descriptor)}_${body.start_month.slice(0, 4)}`;
    need(!q('SELECT 1 FROM campaign WHERE brand_id = ? AND lower(name) = lower(?)').get(brand.id, name), `A campaign named ${name} already exists`);
    const id = q(`INSERT INTO campaign (brand_id, level1_id, name, vendor, source, status, start_month, end_month, monthly_spend, exp_appts, exp_bookings, location_ids, landing_url, created_by, created_at)
                  VALUES (?, ?, ?, ?, 'manual', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(brand.id, l1.id, name, body.vendor || null, body.start_month, body.end_month, Number(body.monthly_spend) || 0, Number(body.exp_appts) || 0,
        Number(body.exp_bookings) || 0, JSON.stringify(body.location_ids.map(Number)), body.landing_url || null, user, new Date().toISOString()).lastInsertRowid;
    audit(user, 'campaign requested', name);
    return { id, name };
  }),

  'POST /api/campaigns/decide': ({ body, user, role }) => tx(() => {
    need(role === 'approver', 'Only an approver can approve or reject campaigns');
    const c = q('SELECT * FROM campaign WHERE id = ?').get(body.id);
    need(c?.status === 'pending', 'Campaign is not awaiting approval');
    need(['approved', 'rejected'].includes(body.decision), 'Unknown decision');
    q('UPDATE campaign SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(body.decision, user, new Date().toISOString(), body.note || null, c.id);
    if (body.decision === 'approved') {
      // Approved plan becomes projected spend for the open months of its service period.
      for (const m of OPEN_MONTHS.filter((m) => m >= c.start_month && m <= c.end_month)) setProjected(c.id, m, c.monthly_spend, null);
    }
    audit(user, `campaign ${body.decision}`, c.name + (body.note ? ` — ${body.note}` : ''));
    return { ok: true };
  }),

  'POST /api/campaigns/push': ({ body, user }) => tx(() => {
    const c = q('SELECT * FROM campaign WHERE id = ?').get(body.id);
    need(c?.status === 'approved', 'Only approved campaigns can be pushed to the CRM');
    const base = c.landing_url || 'https://example.com/offer';
    const url = `${base}${base.includes('?') ? '&' : '?'}utm_campaign=${encodeURIComponent(c.name)}&utm_id=M${c.id}`;
    const phone = `(555) 01${String(c.id % 100).padStart(2, '0')}-${String(1000 + ((c.id * 7919) % 9000))}`;
    q("UPDATE campaign SET status = 'live', tracking_url = ?, tracking_phone = ?, crm_pushed_at = ? WHERE id = ?").run(url, phone, new Date().toISOString(), c.id);
    q("INSERT INTO crm_name (brand_id, raw_name, campaign_id, status, first_seen) VALUES (?, ?, ?, 'mapped', ?)").run(c.brand_id, c.name, c.id, new Date().toISOString().slice(0, 10));
    audit(user, 'campaign pushed to CRM (simulated)', c.name);
    return { ok: true };
  }),

  'GET /api/mappings': ({ query }) => {
    const brand = num(query.brand);
    const names = q(`SELECT n.id, n.brand_id, b.name brand, n.raw_name, n.campaign_id, n.status, n.first_seen, c.name campaign,
                            COALESCE(SUM(f.leads), 0) leads, COALESCE(SUM(f.bookings), 0) bookings
                     FROM crm_name n JOIN brand b ON b.id = n.brand_id LEFT JOIN campaign c ON c.id = n.campaign_id LEFT JOIN crm_fact f ON f.crm_name_id = n.id
                     WHERE (:brand IS NULL OR n.brand_id = :brand) GROUP BY n.id ORDER BY leads DESC`).all({ brand });
    const byBrand = {};
    for (const c of q("SELECT id, brand_id, name FROM campaign WHERE status IN ('live', 'approved')").all()) (byBrand[c.brand_id] ||= []).push(c);
    for (const n of names) {
      if (n.status !== 'open') continue;
      n.suggestions = (byBrand[n.brand_id] || []).map((c) => ({ id: c.id, name: c.name, confidence: Math.round(similarity(n.raw_name, c.name) * 100) }))
        .filter((s) => s.confidence >= 40).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    }
    return names;
  },

  'POST /api/mappings': ({ body, user }) => tx(() => {
    const n = q('SELECT * FROM crm_name WHERE id = ?').get(body.id);
    need(n, 'CRM name not found');
    if (body.status === 'fix_in_crm') {
      q("UPDATE crm_name SET campaign_id = NULL, status = 'fix_in_crm' WHERE id = ?").run(n.id);
      audit(user, 'flagged to fix in CRM', n.raw_name);
    } else if (body.campaign_id) {
      const c = q('SELECT * FROM campaign WHERE id = ? AND brand_id = ?').get(body.campaign_id, n.brand_id);
      need(c, 'Campaign must belong to the same brand');
      q("UPDATE crm_name SET campaign_id = ?, status = 'mapped' WHERE id = ?").run(c.id, n.id);
      audit(user, 'mapped CRM name', `"${n.raw_name}" → ${c.name}`);
    } else {
      q("UPDATE crm_name SET campaign_id = NULL, status = 'open' WHERE id = ?").run(n.id);
      audit(user, 'reopened CRM name', n.raw_name);
    }
    return { ok: true };
  }),

  'POST /api/level1': ({ body, user }) => tx(() => {
    const l = q('SELECT * FROM level1 WHERE id = ?').get(body.id);
    const ch = q('SELECT * FROM channel WHERE id = ?').get(body.channel_id);
    need(l && ch, 'Level 1 and Channel are required');
    q('UPDATE level1 SET channel_id = ? WHERE id = ?').run(ch.id, l.id);
    audit(user, 'moved Level 1', `${l.name} → ${ch.name}`);
    return { ok: true };
  }),

  'POST /api/campaigns/level1': ({ body, user }) => tx(() => {
    const c = q('SELECT * FROM campaign WHERE id = ?').get(body.id);
    const l = q('SELECT * FROM level1 WHERE id = ?').get(body.level1_id);
    need(c && l, 'Campaign and Level 1 are required');
    q('UPDATE campaign SET level1_id = ? WHERE id = ?').run(l.id, c.id);
    audit(user, 'moved campaign', `${c.name} → ${l.name}`);
    return { ok: true };
  }),

  // Campaigns sitting in the "(Unspecified)" Level 1, with a suggestion taken from how other brands map the same name.
  'GET /api/unspecified': ({ query }) => {
    const un = q("SELECT id FROM level1 WHERE name = '(Unspecified)'").get();
    if (!un) return [];
    const rows = q(`SELECT c.id, c.name, c.brand_id, b.name brand, c.source,
                      COALESCE((SELECT SUM(f.leads) FROM crm_name n JOIN crm_fact f ON f.crm_name_id = n.id WHERE n.campaign_id = c.id), 0) leads,
                      COALESCE((SELECT SUM(f.bookings) FROM crm_name n JOIN crm_fact f ON f.crm_name_id = n.id WHERE n.campaign_id = c.id), 0) bookings,
                      COALESCE((SELECT SUM(s.actual) FROM spend s WHERE s.campaign_id = c.id), 0) spend
                    FROM campaign c JOIN brand b ON b.id = c.brand_id
                    WHERE c.level1_id = :un AND (:brand IS NULL OR c.brand_id = :brand) ORDER BY leads + spend DESC`).all({ un: un.id, brand: num(query.brand) });
    const votes = new Map();
    for (const c of q('SELECT name, level1_id FROM campaign WHERE level1_id <> ?').all(un.id)) {
      const m = votes.get(norm(c.name)) || votes.set(norm(c.name), new Map()).get(norm(c.name));
      m.set(c.level1_id, (m.get(c.level1_id) || 0) + 1);
    }
    const l1s = q('SELECT id, name FROM level1 WHERE id <> ?').all(un.id);
    for (const r of rows) {
      const v = votes.get(norm(r.name));
      if (v) { const [id, n] = [...v].sort((a, b) => b[1] - a[1])[0]; r.suggest = { id, why: `mapped this way in ${n} other brand${n > 1 ? 's' : ''}` }; continue; }
      const best = l1s.map((l) => ({ id: l.id, s: similarity(l.name, r.name) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.8) r.suggest = { id: best.id, why: `${Math.round(best.s * 100)}% name match` };
    }
    return rows;
  },

  'GET /api/import': () => {
    const dir = q("SELECT value FROM setting WHERE key = 'import_dir'").get()?.value || '';
    const done = Object.fromEntries(q("SELECT key, value FROM setting WHERE key LIKE 'imported:%'").all().map((r) => [r.key.slice(9), JSON.parse(r.value)]));
    return { dir, exists: !!dir && fs.existsSync(dir), files: listFolder(dir), done, mode: getMode(db) };
  },
  'POST /api/import/dir': ({ body }) => {
    const dir = String(body.dir || '').trim().replace(/^"|"$/g, '');
    need(dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory(), 'That folder was not found on this computer');
    q("INSERT INTO setting (key, value) VALUES ('import_dir', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(dir);
    return { ok: true };
  },
  'POST /api/import/run': ({ body, user }) => {
    const dir = q("SELECT value FROM setting WHERE key = 'import_dir'").get()?.value;
    const name = String(body.name || '');
    need(dir && name === path.win32.basename(name) && name === path.posix.basename(name) && /\.(csv|xlsx)$/i.test(name), 'Pick a file from the import folder');
    try { return runImport(db, path.join(dir, body.name), user); } catch (e) { throw new Bad(e.message); }
  },

  'GET /api/audit': () => q('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all(),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Bad('Invalid JSON')); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = handler({ query: Object.fromEntries(url.searchParams), body, user: req.headers['x-maestro-user'] || 'Demo user', role: req.headers['x-maestro-role'] || 'marketer' });
      send(200, JSON.stringify(result));
    } catch (e) {
      if (!(e instanceof Bad)) console.error(e);
      send(e instanceof Bad ? 400 : 500, JSON.stringify({ error: e instanceof Bad ? e.message : 'Server error' }));
    }
    return;
  }
  const file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'Not found', 'text/plain');
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`Maestro prototype running at http://localhost:${PORT}`));
