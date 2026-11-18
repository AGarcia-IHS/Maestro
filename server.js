// Maestro prototype server: JSON API over SQLite + static front end. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, MONTHS, YEARS, CLOSED_THROUGH, FX_CAD_USD, REGIONS, divisionOf, getMode, getThrough } from './db.js';
import { listFolder, runImport } from './lib/importers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 4173;
const db = openDb();
const q = (sql) => db.prepare(sql);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const OPEN_MONTHS = MONTHS.filter((m) => m > CLOSED_THROUGH);

// Display currency of the request being handled. Handlers run synchronously, so one module-level value is safe.
let CUR = 'USD';
// Amounts are stored in each brand's own currency; these turn stored amounts into the display currency.
const fxSql = (b) => `(CASE WHEN ${b}.currency = '${CUR}' THEN 1.0 WHEN ${b}.currency = 'CAD' THEN ${FX_CAD_USD} ELSE ${1 / FX_CAD_USD} END)`;
const fxOf = (brandId) => { const c = q('SELECT currency FROM brand WHERE id = ?').get(brandId)?.currency || 'USD'; return c === CUR ? 1 : c === 'CAD' ? FX_CAD_USD : 1 / FX_CAD_USD; };
const fxOfCampaign = (id) => fxOf(q('SELECT brand_id FROM campaign WHERE id = ?').get(id)?.brand_id);
const sym = () => (CUR === 'CAD' ? 'CA$' : '$');
// CRM contract amounts in the golden record are in USD for every brand, Canadian ones included.
const usdFx = () => (CUR === 'USD' ? 1 : 1 / FX_CAD_USD);

// Entity scope of the request being handled: the brand ids selected by Division / Region / Brand, or null for everything.
let SCOPE = null;
const inScope = (col) => (SCOPE ? `${col} IN (${SCOPE.join(',') || 0})` : '1=1');
function scopeOf(o) {
  if (num(o.brand)) return [num(o.brand)];
  if (!o.region && !o.division) return null;
  return q('SELECT id, region FROM brand').all().filter((b) => (!o.region || b.region === o.region) && (!o.division || divisionOf(b.region) === o.division)).map((b) => b.id);
}

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
  const weights = locs.map((l) => { const s = q('SELECT budget, projected FROM spend WHERE campaign_id = ? AND location_id = ? AND month = ?').get(campaignId, l, month); return s?.projected || s?.budget || 0; });
  const total = weights.reduce((a, b) => a + b, 0);
  let left = Math.round(amount);
  locs.forEach((l, i) => {
    const share = i === locs.length - 1 ? left : Math.round(amount * (total ? weights[i] / total : 1 / locs.length));
    left -= share;
    q(`INSERT INTO spend (campaign_id, location_id, month, budget, actual, projected) VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT (campaign_id, location_id, month) DO UPDATE SET projected = excluded.projected`).run(campaignId, l, month, share);
  });
}

// ---- spend links ------------------------------------------------------------
const PLATFORMS = ['google_ads', 'bing_ads', 'meta_ads', 'active_prospect'];
// Words in a CRM campaign name that point at a platform, and words that rule it out.
function platformHint(source, level1) {
  if (/^lsa$|local service/i.test(level1)) return { yes: /\blsa\b|local service/i };
  if (source === 'google_ads') return { yes: /google|adwords|ppc|pay per click/i, no: /\blsa\b|local service|my business|\bgmb\b|organic|maps/i };
  if (source === 'bing_ads') return { yes: /bing|microsoft/i };
  if (source === 'meta_ads') return { yes: /facebook|\bmeta\b|instagram|\bfb\b/i, no: /organic/i };
  return {};
}
// Every ad-platform campaign with its spend, its current link and ranked CRM candidates from the same brand.
function linkRows() {
  const marks = PLATFORMS.map(() => '?').join(',');
  const rows = q(`SELECT c.id, c.name, c.brand_id, b.name brand, c.source, c.level1_id, l.name level1, c.linked_to, t.name linked_name,
                         COALESCE((SELECT SUM(s.actual) FROM spend s WHERE s.campaign_id = c.id), 0) spend,
                         COALESCE((SELECT SUM(f.leads) FROM crm_name n JOIN crm_fact f ON f.crm_name_id = n.id WHERE n.campaign_id = c.id), 0) own_leads
                  FROM campaign c JOIN brand b ON b.id = c.brand_id JOIN level1 l ON l.id = c.level1_id LEFT JOIN campaign t ON t.id = c.linked_to
                  WHERE c.source IN (${marks}) AND ${inScope('c.brand_id')} ORDER BY spend DESC`).all(...PLATFORMS);
  const crm = {};
  for (const c of q(`SELECT c.id, c.brand_id, c.name, c.level1_id, l.name level1,
                            COALESCE((SELECT SUM(f.leads) FROM crm_name n JOIN crm_fact f ON f.crm_name_id = n.id WHERE n.campaign_id = c.id), 0) leads
                     FROM campaign c JOIN level1 l ON l.id = c.level1_id WHERE c.source = 'crm' AND ${inScope('c.brand_id')}`).all()) (crm[c.brand_id] ||= []).push(c);
  for (const r of rows) {
    r.spend *= fxOf(r.brand_id);
    const hint = platformHint(r.source, r.level1), pool = crm[r.brand_id] || [], maxLeads = Math.max(1, ...pool.map((c) => c.leads));
    r.suggestions = pool.map((c) => {
      const sameL1 = c.level1_id === r.level1_id, named = hint.yes?.test(c.name), ruledOut = hint.no?.test(c.name), sim = similarity(r.name, c.name);
      // A CRM campaign nobody has given a Level 1 yet is neither for nor against; one with no leads this year is unlikely.
      const score = (sameL1 ? 0.45 : c.level1 === '(Unspecified)' ? 0.25 : 0) - (c.leads > 0 ? 0 : 0.15) + (named ? 0.35 : 0) - (ruledOut ? 0.3 : 0) + sim * (hint.yes ? 0.2 : 0.7) + 0.05 * (c.leads / maxLeads);
      const why = [sameL1 && `same Level 1 (${c.level1})`, named && 'name points at this platform', sim >= 0.5 && `${Math.round(sim * 100)}% name match`].filter(Boolean).join(', ');
      return { id: c.id, name: c.name, leads: c.leads, level1: c.level1, score: Math.round(score * 100) / 100, why };
    }).filter((s) => s.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 5);
    const [a, b2] = r.suggestions;
    r.status = r.linked_to ? 'linked' : r.own_leads > 0 ? 'same name' : !a ? 'no candidate' : a.score >= 0.75 && (!b2 || a.score - b2.score >= 0.1) ? 'suggested' : 'needs a pick';
  }
  return rows;
}

// ---- day-level aggregation ---------------------------------------------------
// Sums spend and CRM outcomes over a date range into buckets (day, week, month or one total), keyed by whatever
// the caller groups on. Four sources are combined:
//   1. ad-platform spend, which is known by day;
//   2. every other campaign's monthly spend (ledger-only and reconciling lines), spread evenly over the month's days,
//      because a ledger date is when an invoice posted, not when the advertising ran;
//   3. CRM outcomes by their actual day;
//   4. monthly CRM outcomes for anything not held by day (demo data), spread the same way.
// Linked ad-platform spend is counted on the CRM campaign it is linked to, as everywhere else in Insights.
const BUCKET = { day: 'k.day', week: 'k.week', month: 'k.month', all: "'all'" };
const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s || '');
function collect(query, grain, spendKey, crmKey, where) {
  const a = query.from, b = query.to, loc = num(query.location), bk = BUCKET[grain];
  need(isDate(a) && isDate(b) && a <= b, 'Pick a valid date range');
  const cells = new Map();
  const cell = (key, bucket) => { const k = `${key}|${bucket}`; let x = cells.get(k); if (!x) cells.set(k, (x = { key, bucket, spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 })); return x; };
  const spendFrom = (table, amount, join, extra) => `SELECT ${spendKey} key, ${bk} bucket, SUM(${amount} * ${fxSql('b')}) v
      FROM ${table} ${join} JOIN campaign cp ON cp.id = s.campaign_id JOIN brand b ON b.id = cp.brand_id
      JOIN campaign e ON e.id = COALESCE(cp.linked_to, cp.id) JOIN level1 l ON l.id = e.level1_id
      WHERE k.day BETWEEN ? AND ? AND ${inScope('cp.brand_id')} ${loc ? `AND s.location_id = ${loc}` : ''} AND ${where} ${extra} GROUP BY 1, 2`;
  for (const r of q(spendFrom('spend_day s', 's.amount', 'JOIN cal k ON k.day = s.day', '')).all(a, b)) cell(r.key, r.bucket).spend += r.v;
  for (const r of q(spendFrom('spend s', 's.actual / k.dim', 'JOIN cal k ON k.month = s.month AND k.live = 1', 'AND s.actual <> 0 AND s.campaign_id NOT IN (SELECT DISTINCT campaign_id FROM spend_day)')).all(a, b)) cell(r.key, r.bucket).spend += r.v;
  const crmFrom = (table, div, join, extra) => `SELECT ${crmKey} key, ${bk} bucket, SUM(f.leads${div}) leads, SUM(f.appts${div}) appts, SUM(f.sales${div}) sales, SUM(f.bookings${div}) * ${usdFx()} bookings
      FROM ${table} ${join} JOIN crm_name n ON n.id = f.crm_name_id JOIN location lo ON lo.id = f.location_id
      LEFT JOIN campaign e ON e.id = n.campaign_id LEFT JOIN level1 l ON l.id = e.level1_id
      WHERE k.day BETWEEN ? AND ? AND ${inScope('lo.brand_id')} ${loc ? `AND f.location_id = ${loc}` : ''} AND ${where} ${extra} GROUP BY 1, 2`;
  const addCrm = (r) => { const x = cell(r.key, r.bucket); x.leads += r.leads; x.appts += r.appts; x.sales += r.sales; x.bookings += r.bookings; };
  q(crmFrom('crm_day f', '', 'JOIN cal k ON k.day = f.day', '')).all(a, b).forEach(addCrm);
  q(crmFrom('crm_fact f', ' / k.dim', 'JOIN cal k ON k.month = f.month AND k.live = 1', 'AND f.crm_name_id NOT IN (SELECT DISTINCT crm_name_id FROM crm_day)')).all(a, b).forEach(addCrm);
  return { rows: [...cells.values()], buckets: grain === 'all' ? ['all'] : q(`SELECT DISTINCT ${bk} bucket FROM cal k WHERE k.day BETWEEN ? AND ? ORDER BY 1`).all(a, b).map((r) => r.bucket) };
}

// ---- API -------------------------------------------------------------------
const routes = {
  'GET /api/meta': () => ({
    brands: q('SELECT b.*, EXISTS (SELECT 1 FROM gl g WHERE g.brand_id = b.id) in_ledger FROM brand b ORDER BY b.id').all().map((b) => ({ ...b, division: divisionOf(b.region) })),
    regions: [...REGIONS, ...(q("SELECT 1 FROM brand WHERE region = 'Unassigned'").get() ? ['Unassigned'] : [])], divisions: ['US', 'Canada'],
    locations: q('SELECT * FROM location ORDER BY id').all(),
    channels: q('SELECT * FROM channel ORDER BY sort').all(),
    level1: q('SELECT * FROM level1 ORDER BY id').all(),
    months: MONTHS, years: YEARS.map(String), closedThrough: CLOSED_THROUGH, mode: getMode(db), fx: FX_CAD_USD, dataThrough: getThrough(db),
    feedStart: JSON.parse(q("SELECT value FROM setting WHERE key = 'feed_start'").get()?.value || '{}'),
  }),

  'GET /api/facts': ({ query }) => {
    const p = { location: num(query.location) };
    return {
      campaigns: q(`SELECT id, brand_id, level1_id, name, vendor, source, status, linked_to FROM campaign WHERE ${inScope('brand_id')}`).all(),
      spend: q(`SELECT s.campaign_id, s.month, SUM(s.budget * ${fxSql('b')}) budget, SUM(s.actual * ${fxSql('b')}) actual, SUM(s.projected * ${fxSql('b')}) projected
                FROM spend s JOIN location l ON l.id = s.location_id JOIN brand b ON b.id = l.brand_id
                WHERE ${inScope('l.brand_id')} AND (:location IS NULL OR l.id = :location)
                GROUP BY s.campaign_id, s.month`).all(p),
      crm: q(`SELECT n.campaign_id, f.month, SUM(f.leads) leads, SUM(f.appts) appts, SUM(f.sales) sales, SUM(f.bookings) * ${usdFx()} bookings
              FROM crm_fact f JOIN crm_name n ON n.id = f.crm_name_id JOIN location l ON l.id = f.location_id
              WHERE ${inScope('l.brand_id')} AND (:location IS NULL OR l.id = :location)
              GROUP BY n.campaign_id, f.month`).all(p),
      // Budget and channel re-forecast by brand, channel and month. "eff" is the forecast where one was entered, else the budget.
      plan: q(`SELECT p.brand_id, p.channel_id, p.month, SUM(p.budget * ${fxSql('b')}) budget, SUM(COALESCE(p.forecast, p.budget) * ${fxSql('b')}) eff, COUNT(p.forecast) n
                FROM channel_plan p JOIN brand b ON b.id = p.brand_id
                WHERE ${inScope('p.brand_id')} AND (:location IS NULL OR p.location_id = :location)
                GROUP BY p.brand_id, p.channel_id, p.month`).all(p),
      gl: q(`SELECT g.month, g.level1_id, SUM(g.amount * ${fxSql('b')}) amount FROM gl g JOIN brand b ON b.id = g.brand_id WHERE ${inScope('g.brand_id')} AND (:location IS NULL OR g.location_id = :location) GROUP BY g.month, g.level1_id`).all(p),
    };
  },

  'POST /api/projected': ({ body, user }) => tx(() => {
    const fx = fxOfCampaign(body.campaign_id); // amounts arrive in the display currency and are stored in the brand's own
    const before = projectedTotal(body.campaign_id, body.month, campaignLocations(body.campaign_id, num(body.location_id))) * fx;
    setProjected(body.campaign_id, body.month, Number(body.amount) / fx, num(body.location_id));
    const c = q('SELECT name FROM campaign WHERE id = ?').get(body.campaign_id);
    audit(user, 'reforecast', `${c.name} ${body.month}: ${sym()}${Math.round(before)} → ${sym()}${Math.round(body.amount)}`);
    return { ok: true };
  }),

  // Monthly channel re-forecast. With only a brand chosen the amount is spread across its market locations
  // in proportion to budget; an empty amount clears the re-forecast and the month falls back to budget.
  'POST /api/channel-forecast': ({ body, user }) => tx(() => {
    const brand = q('SELECT * FROM brand WHERE id = ?').get(num(body.brand_id)), ch = q('SELECT * FROM channel WHERE id = ?').get(num(body.channel_id)), loc = num(body.location_id);
    need(brand && ch, 'Pick a brand to re-forecast a channel');
    need(OPEN_MONTHS.includes(body.month), 'Only open months can be re-forecast');
    const cleared = body.amount === null || body.amount === '';
    if (cleared) {
      q('UPDATE channel_plan SET forecast = NULL WHERE brand_id = ? AND channel_id = ? AND month = ? AND (? IS NULL OR location_id = ?)').run(brand.id, ch.id, body.month, loc, loc);
      audit(user, 'channel re-forecast cleared', `${brand.name} · ${ch.name} · ${body.month}`);
      return { ok: true };
    }
    const amount = Number(body.amount) / fxOf(brand.id);
    need(Number.isFinite(amount) && amount >= 0, 'Amount must be zero or more');
    const up = q('INSERT INTO channel_plan (month, brand_id, location_id, channel_id, budget, forecast) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (month, location_id, channel_id) DO UPDATE SET forecast = excluded.forecast');
    if (loc) up.run(body.month, brand.id, loc, ch.id, Math.round(amount));
    else {
      const rows = q('SELECT location_id, budget FROM channel_plan WHERE brand_id = ? AND channel_id = ? AND month = ?').all(brand.id, ch.id, body.month);
      let targets = rows.filter((r) => r.budget > 0).map((r) => ({ id: r.location_id, w: r.budget }));
      if (!targets.length) {
        // No budget to follow: use the locations that carry this channel's campaign spend, else the brand's first location.
        targets = q(`SELECT s.location_id id, SUM(s.projected) + 1 w FROM spend s JOIN campaign c ON c.id = s.campaign_id JOIN level1 l ON l.id = c.level1_id
                     WHERE c.brand_id = ? AND l.channel_id = ? AND s.month = ? GROUP BY s.location_id`).all(brand.id, ch.id, body.month);
        if (!targets.length) targets = [{ id: q('SELECT id FROM location WHERE brand_id = ? ORDER BY id').get(brand.id).id, w: 1 }];
      }
      q('UPDATE channel_plan SET forecast = 0 WHERE brand_id = ? AND channel_id = ? AND month = ?').run(brand.id, ch.id, body.month);
      const total = targets.reduce((a, t) => a + t.w, 0); let left = Math.round(amount);
      targets.forEach((t, i) => { const share = i === targets.length - 1 ? left : Math.round(amount * (t.w / total)); left -= share; up.run(body.month, brand.id, t.id, ch.id, share); });
    }
    audit(user, 'channel re-forecast', `${brand.name} · ${ch.name} · ${body.month}: ${sym()}${Math.round(body.amount).toLocaleString()}`);
    return { ok: true };
  }),

  'POST /api/reallocate': ({ body, user }) => tx(() => {
    const fx = fxOfCampaign(body.from), amount = Number(body.amount) / fx, loc = num(body.location_id);
    need(body.from !== body.to, 'Pick two different campaigns');
    need(amount > 0, 'Amount must be more than zero');
    const brandOf = (id) => q('SELECT brand_id FROM campaign WHERE id = ?').get(id)?.brand_id;
    need(brandOf(body.from) && brandOf(body.from) === brandOf(body.to), 'Both campaigns must belong to the same brand');
    const fromNow = projectedTotal(body.from, body.month, campaignLocations(body.from, loc));
    const toNow = projectedTotal(body.to, body.month, campaignLocations(body.to, loc));
    need(amount <= fromNow + 0.5, `Only ${sym()}${Math.round(fromNow * fx)} is projected on the source campaign for that month`);
    setProjected(body.from, body.month, fromNow - amount, loc);
    setProjected(body.to, body.month, toNow + amount, loc);
    const name = (id) => q('SELECT name FROM campaign WHERE id = ?').get(id).name;
    audit(user, 'reallocate', `${body.month}: moved ${sym()}${Math.round(amount * fx)} from ${name(body.from)} to ${name(body.to)}`);
    return { ok: true };
  }),

  'GET /api/campaigns': ({ query }) =>
    q(`SELECT c.*, b.name brand, l.name level1 FROM campaign c JOIN brand b ON b.id = c.brand_id JOIN level1 l ON l.id = c.level1_id
       WHERE ${inScope('c.brand_id')} ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, c.id DESC`).all()
      .map((c) => { const fx = fxOf(c.brand_id); return { ...c, monthly_spend: (c.monthly_spend || 0) * fx, exp_bookings: (c.exp_bookings || 0) * fx }; }),

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
      .run(brand.id, l1.id, name, body.vendor || null, body.start_month, body.end_month, (Number(body.monthly_spend) || 0) / fxOf(brand.id), Number(body.exp_appts) || 0,
        (Number(body.exp_bookings) || 0) / fxOf(brand.id), JSON.stringify(body.location_ids.map(Number)), body.landing_url || null, user, new Date().toISOString()).lastInsertRowid;
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
    const names = q(`SELECT n.id, n.brand_id, b.name brand, n.raw_name, n.campaign_id, n.status, n.first_seen, c.name campaign,
                            COALESCE(SUM(f.leads), 0) leads, COALESCE(SUM(f.bookings), 0) bookings
                     FROM crm_name n JOIN brand b ON b.id = n.brand_id LEFT JOIN campaign c ON c.id = n.campaign_id LEFT JOIN crm_fact f ON f.crm_name_id = n.id
                     WHERE ${inScope('n.brand_id')} GROUP BY n.id ORDER BY leads DESC`).all();
    const byBrand = {};
    for (const c of q("SELECT id, brand_id, name FROM campaign WHERE status IN ('live', 'approved')").all()) (byBrand[c.brand_id] ||= []).push(c);
    for (const n of names) {
      if (n.status !== 'open') continue;
      n.suggestions = (byBrand[n.brand_id] || []).map((c) => ({ id: c.id, name: c.name, confidence: Math.round(similarity(n.raw_name, c.name) * 100) }))
        .filter((s) => s.confidence >= 40).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    }
    for (const n of names) n.bookings *= usdFx();
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
                    WHERE c.level1_id = :un AND ${inScope('c.brand_id')} ORDER BY leads + spend DESC`).all({ un: un.id });
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
    for (const r of rows) { const fx = fxOf(r.brand_id); r.bookings *= usdFx(); r.spend *= fx; }
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

  // ---- spend links: which CRM campaign an ad-platform campaign's spend belongs to ----
  'GET /api/links': () => linkRows(),

  'POST /api/links': ({ body, user }) => tx(() => {
    const p = q('SELECT * FROM campaign WHERE id = ?').get(body.id);
    need(p && PLATFORMS.includes(p.source), 'Only ad-platform campaigns can be linked');
    if (!body.crm_id) { q('UPDATE campaign SET linked_to = NULL WHERE id = ?').run(p.id); audit(user, 'unlinked spend', p.name); return { ok: true }; }
    const c = q("SELECT * FROM campaign WHERE id = ? AND brand_id = ? AND source = 'crm'").get(body.crm_id, p.brand_id);
    need(c, 'Pick a CRM campaign from the same brand');
    q('UPDATE campaign SET linked_to = ? WHERE id = ?').run(c.id, p.id);
    audit(user, 'linked spend', `${p.name} → ${c.name}`);
    return { ok: true };
  }),

  'POST /api/links/accept': ({ body, user }) => tx(() => {
    const ready = linkRows().filter((r) => r.status === 'suggested');
    for (const r of ready) q('UPDATE campaign SET linked_to = ? WHERE id = ?').run(r.suggestions[0].id, r.id);
    if (ready.length) audit(user, 'accepted suggested spend links', `${ready.length} ad-platform campaigns linked`);
    return { linked: ready.length };
  }),

  'POST /api/brands/region': ({ body, user }) => tx(() => {
    const b = q('SELECT * FROM brand WHERE id = ?').get(num(body.id));
    need(b && (REGIONS.includes(body.region) || body.region === 'Unassigned'), 'Pick a brand and one of the listed regions');
    q('UPDATE brand SET region = ? WHERE id = ?').run(body.region, b.id);
    audit(user, 'moved brand to region', `${b.name} → ${body.region} (${divisionOf(body.region)})`);
    return { ok: true };
  }),

  // ---- day-level figures for Insights ---------------------------------------
  // Totals per campaign for a date range, plus the budget pro-rated to that range.
  'GET /api/range': ({ query }) => ({
    rows: collect(query, 'all', 'cp.id', 'n.campaign_id', '1=1').rows,
    budget: q(`SELECT p.channel_id, SUM(p.budget / k.mdays * ${fxSql('b')}) budget FROM channel_plan p JOIN cal k ON k.month = p.month JOIN brand b ON b.id = p.brand_id
               WHERE k.day BETWEEN ? AND ? AND p.budget <> 0 AND ${inScope('p.brand_id')} ${num(query.location) ? `AND p.location_id = ${num(query.location)}` : ''} GROUP BY p.channel_id`).all(query.from, query.to),
  }),

  // One set of totals for a date range. Used for the prior-year comparison on the KPI cards.
  'GET /api/totals': ({ query }) => collect(query, 'all', "'all'", "'all'", '1=1').rows[0] || { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 },

  // A trend by day, week or month, grouped by channel, by Level 1 within a channel, or by campaign within a Level 1.
  'GET /api/series': ({ query }) => {
    const grain = ['day', 'week', 'month'].includes(query.grain) ? query.grain : 'month', id = num(query.id);
    const by = { channel: ['l.channel_id', '1=1'], level1: ['e.level1_id', `l.channel_id = ${id || 0}`], campaign: ['e.id', `e.level1_id = ${id || 0}`] }[query.group] || ['l.channel_id', '1=1'];
    const out = collect(query, grain, by[0], by[0], by[1]);
    if (query.group === 'campaign') {
      const ids = [...new Set(out.rows.map((r) => r.key).filter(Boolean))];
      out.names = Object.fromEntries(q(`SELECT c.id, c.name, b.code FROM campaign c JOIN brand b ON b.id = c.brand_id WHERE c.id IN (${ids.join(',') || 0})`).all().map((c) => [c.id, SCOPE?.length === 1 ? c.name : `${c.name} · ${c.code}`]));
    }
    return out;
  },

  // ---- KPI zoom -------------------------------------------------------------
  // One KPI broken down by brand, market location, service offering or customer type, with optional filters.
  // Brand and location come from the same figures as the rest of Insights and include spend. Service offering and
  // customer type exist only on CRM records, so those breakdowns carry outcomes and no spend.
  'GET /api/zoom': ({ query }) => {
    need(isDate(query.from) && isDate(query.to) && query.from <= query.to, 'Pick a valid date range');
    const dim = ['brand', 'location', 'service', 'ctype'].includes(query.dim) ? query.dim : 'brand';
    const fb = num(query.f_brand), fl = num(query.f_location) || num(query.location);
    if (fb) SCOPE = SCOPE ? SCOPE.filter((x) => x === fb) : [fb];
    const hasRecords = !!q('SELECT 1 FROM record LIMIT 1').get();
    if ((dim === 'brand' || dim === 'location') && !query.f_service && !query.f_ctype) {
      const key = dim === 'brand' ? ['cp.brand_id', 'lo.brand_id'] : ['s.location_id', 'f.location_id'];
      return { rows: collect({ ...query, location: fl }, 'all', key[0], key[1], '1=1').rows, hasSpend: true, hasRecords };
    }
    const col = { brand: 'r.brand_id', location: 'r.location_id', service: 'r.service', ctype: 'r.ctype' }[dim];
    const p = { a: query.from, b: query.to, svc: query.f_service || null, ct: query.f_ctype || null };
    const rows = q(`SELECT ${col} key,
        SUM(r.clone = 0 AND r.lead_day BETWEEN :a AND :b) leads,
        SUM(r.clone = 0 AND r.status <> 'not qualified' AND r.appt_day BETWEEN :a AND :b) appts,
        SUM(r.clone = 0 AND r.won = 1 AND r.closed_day BETWEEN :a AND :b) sales,
        SUM(CASE WHEN r.won = 1 AND r.closed_day BETWEEN :a AND :b THEN r.amount ELSE 0 END) * ${usdFx()} bookings
      FROM record r WHERE (r.lead_day BETWEEN :a AND :b OR r.appt_day BETWEEN :a AND :b OR r.closed_day BETWEEN :a AND :b)
        AND ${inScope('r.brand_id')} ${fl ? `AND r.location_id = ${fl}` : ''} AND (:svc IS NULL OR r.service = :svc) AND (:ct IS NULL OR r.ctype = :ct)
      GROUP BY 1`).all(p).map((r) => ({ ...r, spend: null }));
    return { rows, hasSpend: false, hasRecords };
  },

  // The records behind a KPI total: CRM records for outcomes, ledger lines for spend. format=csv downloads them.
  'GET /api/records': ({ query }) => {
    need(isDate(query.from) && isDate(query.to) && query.from <= query.to, 'Pick a valid date range');
    const fb = num(query.f_brand), fl = num(query.f_location) || num(query.location), csv = query.format === 'csv', limit = csv ? 50000 : 500;
    if (fb) SCOPE = SCOPE ? SCOPE.filter((x) => x === fb) : [fb];
    let cols, rows, count, total;
    if (query.measure === 'spend') {
      const where = `g.month BETWEEN ? AND ? AND ${inScope('g.brand_id')} ${fl ? `AND g.location_id = ${fl}` : ''}`, args = [query.from.slice(0, 7), query.to.slice(0, 7)];
      cols = ['Date', 'Period', 'Brand', 'Market location', 'Level 1', 'GL account', 'Vendor', 'Description', 'Reference', 'Ledger', `Amount (${CUR})`];
      ({ n: count, t: total } = q(`SELECT COUNT(*) n, SUM(g.amount * ${fxSql('b')}) t FROM gl_line g JOIN brand b ON b.id = g.brand_id WHERE ${where}`).get(...args));
      rows = q(`SELECT g.day, g.month, b.name brand, lo.name location, l.name level1, g.account, g.vendor, g.description, g.ref, g.source, ROUND(g.amount * ${fxSql('b')}, 2) amount
                FROM gl_line g JOIN brand b ON b.id = g.brand_id JOIN location lo ON lo.id = g.location_id JOIN level1 l ON l.id = g.level1_id
                WHERE ${where} ORDER BY g.day DESC, g.id LIMIT ${limit}`).all(...args).map((r) => Object.values(r));
    } else {
      const on = { leads: ['r.lead_day', 'r.clone = 0'], appts: ['r.appt_day', "r.clone = 0 AND r.status <> 'not qualified'"], sales: ['r.closed_day', 'r.clone = 0 AND r.won = 1'], bookings: ['r.closed_day', 'r.won = 1'] }[query.measure];
      need(on, 'Records are available for spend, leads, appointments, sales and bookings');
      const where = `${on[0]} BETWEEN :a AND :b AND ${on[1]} AND ${inScope('r.brand_id')} ${fl ? `AND r.location_id = ${fl}` : ''} AND (:svc IS NULL OR r.service = :svc) AND (:ct IS NULL OR r.ctype = :ct)`;
      const p = { a: query.from, b: query.to, svc: query.f_service || null, ct: query.f_ctype || null };
      cols = ['Lead created', 'Appointment booked', 'Closed', 'Brand', 'Market location', 'Campaign', 'Level 1', 'Service offering', 'Customer type', 'Status', 'Additional project', 'Sales rep', `Contract (${CUR})`, 'Record ID'];
      ({ n: count, t: total } = q(`SELECT COUNT(*) n, SUM(r.amount) * ${usdFx()} t FROM record r WHERE ${where}`).get(p));
      rows = q(`SELECT r.lead_day, r.appt_day, r.closed_day, b.name brand, lo.name location, c.name campaign, l.name level1, r.service, r.ctype, r.status, CASE r.clone WHEN 1 THEN 'Yes' ELSE '' END clone, r.rep, ROUND(r.amount * ${usdFx()}, 2) amount, r.id
                FROM record r JOIN brand b ON b.id = r.brand_id JOIN location lo ON lo.id = r.location_id LEFT JOIN campaign c ON c.id = r.campaign_id LEFT JOIN level1 l ON l.id = c.level1_id
                WHERE ${where} ORDER BY ${on[0]} DESC LIMIT ${limit}`).all(p).map((r) => Object.values(r));
    }
    if (csv) {
      const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      return { csv: [cols, ...rows].map((r) => r.map(cell).join(',')).join('\r\n'), filename: `maestro-${query.measure}-${query.from}-to-${query.to}.csv` };
    }
    return { cols, rows, count, total: total || 0, shown: rows.length };
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
      CUR = (req.headers['x-maestro-currency'] || url.searchParams.get('cur')) === 'CAD' ? 'CAD' : 'USD';
      SCOPE = scopeOf({ ...Object.fromEntries(url.searchParams), ...(req.method === 'POST' ? { brand: body.brand, region: body.region, division: body.division } : {}) });
      const result = handler({ query: Object.fromEntries(url.searchParams), body, user: req.headers['x-maestro-user'] || 'Demo user', role: req.headers['x-maestro-role'] || 'marketer' });
      if (result?.csv != null) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Cache-Control': 'no-store' }); return res.end('\ufeff' + result.csv); }
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
