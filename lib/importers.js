// Importers for the real extract files. Each one recognises its file and loads it inside a transaction.
// The first real import clears the synthetic demo data. Files can be re-imported; each import replaces its own data.
import fs from 'node:fs';
import path from 'node:path';
import { csvRows, parseXlsx, xlsxSheetNames } from './tabular.js';
import { MONTHS, CLOSED_THROUGH, FX_CAD_USD, wipe, getMode, setMode, assignRegions, buildCal } from '../db.js';

const UNSPEC = '(Unspecified)';
const CHANNEL_ORDER = ['Digital', 'Affiliates', 'Media', 'Direct Mail', 'Local', 'Events', 'Customer Loyalty', 'Other', UNSPEC];
const VENDOR = { google_ads: 'Google', bing_ads: 'Microsoft', meta_ads: 'Meta', active_prospect: 'Active Prospect' };
const GL_SOURCE = 'gl_unallocated', GL_TIMING = 'gl_timing';
// Accounts renamed in Acumatica since the mappings workbook was built: new description → description in the workbook.
const ACCOUNT_ALIASES = { 'marketing - collateral/promotional items': 'marketing - apparel/promotional items' };
// Branches that are not part of Maestro: 900-01 is the IHS central / corporate entity, and 023-02 (Franzoso Roofing, LLC) is disregarded.
const EXCLUDED_BRANCHES = new Set(['900-01', '023-02']);
// Brand → main market location, where it should not simply be the brand's first Vena entity.
const MAIN_LOCATION_OVERRIDES = { 'watkins construction': 'jackson, ms' };
// Branches that are not in the Vena mapping but belong with one that is: alias code → mapped code. None at present.
const ENTITY_ALIASES = {};
function loadEntities(db) {
  const m = new Map(db.prepare('SELECT code, brand_id, location_id FROM entity').all().map((e) => [e.code, e]));
  for (const [alias, target] of Object.entries(ENTITY_ALIASES)) if (m.has(target) && !m.has(alias)) m.set(alias, m.get(target));
  return m;
}
// Convert an amount between the two currencies at the fixed rate.
const convert = (amt, from, to) => (from === to ? amt : from === 'CAD' ? amt * FX_CAD_USD : amt / FX_CAD_USD);
const markCad = (db, brandIds) => { for (const b of brandIds) db.prepare("UPDATE brand SET currency = 'CAD' WHERE id = ?").run(b); };
const currencies = (db) => new Map(db.prepare('SELECT id, currency FROM brand').all().map((b) => [b.id, b.currency]));
const key = (s) => String(s ?? '').toLowerCase().replace(/[`’]/g, "'").replace(/\s+/g, ' ').trim();
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const isOpen = (m) => m > CLOSED_THROUGH;
const glLines = (r) => (r.other || r.timing ? [`Campaigns now add up to the ledger for closed months: ${money(r.other)} USD of GL spend has no platform detail ("Other GL spend"), and ${money(-r.timing)} USD of platform spend is not in the GL yet (shown as a negative line)`] : []);
const MONTH_SET = new Set(MONTHS), SPAN = `${MONTHS[0].slice(0, 4)}–${MONTHS.at(-1).slice(0, 4)}`;

// Find the header row (the first row holding every wanted column) and return the rows below it as objects.
function table(rows, wanted) {
  if (!rows) return [];
  const at = rows.findIndex((r) => wanted.every((w) => r.some((c) => key(c) === key(w))));
  if (at < 0) return [];
  const head = rows[at].map((c) => String(c).trim());
  return rows.slice(at + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '').trim()]))).filter((o) => wanted.some((w) => o[w]));
}

// Get-or-create helpers over the live database, so imports can arrive in any order.
class Ctx {
  constructor(db) {
    this.db = db; this.q = (sql) => db.prepare(sql);
    this.channels = new Map(this.q('SELECT id, name FROM channel').all().map((r) => [key(r.name), r.id]));
    this.level1s = new Map(this.q('SELECT id, name FROM level1').all().map((r) => [key(r.name), r.id]));
    this.brands = new Map(this.q('SELECT id, name, code FROM brand').all().map((r) => [key(r.name), r]));
    this.locations = new Map(this.q('SELECT id, brand_id, name FROM location').all().map((r) => [`${r.brand_id}|${key(r.name)}`, r.id]));
    this.campaigns = new Map(this.q('SELECT id, brand_id, name FROM campaign').all().map((r) => [`${r.brand_id}|${key(r.name)}`, r.id]));
    this.names = new Set(this.q('SELECT campaign_id FROM crm_name WHERE campaign_id IS NOT NULL').all().map((r) => r.campaign_id));
    this.created = { channels: 0, level1: 0, brands: 0, locations: 0, campaigns: 0 };
  }
  channel(name) {
    name = name || UNSPEC;
    if (!this.channels.has(key(name))) {
      const sort = CHANNEL_ORDER.includes(name) ? CHANNEL_ORDER.indexOf(name) : 50 + this.channels.size;
      this.channels.set(key(name), this.q('INSERT INTO channel (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid); this.created.channels++;
    }
    return this.channels.get(key(name));
  }
  level1(name, channelName, gl) {
    name = name || UNSPEC;
    if (!this.level1s.has(key(name))) {
      this.level1s.set(key(name), this.q('INSERT INTO level1 (channel_id, name, gl_account) VALUES (?, ?, ?)').run(this.channel(name === UNSPEC ? UNSPEC : channelName), name, gl || null).lastInsertRowid);
      this.created.level1++;
    } else if (gl) this.q('UPDATE level1 SET gl_account = COALESCE(gl_account, ?) WHERE id = ?').run(gl, this.level1s.get(key(name)));
    return this.level1s.get(key(name));
  }
  brand(name) {
    if (!this.brands.has(key(name))) {
      const base = name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4) || 'BR';
      const used = new Set([...this.brands.values()].map((b) => b.code)); let code = base, n = 2;
      while (used.has(code)) code = base + n++;
      const id = this.q('INSERT INTO brand (name, code) VALUES (?, ?)').run(name, code).lastInsertRowid;
      this.brands.set(key(name), { id, name, code }); this.created.brands++;
    }
    return this.brands.get(key(name)).id;
  }
  location(brandId, name) {
    name = name || 'Brand-wide (no location)';
    const k = `${brandId}|${key(name)}`;
    if (!this.locations.has(k)) { this.locations.set(k, this.q('INSERT INTO location (brand_id, name) VALUES (?, ?)').run(brandId, name).lastInsertRowid); this.created.locations++; }
    return this.locations.get(k);
  }
  // Spend that names no market location goes to the brand's main location: its first entity in the Vena mapping
  // (the -01 branch). Only a brand with no entity at all falls back to a brand-level placeholder.
  mainLocation(brandId) {
    if (!this.mains) {
      this.mains = new Map(this.q('SELECT brand_id, location_id FROM entity ORDER BY code DESC').all().map((e) => [e.brand_id, e.location_id]));
      // Where the Vena entity is a catch-all ("Multiple - …"), use the brand's home market instead.
      for (const [brand, loc] of Object.entries(MAIN_LOCATION_OVERRIDES)) { const b = this.brands.get(brand), id = b && this.locations.get(`${b.id}|${loc}`); if (id) this.mains.set(b.id, id); }
    }
    return this.mains.get(brandId) ?? this.location(brandId, null);
  }
  campaign(brandId, name, level1Id, source, vendor) {
    const k = `${brandId}|${key(name)}`;
    if (!this.campaigns.has(k)) {
      this.campaigns.set(k, this.q(`INSERT INTO campaign (brand_id, level1_id, name, vendor, source, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'live', 'import', ?)`)
        .run(brandId, level1Id, name, vendor || null, source, new Date().toISOString()).lastInsertRowid);
      this.created.campaigns++; return { id: this.campaigns.get(k), isNew: true };
    }
    return { id: this.campaigns.get(k), isNew: false };
  }
  // Every CRM campaign needs its own name row so outcomes can hang off it.
  crmName(brandId, campaignId, name) {
    if (this.names.has(campaignId)) return;
    this.q("INSERT INTO crm_name (brand_id, raw_name, campaign_id, status, first_seen) VALUES (?, ?, ?, 'mapped', NULL)").run(brandId, name, campaignId);
    this.names.add(campaignId);
  }
}

// Replace the spend of the given campaigns with new totals. Keys are `${campaign}|${location}|${month}`.
// Open months start from the larger of month-to-date and last month's run rate, unless someone already re-forecast them.
function writeSpend(db, agg, campaignIds) {
  const ids = [...campaignIds].join(',') || '0';
  const kept = new Map(db.prepare(`SELECT campaign_id, location_id, month, actual, projected FROM spend WHERE month > ? AND campaign_id IN (${ids})`).all(CLOSED_THROUGH)
    .filter((s) => Math.round(s.projected) !== Math.round(s.actual)).map((s) => [`${s.campaign_id}|${s.location_id}|${s.month}`, s.projected]));
  const budgets = new Map(db.prepare(`SELECT campaign_id, location_id, month, budget FROM spend WHERE budget > 0 AND campaign_id IN (${ids})`).all().map((s) => [`${s.campaign_id}|${s.location_id}|${s.month}`, s.budget]));
  db.exec(`DELETE FROM spend WHERE campaign_id IN (${ids})`);
  // Carry the last closed month forward into open months that have no activity yet.
  for (const [k, amt] of [...agg]) {
    const [camp, loc, m] = k.split('|');
    if (m !== CLOSED_THROUGH || amt <= 0) continue;
    for (const o of MONTHS.filter((x) => isOpen(x) && x.slice(0, 4) === CLOSED_THROUGH.slice(0, 4))) if (!agg.has(`${camp}|${loc}|${o}`)) agg.set(`${camp}|${loc}|${o}`, 0), kept.has(`${camp}|${loc}|${o}`) || kept.set(`${camp}|${loc}|${o}`, Math.round(amt));
  }
  const ins = db.prepare('INSERT INTO spend (campaign_id, location_id, month, budget, actual, projected) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [k, amt] of agg) {
    const [camp, loc, m] = k.split('|');
    const prev = agg.get(`${camp}|${loc}|${MONTHS[MONTHS.indexOf(m) - 1]}`) || 0;
    const projected = isOpen(m) ? kept.get(k) ?? Math.max(amt, prev) : amt;
    ins.run(Number(camp), Number(loc), m, budgets.get(k) || 0, Math.round(amt * 100) / 100, Math.round(projected));
  }
}

// Acumatica is the official spend. For every brand, Level 1 and closed month the campaigns must add up to the ledger:
//   platform campaigns stay at their own amounts,
//   "Other GL spend" carries ledger dollars that no connected feed explains (TV, radio, agency fees, non-platform vendors),
//   "Platform spend not yet in GL" is a negative line where the feeds report more than the ledger (timing or account coding).
// Open months, and brand-months with nothing posted in the ledger, are provisional: feeds are shown as they are and only the positive "Other GL spend" line is added.
export function rebuildUnallocated(db) {
  db.exec(`UPDATE campaign SET name = REPLACE(name, 'Unallocated GL – ', 'Other GL spend – ') WHERE source = '${GL_SOURCE}'`);
  const c = new Ctx(db), cur = currencies(db);
  const feed = new Map(), feedLoc = new Map();
  for (const r of db.prepare(`SELECT c.brand_id b, c.level1_id l, s.month m, s.location_id loc, SUM(s.actual) t FROM spend s JOIN campaign c ON c.id = s.campaign_id
                              WHERE c.source NOT LIKE 'gl_%' GROUP BY 1, 2, 3, 4 ORDER BY t`).all()) {
    const k = `${r.b}|${r.l}|${r.m}`;
    feed.set(k, (feed.get(k) || 0) + r.t); feedLoc.set(k, r.loc); // ends on the location carrying the most spend
  }
  const groups = new Map();
  for (const g of db.prepare('SELECT month, brand_id, level1_id, location_id, amount FROM gl').all()) {
    const k = `${g.brand_id}|${g.level1_id}|${g.month}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(g);
  }
  // A brand-month with nothing posted in the ledger (brand not on Acumatica, or month not posted) stays provisional.
  const posted = new Set(db.prepare('SELECT DISTINCT brand_id, month FROM gl').all().map((r) => `${r.brand_id}|${r.month}`));
  const l1name = Object.fromEntries(db.prepare('SELECT id, name FROM level1').all().map((r) => [r.id, r.name]));
  const agg = new Map(), ids = new Set(db.prepare("SELECT id FROM campaign WHERE source LIKE 'gl_%'").all().map((r) => r.id));
  const out = { other: 0, timing: 0 };
  for (const k of new Set([...groups.keys(), ...feed.keys()])) {
    const [b, l, m] = k.split('|'), rows = groups.get(k) || [];
    const residual = rows.reduce((a, r) => a + r.amount, 0) - (feed.get(k) || 0);
    if (Math.abs(residual) < 1 || (residual < 0 && (isOpen(m) || !posted.has(`${b}|${m}`)))) continue;
    const usd = convert(residual, cur.get(Number(b)), 'USD');
    // A ledger credit with no platform spend behind it is still ledger-only spend, just negative.
    if (residual > 0 || !feed.get(k)) {
      const camp = c.campaign(Number(b), `Other GL spend – ${l1name[l]}`, Number(l), GL_SOURCE, null).id;
      ids.add(camp); out.other += usd;
      const pos = rows.filter((r) => r.amount > 0), base = pos.reduce((a, r) => a + r.amount, 0);
      for (const r of pos.length ? pos : [rows[0]]) {
        const kk = `${camp}|${r.location_id}|${m}`;
        agg.set(kk, (agg.get(kk) || 0) + (base ? residual * (r.amount / base) : residual));
      }
    } else {
      const camp = c.campaign(Number(b), `Platform spend not yet in GL – ${l1name[l]}`, Number(l), GL_TIMING, null).id;
      ids.add(camp); out.timing += usd;
      const kk = `${camp}|${rows[0]?.location_id ?? feedLoc.get(k)}|${m}`;
      agg.set(kk, (agg.get(kk) || 0) + residual);
    }
  }
  writeSpend(db, agg, ids);
  return out;
}

// ---- Mappings workbook -----------------------------------------------------
function importMappings(db, file) {
  const sheets = parseXlsx(fs.readFileSync(file));
  const src = table(sheets['Campaign Source Mapping'], ['Campaign Source', 'Channel']);
  const acu = table(sheets['Acumatica Account Mapping'], ['COA (General Ledger)', 'Channel', 'Level 1']);
  const gr = table(sheets['Golden Record Campaign mappings'], ['Brand', 'Campaign', 'Current Level 1']);
  const vena = table(sheets['Vena Entity to CRM Mapping'], ['Vena Entity', 'CRM Brand Name', 'CRM Market Location Name']);
  const c = new Ctx(db);
  for (const n of CHANNEL_ORDER.slice(0, -1)) if (src.some((r) => r.Channel === n) || acu.some((r) => r.Channel === n)) c.channel(n);
  for (const r of src) c.level1(r['Campaign Source'], r.Channel);
  const addMap = db.prepare('INSERT OR REPLACE INTO gl_map (account, level1_id, seq) VALUES (?, ?, ?)');
  acu.forEach((r, i) => addMap.run(key(r['COA (General Ledger)']), c.level1(r['Level 1'], r.Channel, r['COA (General Ledger)']), i));
  const addEntity = db.prepare('INSERT OR REPLACE INTO entity (code, brand_id, location_id) VALUES (?, ?, ?)');
  for (const r of vena) { const b = c.brand(r['CRM Brand Name']); addEntity.run(r['Vena Entity'].split(' ')[0], b, c.location(b, r['CRM Market Location Name'])); }
  let added = 0, updated = 0;
  for (const r of gr) {
    if (!r.Brand || !r.Campaign) continue;
    const b = c.brand(r.Brand), l1 = c.level1(r['Current Level 1'] || UNSPEC, r['Current Channel']);
    const camp = c.campaign(b, r.Campaign, l1, 'crm');
    if (camp.isNew) added++; else { db.prepare('UPDATE campaign SET level1_id = ? WHERE id = ?').run(l1, camp.id); updated++; }
    c.crmName(b, camp.id, r.Campaign);
  }
  const unspecified = gr.filter((r) => !r['Current Level 1'] || r['Current Level 1'] === UNSPEC).length;
  return [
    `${src.length} Level 1 → Channel rows, ${acu.length} GL account → Level 1 rows, ${vena.length} Vena entities`,
    `${c.created.brands} brands, ${c.created.locations} market locations, ${c.created.channels} channels and ${c.created.level1} Level 1s created`,
    `${added} CRM campaigns added and ${updated} updated; ${unspecified} have no Level 1 yet`,
  ];
}

// ---- Connected spend feed (marketing_spend.csv) ----------------------------
function importSpend(db, file) {
  const c = new Ctx(db), raw = new Map(), touched = new Set(), providers = new Set(), cadBrands = new Set(), campBrand = new Map(), noBrand = {};
  let C, rows = 0, noBrandRows = 0, outside = 0, total = 0, lastDay = '', noLocation = 0; const firstDay = {}, rawDay = new Map();
  for (const r of csvRows(file)) {
    if (!C) { C = Object.fromEntries(r.map((h, i) => [h.trim(), i])); continue; }
    rows++;
    const m = r[C.date].slice(0, 7), rowCur = r[C.currency] === 'CAD' ? 'CAD' : 'USD', native = Number(r[C.spend_amount]) || 0;
    if (!MONTHS.includes(m)) { outside++; continue; }
    if (!r[C.brand_name]) { noBrandRows++; noBrand[rowCur] = (noBrand[rowCur] || 0) + native; continue; }
    const provider = r[C.provider], b = c.brand(r[C.brand_name]), l1 = c.level1(r[C.campaign_level_one_name] || UNSPEC, r[C.campaign_channel_name]);
    const camp = c.campaign(b, r[C.campaign_name] || '(no campaign name)', l1, provider, VENDOR[provider]);
    if (!camp.isNew && !touched.has(camp.id)) db.prepare('UPDATE campaign SET source = ?, vendor = COALESCE(vendor, ?) WHERE id = ?').run(provider, VENDOR[provider] || null, camp.id);
    touched.add(camp.id); providers.add(provider);
    if (!firstDay[provider] || r[C.date] < firstDay[provider]) firstDay[provider] = r[C.date];
    if (rowCur === 'CAD') cadBrands.add(b);
    campBrand.set(camp.id, b);
    if (!r[C.market_location_name]) noLocation++;
    const k = `${camp.id}|${r[C.market_location_name] ? c.location(b, r[C.market_location_name]) : c.mainLocation(b)}|${m}`, cell = raw.get(k) || raw.set(k, { USD: 0, CAD: 0 }).get(k);
    cell[rowCur] += native; total += convert(native, rowCur, 'USD');
    const dk = k.slice(0, k.lastIndexOf('|') + 1) + r[C.date], dc = rawDay.get(dk) || rawDay.set(dk, { USD: 0, CAD: 0 }).get(dk);
    dc[rowCur] += native; if (r[C.date] > lastDay) lastDay = r[C.date];
  }
  // A brand billed in Canadian dollars is kept in Canadian dollars; the USD view translates it at the fixed rate.
  markCad(db, cadBrands);
  const cur = currencies(db), agg = new Map();
  for (const [k, cell] of raw) { const bc = cur.get(campBrand.get(Number(k.split('|')[0]))); agg.set(k, convert(cell.USD, 'USD', bc) + convert(cell.CAD, 'CAD', bc)); }
  // A full feed replaces everything previously loaded from the same providers.
  for (const r of db.prepare(`SELECT id FROM campaign WHERE source IN (${[...providers].map((p) => `'${p.replace(/'/g, '')}'`).join(',') || "''"})`).all()) touched.add(r.id);
  writeSpend(db, agg, touched);
  // The same spend by day, for the weekly and daily views.
  db.exec(`DELETE FROM spend_day WHERE campaign_id IN (${[...touched].join(',') || 0})`);
  const insDay = db.prepare('INSERT INTO spend_day (campaign_id, location_id, day, amount) VALUES (?, ?, ?, ?)');
  for (const [dk, dc] of rawDay) { const [camp, loc, day] = dk.split('|'), bc = cur.get(campBrand.get(Number(camp))); insDay.run(Number(camp), Number(loc), day, Math.round((convert(dc.USD, 'USD', bc) + convert(dc.CAD, 'CAD', bc)) * 100) / 100); }
  if (lastDay) { db.prepare("INSERT INTO setting (key, value) VALUES ('data_through', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(lastDay); buildCal(db); }
  db.prepare("INSERT INTO setting (key, value) VALUES ('feed_start', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(firstDay));
  const unallocated = rebuildUnallocated(db);
  return [
    `${rows.toLocaleString()} daily rows from ${[...providers].join(', ')}: ${money(total)} USD loaded across ${touched.size} campaigns`,
    ...(noLocation ? [`${noLocation.toLocaleString()} rows name no market location and were assigned to each brand's main location`] : []),
    ...(cadBrands.size ? [`${cadBrands.size} brands are billed in CAD and kept in CAD; translated to USD at ${FX_CAD_USD.toFixed(2)}`] : []),
    ...(noBrandRows ? [`${noBrandRows} rows have no brand on them and were left out (${Object.entries(noBrand).filter(([, v]) => v > 0).map(([k, v]) => `${Math.round(v).toLocaleString()} ${k}`).join(', ')})`] : []),
    ...(outside ? [`${outside} rows fall outside ${SPAN} and were left out`] : []),
    `${c.created.campaigns} new campaigns`, ...glLines(unallocated),
  ];
}

// ---- Golden record CRM export ----------------------------------------------
// Definitions follow Sales_Funnel_Metric_Definitions_v3 (activity view):
//   Leads        non-cloned records, by lead created date
//   Appointments non-cloned, qualified records with an appointment booked, by appointment created date
//   Sales        non-cloned sold or completed records, by closed date
//   Bookings $   final contract amount of every sold or completed record (clones included), by closed date.
//                Contract amounts are in USD for every brand, including the Canadian ones.
function importGolden(db, file) {
  const c = new Ctx(db), agg = new Map(), dayAgg = new Map(), keyCache = new Map(), won = new Set(['sold', 'completed']);
  db.exec('DELETE FROM record');
  const insRec = db.prepare('INSERT INTO record (id, brand_id, location_id, campaign_id, service, ctype, status, clone, won, lead_day, appt_day, closed_day, amount, rep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const dayOf = (v) => (v ? v.slice(0, 10) : null);
  let C, rows = 0;
  const T = { leads: 0, appts: 0, sales: 0, bookings: 0 };
  const bump = (nameKey, date, field, v) => {
    const m = date.slice(0, 7);
    if (!MONTHS.includes(m)) return;
    const k = `${nameKey}|${m}`; let a = agg.get(k);
    if (!a) agg.set(k, (a = { leads: 0, appts: 0, sales: 0, bookings: 0 }));
    a[field] += v; T[field] += v;
    const dk = `${nameKey}|${date.slice(0, 10)}`; let d = dayAgg.get(dk);
    if (!d) dayAgg.set(dk, (d = { leads: 0, appts: 0, sales: 0, bookings: 0 }));
    d[field] += v;
  };
  for (const r of csvRows(file)) {
    if (!C) { C = Object.fromEntries(r.map((h, i) => [h.trim(), i])); continue; }
    rows++;
    if (!MONTH_SET.has(r[C.lead_created_at].slice(0, 7)) && !MONTH_SET.has(r[C.appointment_created_at].slice(0, 7)) && !MONTH_SET.has(r[C.closed_at].slice(0, 7))) continue;
    if (!r[C.brand_name]) continue;
    const ck = `${r[C.brand_name]}|${r[C.market_location_name]}|${r[C.campaign_name]}`;
    let nameKey = keyCache.get(ck);
    if (!nameKey) {
      const b = c.brand(r[C.brand_name]), name = r[C.campaign_name] || '(No campaign)';
      const camp = c.campaign(b, name, c.level1(r[C.campaign_level_one_name] || UNSPEC, r[C.campaign_channel_name]), 'crm');
      c.crmName(b, camp.id, name);
      nameKey = `${camp.id}|${c.location(b, r[C.market_location_name])}`; keyCache.set(ck, nameKey);
    }
    const clone = r[C.is_multi_project] === 'true', status = r[C.status_name];
    { const [campId, locId] = nameKey.split('|');
      insRec.run(r[C.id], c.brand(r[C.brand_name]), Number(locId), Number(campId), r[C.service_offering_name] || null, r[C.customer_type_name] || null, status || null, clone ? 1 : 0, won.has(status) ? 1 : 0,
        dayOf(r[C.lead_created_at]), status !== 'not qualified' ? dayOf(r[C.appointment_created_at]) : null, dayOf(r[C.closed_at]), Number(r[C.final_contract_amount]) || 0, r[C.sales_rep_name] || null); }
    if (!clone) {
      bump(nameKey, r[C.lead_created_at], 'leads', 1);
      if (r[C.appointment_created_at] && status !== 'not qualified') bump(nameKey, r[C.appointment_created_at], 'appts', 1);
      if (won.has(status)) bump(nameKey, r[C.closed_at], 'sales', 1);
    }
    if (won.has(status)) bump(nameKey, r[C.closed_at], 'bookings', Number(r[C.final_contract_amount]) || 0);
  }
  db.exec('DELETE FROM crm_fact');
  const nameId = new Map(db.prepare('SELECT id, campaign_id FROM crm_name WHERE campaign_id IS NOT NULL ORDER BY id DESC').all().map((n) => [n.campaign_id, n.id]));
  const ins = db.prepare(`INSERT INTO crm_fact (crm_name_id, location_id, month, leads, appts, sales, bookings) VALUES (?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT DO UPDATE SET leads = leads + excluded.leads, appts = appts + excluded.appts, sales = sales + excluded.sales, bookings = bookings + excluded.bookings`);
  for (const [k, a] of agg) { const [camp, loc, m] = k.split('|'); ins.run(nameId.get(Number(camp)), Number(loc), m, a.leads, a.appts, a.sales, Math.round(a.bookings)); }
  // The same outcomes by day, for the weekly and daily views.
  db.exec('DELETE FROM crm_day');
  const insD = db.prepare(`INSERT INTO crm_day (crm_name_id, location_id, day, leads, appts, sales, bookings) VALUES (?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT DO UPDATE SET leads = leads + excluded.leads, appts = appts + excluded.appts, sales = sales + excluded.sales, bookings = bookings + excluded.bookings`);
  for (const [k, a] of dayAgg) { const [camp, loc, day] = k.split('|'); insD.run(nameId.get(Number(camp)), Number(loc), day, a.leads, a.appts, a.sales, Math.round(a.bookings)); }
  return [
    `${rows.toLocaleString()} golden records read; ${SPAN} activity kept`,
    `${T.leads.toLocaleString()} leads, ${T.appts.toLocaleString()} appointments, ${T.sales.toLocaleString()} sales, ${money(T.bookings)} bookings`,
    `${c.created.campaigns} new CRM campaigns, ${c.created.locations} new market locations`,
  ];
}

// ---- Acumatica GL marketing spend ------------------------------------------
function importAcumatica(db, file) {
  const data = table(parseXlsx(fs.readFileSync(file)).Data, ['AccountName', 'Branch', 'Period', 'Debit', 'Credit']);
  const entities = loadEntities(db);
  if (!entities.size) throw new Error('Import the mappings workbook first: it holds the branch → brand and GL account → Level 1 mappings');
  // One GL account can feed several Level 1s. Until lines are split by hand, each account lands on the Level 1
  // that shares its name ("Marketing - Other" → Other), or failing that the first one listed in the mapping.
  const byAccount = new Map();
  for (const g of db.prepare('SELECT g.account, g.level1_id, l.name FROM gl_map g JOIN level1 l ON l.id = g.level1_id ORDER BY g.seq').all())
    if (!byAccount.has(g.account) || g.account.endsWith('- ' + key(g.name))) byAccount.set(g.account, g.level1_id);
  const agg = new Map(), noBranch = {}, noAccount = {}, ledgers = {}, excluded = {}, detail = [];
  const serialDay = (v) => (Number(v) > 20000 ? new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000).toISOString().slice(0, 10) : null);
  let total = 0, kept = 0, cadTotal = 0, usdIgnored = 0;
  // Canadian entities post to the ACTUALCAD ledger. A brand with CAD lines is stored in CAD from that ledger;
  // every other brand is stored in USD from ACTUAL.
  const cadBrands = new Set(data.filter((r) => r.Ledger === 'ACTUALCAD' && entities.has(r.Branch)).map((r) => entities.get(r.Branch).brand_id));
  markCad(db, cadBrands);
  for (const r of data) {
    const [mm, yyyy] = r.Period.split('-'), m = `${yyyy}-${mm}`, amt = (Number(r.Debit) || 0) - (Number(r.Credit) || 0);
    if (!MONTHS.includes(m)) continue;
    if (EXCLUDED_BRANCHES.has(r.Branch)) { excluded[r.Branch] = (excluded[r.Branch] || 0) + amt; continue; }
    if (r.Ledger && r.Ledger !== 'ACTUAL' && r.Ledger !== 'ACTUALCAD') { ledgers[r.Ledger] = (ledgers[r.Ledger] || 0) + amt; continue; }
    const account = ACCOUNT_ALIASES[key(r.AccountName)] || key(r.AccountName);
    const e = entities.get(r.Branch), l1 = byAccount.get(account);
    if (e && cadBrands.has(e.brand_id) !== (r.Ledger === 'ACTUALCAD')) { if (cadBrands.has(e.brand_id)) usdIgnored += amt; else ledgers[r.Ledger] = (ledgers[r.Ledger] || 0) + amt; continue; }
    if (!e) { noBranch[`${r.Branch} ${r['Branch Name']}`] = (noBranch[`${r.Branch} ${r['Branch Name']}`] || 0) + amt; continue; }
    if (!l1) { noAccount[r.AccountName] = (noAccount[r.AccountName] || 0) + amt; continue; }
    const k = `${m}|${e.brand_id}|${e.location_id}|${l1}`;
    agg.set(k, (agg.get(k) || 0) + amt); kept++;
    detail.push([m, serialDay(r.DateOrYear), e.brand_id, e.location_id, l1, r.AccountName, r.CustomerVendorName || null, r.Description || null, r.RefNumber || null, amt, 'Acumatica']);
    if (r.Ledger === 'ACTUALCAD') { cadTotal += amt; total += amt * FX_CAD_USD; } else total += amt;
  }
  const inFile = [...new Set(data.map((r) => entities.get(r.Branch)?.brand_id).filter(Boolean))];
  db.exec(`DELETE FROM gl WHERE brand_id IN (${inFile.join(',') || 0})`);
  db.exec(`DELETE FROM gl_line WHERE brand_id IN (${inFile.join(',') || 0})`);
  const insLine = db.prepare('INSERT INTO gl_line (month, day, brand_id, location_id, level1_id, account, vendor, description, ref, amount, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const d of detail) insLine.run(...d);
  const ins = db.prepare('INSERT INTO gl (month, brand_id, location_id, level1_id, amount) VALUES (?, ?, ?, ?, ?)');
  for (const [k, amt] of agg) { const [m, b, loc, l1] = k.split('|'); ins.run(m, Number(b), Number(loc), Number(l1), Math.round(amt * 100) / 100); }
  const unallocated = rebuildUnallocated(db);
  const list = (o) => Object.entries(o).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map(([k, v]) => `${k} ${money(v)}`).join(', ');
  return [
    `${kept.toLocaleString()} of ${data.length.toLocaleString()} ledger lines loaded: ${money(total)} USD of ${SPAN} marketing spend`,
    ...(cadBrands.size ? [`${cadBrands.size} Canadian brands loaded from the CAD ledger: CA${money(cadTotal)}, translated to ${money(cadTotal * FX_CAD_USD)} USD at ${FX_CAD_USD.toFixed(2)}`] : []),
    ...(usdIgnored ? [`${money(usdIgnored)} of USD-ledger lines for Canadian brands were left out in favour of the CAD ledger`] : []),
    ...(Object.keys(excluded).length ? [`Excluded by rule: ${list(excluded)}`] : []),
    ...glLines(unallocated),
    ...(Object.keys(noBranch).length ? [`Left out, branch not in the Vena mapping: ${list(noBranch)}`] : []),
    ...(Object.keys(noAccount).length ? [`Left out, GL account not mapped to a Level 1: ${list(noAccount)}`] : []),
    ...(Object.keys(ledgers).length ? [`Left out, other ledgers: ${list(ledgers)}`] : []),
  ];
}

// ---- Budget by entity, channel and month (from Vena) ------------------------
// Long layout, one row per entity × channel × month. Column names are matched loosely:
//   Entity (e.g. "001-01" or "001-01 (New Berlin)"), Channel, Month (2027-01, 01-2027, 1/2027, Jan 2027 or Jan-27), Amount.
// Amounts are taken in the entity's own currency.
const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseMonth(v) {
  const s = String(v).trim().toLowerCase(); let m;
  if ((m = /^(\d{4})[-/](\d{1,2})/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[-/](\d{4})$/.exec(s))) return `${m[2]}-${m[1].padStart(2, '0')}`;
  if ((m = /^([a-z]{3})[a-z]*[ -/]?'?(\d{2}|\d{4})$/.exec(s)) && MON3.includes(m[1])) return `${m[2].length === 2 ? '20' + m[2] : m[2]}-${String(MON3.indexOf(m[1]) + 1).padStart(2, '0')}`;
  return null;
}
const BUDGET_COLS = { entity: /^(vena )?(entity|branch)/, channel: /^channel/, month: /^(month|period|date)/, amount: /^(amount|budget|planned|value)/ };
function budgetColumns(head) {
  const out = {};
  for (const [k, re] of Object.entries(BUDGET_COLS)) out[k] = head.findIndex((h) => re.test(key(h)));
  return Object.values(out).every((i) => i >= 0) ? out : null;
}
function importBudget(db, file) {
  const rows = file.toLowerCase().endsWith('.xlsx') ? Object.values(parseXlsx(fs.readFileSync(file)))[0] : [...csvRows(file)];
  const at = rows.findIndex((r) => budgetColumns(r)), C = budgetColumns(rows[at]);
  const entities = loadEntities(db);
  if (!entities.size) throw new Error('Import the mappings workbook first: it holds the entity → brand and market location mapping');
  const channels = new Map(db.prepare('SELECT id, name FROM channel').all().map((c) => [key(c.name), c.id]));
  const agg = new Map(), bad = { entity: {}, channel: {}, month: {} }, cur = currencies(db); let total = 0, n = 0;
  for (const r of rows.slice(at + 1)) {
    const code = String(r[C.entity] ?? '').trim().split(' ')[0], amt = Number(String(r[C.amount] ?? '').replace(/[$,\s]/g, '')) || 0;
    if (!code && !amt) continue;
    const e = entities.get(code), ch = channels.get(key(r[C.channel])), m = parseMonth(r[C.month]);
    if (!e) { bad.entity[code || '(blank)'] = (bad.entity[code || '(blank)'] || 0) + amt; continue; }
    if (!ch) { bad.channel[r[C.channel] || '(blank)'] = (bad.channel[r[C.channel] || '(blank)'] || 0) + amt; continue; }
    if (!m || !MONTH_SET.has(m)) { bad.month[r[C.month] || '(blank)'] = (bad.month[r[C.month] || '(blank)'] || 0) + amt; continue; }
    const k = `${m}|${e.brand_id}|${e.location_id}|${ch}`;
    agg.set(k, (agg.get(k) || 0) + amt); total += convert(amt, cur.get(e.brand_id), 'USD'); n++;
  }
  // A budget file replaces the budget for every month it covers, and leaves re-forecasts alone.
  const months = [...new Set([...agg.keys()].map((k) => k.split('|')[0]))].sort();
  for (const m of months) db.prepare('UPDATE channel_plan SET budget = 0 WHERE month = ?').run(m);
  const up = db.prepare('INSERT INTO channel_plan (month, brand_id, location_id, channel_id, budget) VALUES (?, ?, ?, ?, ?) ON CONFLICT (month, location_id, channel_id) DO UPDATE SET budget = excluded.budget');
  for (const [k, amt] of agg) { const [m, b, loc, ch] = k.split('|'); up.run(m, Number(b), Number(loc), Number(ch), Math.round(amt * 100) / 100); }
  const list = (o) => Object.entries(o).slice(0, 6).map(([k, v]) => `${k} ${money(v)}`).join(', ');
  return [
    `${n.toLocaleString()} budget rows loaded: ${money(total)} USD across ${months[0] || '—'} to ${months.at(-1) || '—'}`,
    ...(Object.keys(bad.entity).length ? [`Left out, entity not in the Vena mapping: ${list(bad.entity)}`] : []),
    ...(Object.keys(bad.channel).length ? [`Left out, channel name not recognised: ${list(bad.channel)}`] : []),
    ...(Object.keys(bad.month).length ? [`Left out, month not readable or outside ${SPAN}: ${list(bad.month)}`] : []),
  ];
}

// ---- QuickBooks "Transaction Detail by Account" (brands not on Acumatica) ----
// The report title names the company; each line carries a marketing account, a date, a location and a signed amount.
// It is that brand's official ledger, so it loads into the same GL table as Acumatica.
// Account names Watkins used before adopting the standard "Marketing - …" chart of accounts.
const QB_ACCOUNT_ALIASES = {
  'google advertising': 'marketing - paid search', 'digital advertising': 'marketing - paid search', 'facebook advertising': 'marketing - paid social',
  'advertising design': 'marketing - creative production', advertising: 'marketing - other',
};
// On the marketing export but not marketing spend.
const QB_EXCLUDED_ACCOUNTS = new Set(['employee uniforms']);
const QB_LOCATION_ALIASES = { 'ridgeland, ms': 'jackson, ms' };
const isQuickBooks = (rows) => rows.slice(0, 8).some((r) => ['distribution account', 'transaction date', 'amount'].every((h) => r.some((c) => key(c) === h)));
function importQuickBooks(db, file) {
  const rows = Object.values(parseXlsx(fs.readFileSync(file)))[0] || [];
  const at = rows.findIndex((r) => r.some((c) => key(c) === 'distribution account')), head = rows[at].map(key);
  const C = { account: head.indexOf('distribution account'), date: head.indexOf('transaction date'), loc: head.indexOf('location full name'), amount: head.indexOf('amount'), name: head.indexOf('name'), desc: head.indexOf('description'), num: head.indexOf('num') };
  const detail = [], notMarketing = {};
  const title = key(rows[0]?.[0]);
  const brand = db.prepare('SELECT id, name FROM brand').all().filter((b) => title.startsWith(key(b.name)) || key(b.name).startsWith(title)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!brand) throw new Error(`No Maestro brand matches the company on this report ("${rows[0]?.[0]}"). Import the mappings workbook first.`);
  const byAccount = new Map();
  for (const g of db.prepare('SELECT g.account, g.level1_id, l.name FROM gl_map g JOIN level1 l ON l.id = g.level1_id ORDER BY g.seq').all())
    if (!byAccount.has(g.account) || g.account.endsWith('- ' + key(g.name))) byAccount.set(g.account, g.level1_id);
  if (!byAccount.size) throw new Error('Import the mappings workbook first: it holds the GL account → Level 1 mapping');
  // Market location: match "Tupelo - MS" to "Tupelo, MS"; a bare state ("AL") to the brand's only location in that state; otherwise the brand's ledger entity.
  const locs = db.prepare('SELECT id, name FROM location WHERE brand_id = ?').all(brand.id);
  const fallback = db.prepare('SELECT location_id id FROM entity WHERE brand_id = ? ORDER BY code').get(brand.id)?.id ?? new Ctx(db).location(brand.id, null);
  const locCache = new Map(), unplaced = {};
  const place = (raw) => {
    if (locCache.has(raw)) return locCache.get(raw);
    let k = key(raw).replace(/\s+-\s+/, ', '); k = QB_LOCATION_ALIASES[k] || k;
    const inState = locs.filter((l) => key(l.name).endsWith(', ' + k));
    const hit = locs.find((l) => key(l.name) === k) || (inState.length === 1 ? inState[0] : null);
    locCache.set(raw, hit ? hit.id : fallback);
    return locCache.get(raw);
  };
  const agg = new Map(), noAccount = {}; let total = 0, kept = 0, lines = 0;
  for (const r of rows.slice(at + 1)) {
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(r[C.date] || '').trim());
    if (!d) continue;
    lines++;
    const m = `${d[3]}-${d[1].padStart(2, '0')}`, amt = Number(r[C.amount]) || 0;
    if (!MONTH_SET.has(m)) continue;
    if (QB_EXCLUDED_ACCOUNTS.has(key(r[C.account]))) { notMarketing[r[C.account]] = (notMarketing[r[C.account]] || 0) + amt; continue; }
    const account = QB_ACCOUNT_ALIASES[key(r[C.account])] || ACCOUNT_ALIASES[key(r[C.account])] || key(r[C.account]), l1 = byAccount.get(account);
    if (!l1) { noAccount[r[C.account]] = (noAccount[r[C.account]] || 0) + amt; continue; }
    const loc = place(r[C.loc] || '');
    if (loc === fallback && r[C.loc]) unplaced[r[C.loc]] = (unplaced[r[C.loc]] || 0) + amt;
    const k = `${m}|${loc}|${l1}`;
    agg.set(k, (agg.get(k) || 0) + amt); total += amt; kept++;
    detail.push([m, `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`, brand.id, loc, l1, r[C.account], r[C.name] || null, r[C.desc] || null, r[C.num] || null, amt, 'QuickBooks']);
  }
  db.prepare('DELETE FROM gl WHERE brand_id = ?').run(brand.id);
  db.prepare('DELETE FROM gl_line WHERE brand_id = ?').run(brand.id);
  const insLine = db.prepare('INSERT INTO gl_line (month, day, brand_id, location_id, level1_id, account, vendor, description, ref, amount, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const x of detail) insLine.run(...x);
  const ins = db.prepare('INSERT INTO gl (month, brand_id, location_id, level1_id, amount) VALUES (?, ?, ?, ?, ?)');
  for (const [k, amt] of agg) { const [m, loc, l1] = k.split('|'); ins.run(m, brand.id, Number(loc), Number(l1), Math.round(amt * 100) / 100); }
  const recon = rebuildUnallocated(db);
  const list = (o) => Object.entries(o).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map(([k, v]) => `${k} ${money(v)}`).join(', ');
  return [
    `${brand.name}: ${kept.toLocaleString()} of ${lines.toLocaleString()} ledger lines loaded, ${money(total)} of ${SPAN} marketing spend`,
    ...(Object.keys(noAccount).length ? [`Left out, account not mapped to a Level 1: ${list(noAccount)}`] : []),
    ...(Object.keys(notMarketing).length ? [`Excluded by rule (not marketing): ${list(notMarketing)}`] : []),
    ...(Object.keys(unplaced).length ? [`No matching market location, kept at brand level: ${list(unplaced)}`] : []),
    ...glLines(recon),
  ];
}

const KINDS = {
  mappings: { label: 'Mappings workbook', order: 1, run: importMappings },
  golden: { label: 'Golden record CRM export', order: 2, run: importGolden },
  spend: { label: 'Connected spend feed', order: 3, run: importSpend },
  acumatica: { label: 'Acumatica GL marketing spend', order: 4, run: importAcumatica },
  quickbooks: { label: 'QuickBooks ledger detail (brand not on Acumatica)', order: 5, run: importQuickBooks },
  budget: { label: 'Budget by entity, channel and month', order: 6, run: importBudget },
};

// Recognise a file from its header row or sheet names without reading the whole thing.
export function detect(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.csv') {
      const head = csvRows(file).next().value?.map((h) => h.trim()) || [];
      if (['provider', 'spend_amount_usd', 'campaign_name'].every((h) => head.includes(h))) return 'spend';
      if (['lead_created_at', 'final_contract_amount', 'campaign_name', 'status_name'].every((h) => head.includes(h))) return 'golden';
      if (budgetColumns(head)) return 'budget';
    } else if (ext === '.xlsx') {
      const names = xlsxSheetNames(fs.readFileSync(file));
      if (names.includes('Golden Record Campaign mappings') || names.includes('Campaign Source Mapping')) return 'mappings';
      if (names.includes('Data') && names.includes('Parameters')) return 'acumatica';
      const first = Object.values(parseXlsx(fs.readFileSync(file)))[0] || [];
      if (isQuickBooks(first)) return 'quickbooks';
      if (first.slice(0, 10).some((r) => budgetColumns(r))) return 'budget';
    }
  } catch { /* unreadable or locked: treat as unrecognised */ }
  return null;
}

export function listFolder(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => /\.(csv|xlsx)$/i.test(f) && !f.startsWith('~$')).map((name) => {
    const st = fs.statSync(path.join(dir, name)), kind = detect(path.join(dir, name));
    return { name, size: st.size, modified: st.mtime.toISOString(), kind, label: kind ? KINDS[kind].label : null, order: kind ? KINDS[kind].order : 9 };
  }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function runImport(db, file, user = 'import') {
  const kind = detect(file);
  if (!kind) throw new Error(`${path.basename(file)} is not a file type Maestro recognises`);
  db.exec('BEGIN');
  try {
    const wiped = getMode(db) !== 'real';
    if (wiped) { wipe(db); setMode(db, 'real'); }
    const result = KINDS[kind].run(db, file);
    assignRegions(db); // brands that arrived with this file get a starting region
    // Once nothing points at an old brand-level placeholder, remove it so it leaves the Market location filter.
    db.exec(`DELETE FROM location WHERE name = 'Brand-wide (no location)'
             AND id NOT IN (SELECT location_id FROM spend) AND id NOT IN (SELECT location_id FROM spend_day) AND id NOT IN (SELECT location_id FROM gl)
             AND id NOT IN (SELECT location_id FROM gl_line) AND id NOT IN (SELECT location_id FROM crm_fact) AND id NOT IN (SELECT location_id FROM crm_day)
             AND id NOT IN (SELECT location_id FROM record) AND id NOT IN (SELECT location_id FROM channel_plan) AND id NOT IN (SELECT location_id FROM entity)`);
    db.prepare('INSERT INTO audit (at, user, action, detail) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), user, `imported ${KINDS[kind].label}`, `${path.basename(file)}: ${result.join('; ')}`);
    db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`imported:${kind}`, JSON.stringify({ file: path.basename(file), at: new Date().toISOString(), result }));
    db.exec('COMMIT');
    return { kind, label: KINDS[kind].label, result: wiped ? ['Synthetic demo data cleared', ...result] : result };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
