// Maestro prototype database: schema + synthetic seed data.
// All figures are generated. Nothing here comes from IHS systems.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DIR, 'maestro.db');

export const YEAR = 2026;
export const MONTHS = Array.from({ length: 12 }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);
export const CLOSED_THROUGH = `${YEAR}-10`; // last month with posted actuals

const SCHEMA = `
CREATE TABLE brand (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL);
CREATE TABLE location (id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brand(id), name TEXT NOT NULL);
CREATE TABLE channel (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE level1 (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channel(id), name TEXT NOT NULL, gl_account TEXT);
CREATE TABLE campaign (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brand(id),
  level1_id INTEGER NOT NULL REFERENCES level1(id),
  name TEXT NOT NULL,
  vendor TEXT, source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'live',           -- pending | approved | rejected | live
  start_month TEXT, end_month TEXT,
  monthly_spend REAL DEFAULT 0, exp_appts REAL DEFAULT 0, exp_bookings REAL DEFAULT 0,
  location_ids TEXT, landing_url TEXT, tracking_url TEXT, tracking_phone TEXT,
  created_by TEXT, created_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT, crm_pushed_at TEXT
);
CREATE TABLE spend (
  campaign_id INTEGER NOT NULL REFERENCES campaign(id),
  location_id INTEGER NOT NULL REFERENCES location(id),
  month TEXT NOT NULL,
  budget REAL NOT NULL DEFAULT 0, actual REAL NOT NULL DEFAULT 0, projected REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, location_id, month)
);
CREATE TABLE crm_name (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brand(id),
  raw_name TEXT NOT NULL,
  campaign_id INTEGER REFERENCES campaign(id),
  status TEXT NOT NULL DEFAULT 'open',            -- open | mapped | fix_in_crm
  first_seen TEXT
);
CREATE TABLE crm_fact (
  crm_name_id INTEGER NOT NULL REFERENCES crm_name(id),
  location_id INTEGER NOT NULL REFERENCES location(id),
  month TEXT NOT NULL,
  leads REAL NOT NULL DEFAULT 0, appts REAL NOT NULL DEFAULT 0, sales REAL NOT NULL DEFAULT 0, bookings REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (crm_name_id, location_id, month)
);
CREATE TABLE gl (
  month TEXT NOT NULL, brand_id INTEGER NOT NULL, location_id INTEGER NOT NULL, level1_id INTEGER NOT NULL, amount REAL NOT NULL,
  PRIMARY KEY (month, location_id, level1_id)
);
CREATE TABLE gl_map (account TEXT NOT NULL, level1_id INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (account, level1_id)); -- GL account → Level 1 choices
CREATE TABLE entity (code TEXT PRIMARY KEY, brand_id INTEGER NOT NULL, location_id INTEGER NOT NULL); -- Vena / Acumatica branch
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
`;

const BRANDS = [
  ['Infinity Exteriors', 'IE', ['Southeastern WI', 'Fox Valley', 'Madison', 'Lake County IL', 'Rockford', 'Stevens Point']],
  ['Premier Roofing', 'PR', ['Cadillac MI', 'Kalamazoo MI']],
  ['Werner', 'WR', ['Main Market', 'North Market']],
];

const HIERARCHY = [
  ['Digital', [['Paid Search', '6110'], ['Local Services Ads', '6115'], ['Paid Social', '6120'], ['Affiliates', '6130'], ['SEO & Website', '6140']]],
  ['Traditional', [['TV', '6210'], ['Radio', '6220'], ['Direct Mail', '6230'], ['Outdoor', '6240']]],
  ['Events & Field', [['Home Shows', '6310'], ['Sponsorships', '6320'], ['Canvassing', '6330']]],
  ['Referral & Organic', [['Previous Customer', null], ['Referral', '6410']]],
  ['Overhead', [['Agency Fees', '6510'], ['Marketing Tools', '6520']]],
];

// name, level1, vendor, source, base $/location/month, CPL, appt rate, close rate, avg ticket, spend drift, active months, fixed leads
const TEMPLATES = [
  ['Google Ads – Non-brand Search', 'Paid Search', 'Google', 'google', 5200, 150, 0.55, 0.32, 16500, 1.08],
  ['Google Ads – Brand Search', 'Paid Search', 'Google', 'google', 900, 45, 0.70, 0.42, 17000, 1.0],
  ['Bing Ads – Search', 'Paid Search', 'Microsoft', 'bing', 500, 130, 0.50, 0.30, 15500, 0.95],
  ['Local Services Ads', 'Local Services Ads', 'Google', 'google', 4200, 95, 0.60, 0.33, 15000, 1.12],
  ['Meta – Lead Forms', 'Paid Social', 'Meta', 'meta', 1500, 70, 0.35, 0.24, 14000, 1.0],
  ['Meta – Traffic', 'Paid Social', 'Meta', 'meta', 900, 210, 0.25, 0.18, 13000, 1.15],
  ['Angi', 'Affiliates', 'Angi', 'activeprospect', 1800, 90, 0.42, 0.22, 14500, 1.0],
  ['HomeBuddy', 'Affiliates', 'HomeBuddy', 'activeprospect', 1100, 85, 0.45, 0.26, 15000, 0.9],
  ['Modernize', 'Affiliates', 'Modernize', 'activeprospect', 800, 120, 0.30, 0.14, 13000, 1.1],
  ['SEO Retainer', 'SEO & Website', 'LocaliQ', 'gl', 1200, 60, 0.60, 0.36, 17000, 1.0],
  ['TV – Spring Flight', 'TV', 'Local Stations', 'gl', 2500, 320, 0.50, 0.30, 18000, 1.0, [3, 4, 5, 6]],
  ['Radio – Always On', 'Radio', 'iHeart', 'gl', 900, 280, 0.45, 0.28, 16500, 1.0],
  ['Valpak Mailer', 'Direct Mail', 'Valpak', 'gl', 1100, 190, 0.50, 0.30, 15500, 1.0],
  ['Billboards', 'Outdoor', 'Outdoor Nation', 'gl', 800, 400, 0.40, 0.25, 16000, 1.0],
  ['Home Shows', 'Home Shows', 'Various', 'manual', 1000, 110, 0.55, 0.30, 17500, 1.0, [2, 3, 4, 9, 10]],
  ['Local Sponsorships', 'Sponsorships', 'Various', 'manual', 500, 350, 0.40, 0.30, 16000, 1.0],
  ['Canvassing', 'Canvassing', 'In-house', 'manual', 700, 80, 0.50, 0.30, 15000, 1.0],
  ['Previous Customer', 'Previous Customer', null, 'none', 0, 0, 0.80, 0.60, 12000, 1.0, null, 22],
  ['Referral Program', 'Referral', null, 'manual', 250, 40, 0.75, 0.50, 15500, 1.0],
  ['Agency Fees', 'Agency Fees', 'Tinuiti', 'gl', 900, 0, 0, 0, 0, 1.0],
  ['CallRail & Podium', 'Marketing Tools', 'CallRail', 'gl', 350, 0, 0, 0, 0, 1.0],
];

// Messy CRM spellings that still need mapping to a campaign.
const VARIANTS = {
  'Google Ads – Non-brand Search': ['google ads nonbrand'],
  'Local Services Ads': ['LSA - Google Guaranteed'],
  'Angi': ['Angies List'],
  'Valpak Mailer': ['ValPak'],
  'Local Sponsorships': ['Sponsorship', 'Sponsorships'],
  'Home Shows': ['Home Show 2026'],
  'Meta – Lead Forms': ['FB Lead Form'],
  'HomeBuddy': ['Home Buddy'],
};
const JUNK = ['Brian Wagner', '🔥 Spring Roof Sale!! (email blast)', 'Split Contract', 'test'];
const SEASON = [0.6, 0.65, 0.9, 1.1, 1.25, 1.3, 1.25, 1.2, 1.1, 1.0, 0.75, 0.6];

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed(db) {
  const r = rng(20261118);
  const ins = (sql) => db.prepare(sql);
  const level1Id = {};
  HIERARCHY.forEach(([ch, l1s], i) => {
    const cid = ins('INSERT INTO channel (name, sort) VALUES (?, ?)').run(ch, i).lastInsertRowid;
    for (const [n, gl] of l1s) level1Id[n] = ins('INSERT INTO level1 (channel_id, name, gl_account) VALUES (?, ?, ?)').run(cid, n, gl).lastInsertRowid;
  });
  const insSpend = ins('INSERT INTO spend VALUES (?, ?, ?, ?, ?, ?)');
  const insName = ins('INSERT INTO crm_name (brand_id, raw_name, campaign_id, status, first_seen) VALUES (?, ?, ?, ?, ?)');
  const insFact = ins('INSERT INTO crm_fact VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insGl = ins('INSERT INTO gl VALUES (?, ?, ?, ?, ?)');

  for (const [bname, code, locs] of BRANDS) {
    const bid = ins('INSERT INTO brand (name, code) VALUES (?, ?)').run(bname, code).lastInsertRowid;
    const locRows = locs.map((l) => ({ id: ins('INSERT INTO location (brand_id, name) VALUES (?, ?)').run(bid, l).lastInsertRowid, scale: 0.5 + r() * 0.9 }));
    const gl = {}; // `${month}|${level1}` -> amount

    for (const [name, l1, vendor, source, base, cpl, apptRate, closeRate, ticket, drift, active, fixedLeads] of TEMPLATES) {
      const cid = ins(`INSERT INTO campaign (brand_id, level1_id, name, vendor, source, status, start_month, end_month, created_by, created_at)
                       VALUES (?, ?, ?, ?, ?, 'live', ?, ?, 'seed', ?)`).run(bid, level1Id[l1], name, vendor, source, MONTHS[0], MONTHS[11], `${YEAR}-01-02`).lastInsertRowid;
      const primary = insName.run(bid, name, cid, 'mapped', `${YEAR}-01-02`).lastInsertRowid;
      const variants = (VARIANTS[name] || []).filter(() => r() > 0.25).map((v) => insName.run(bid, v, null, 'open', `${YEAR}-0${1 + Math.floor(r() * 8)}-1${Math.floor(r() * 9)}`).lastInsertRowid);

      for (const loc of locRows) {
        MONTHS.forEach((m, i) => {
          const on = !active || active.includes(i + 1);
          const closed = m <= CLOSED_THROUGH;
          const budget = on ? Math.round((base * SEASON[i] * loc.scale) / 10) * 10 : 0;
          const actual = closed ? Math.round(budget * drift * (0.88 + r() * 0.24)) : 0;
          const projected = closed ? actual : Math.round((budget * drift) / 10) * 10;
          if (budget || actual) insSpend.run(cid, loc.id, m, budget, actual, projected);
          if (closed && actual && l1 !== 'Previous Customer') {
            const k = `${m}|${level1Id[l1]}`;
            const timing = ['google', 'bing', 'meta', 'activeprospect'].includes(source) ? 0.97 + r() * 0.06 : 1;
            const extra = ['TV', 'Sponsorships', 'Direct Mail', 'Agency Fees'].includes(l1) ? 1.08 + r() * 0.17 : 1;
            gl[k] = (gl[k] || 0) + actual * timing * extra;
          }
          if (!closed) return;
          const leads = fixedLeads ? Math.round(fixedLeads * SEASON[i] * loc.scale) : cpl ? Math.floor((actual / cpl) * (0.85 + r() * 0.3) + r()) : 0;
          if (!leads) return;
          const appts = Math.floor(leads * apptRate * (0.9 + r() * 0.2) + r());
          const sales = Math.min(appts, Math.floor(appts * closeRate * (0.85 + r() * 0.3) + r()));
          const bookings = Math.round(sales * ticket * (0.9 + r() * 0.2));
          // Messy spellings carry a slice of the campaign's real outcomes until someone maps them.
          const share = variants.length ? 0.18 : 0;
          const part = (v) => (variants.length ? Math.round((v * share) / variants.length) : 0);
          for (const vid of variants) if (part(leads)) insFact.run(vid, loc.id, m, part(leads), part(appts), part(sales), part(bookings));
          const rest = (v) => v - variants.length * part(v);
          insFact.run(primary, loc.id, m, rest(leads), rest(appts), rest(sales), rest(bookings));
        });
      }
    }
    for (const j of JUNK.filter(() => r() > 0.3)) {
      const jid = insName.run(bid, j, null, 'open', `${YEAR}-0${3 + Math.floor(r() * 6)}-05`).lastInsertRowid;
      for (const m of MONTHS.slice(4, 10)) if (r() > 0.4) insFact.run(jid, locRows[0].id, m, 1 + Math.floor(r() * 5), Math.floor(r() * 3), Math.floor(r() * 2), 0);
    }
    for (const [k, amt] of Object.entries(gl)) { const [m, l] = k.split('|'); insGl.run(m, bid, locRows[0].id, Number(l), Math.round(amt)); }
  }
  ins('INSERT INTO audit (at, user, action, detail) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), 'system', 'seed', 'Synthetic pilot data generated');
}

const TABLES = ['crm_fact', 'crm_name', 'spend', 'gl', 'gl_map', 'entity', 'campaign', 'level1', 'channel', 'location', 'brand'];
export const wipe = (db) => { for (const t of TABLES) db.exec('DELETE FROM ' + t); };
export const getMode = (db) => db.prepare("SELECT value FROM setting WHERE key = 'mode'").get()?.value || 'synthetic';
export const setMode = (db, mode) => db.prepare("INSERT INTO setting (key, value) VALUES ('mode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(mode);

export function openDb({ reset = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const db = new DatabaseSync(FILE);
  db.exec('PRAGMA busy_timeout = 5000');
  // Reset drops the tables rather than the file, so it works while the app is running.
  if (reset) { db.exec('PRAGMA foreign_keys = OFF'); for (const t of [...TABLES, 'audit', 'setting']) db.exec('DROP TABLE IF EXISTS ' + t); }
  db.exec('PRAGMA foreign_keys = ON');
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit'").get();
  if (fresh) {
    db.exec('BEGIN');
    try { db.exec(SCHEMA); seed(db); setMode(db, 'synthetic'); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

if (process.argv[1] && process.argv[1].endsWith('db.js') && process.argv.includes('--reset')) {
  openDb({ reset: true }).close();
  console.log('Maestro database reset with fresh synthetic data.');
}
