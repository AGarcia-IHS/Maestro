// Importers for the real extract files. Each one recognises its file and loads it inside a transaction.
// The first real import clears the synthetic demo data. Files can be re-imported; each import replaces its own data.
import fs from 'node:fs';
import path from 'node:path';
import { csvRows, parseXlsx, xlsxSheetNames } from './tabular.js';
import { MONTHS, CLOSED_THROUGH, wipe, getMode, setMode } from '../db.js';

const UNSPEC = '(Unspecified)';
const CHANNEL_ORDER = ['Digital', 'Affiliates', 'Media', 'Direct Mail', 'Local', 'Events', 'Customer Loyalty', 'Other', UNSPEC];
const VENDOR = { google_ads: 'Google', bing_ads: 'Microsoft', meta_ads: 'Meta', active_prospect: 'Active Prospect' };
const GL_SOURCE = 'gl_unallocated';
const key = (s) => String(s ?? '').toLowerCase().replace(/[`’]/g, "'").replace(/\s+/g, ' ').trim();
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const isOpen = (m) => m > CLOSED_THROUGH;

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
    if (m !== CLOSED_THROUGH) continue;
    for (const o of MONTHS.filter(isOpen)) if (!agg.has(`${camp}|${loc}|${o}`)) agg.set(`${camp}|${loc}|${o}`, 0), kept.has(`${camp}|${loc}|${o}`) || kept.set(`${camp}|${loc}|${o}`, Math.round(amt));
  }
  const ins = db.prepare('INSERT INTO spend (campaign_id, location_id, month, budget, actual, projected) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [k, amt] of agg) {
    const [camp, loc, m] = k.split('|');
    const prev = agg.get(`${camp}|${loc}|${MONTHS[MONTHS.indexOf(m) - 1]}`) || 0;
    const projected = isOpen(m) ? kept.get(k) ?? Math.max(amt, prev) : amt;
    ins.run(Number(camp), Number(loc), m, budgets.get(k) || 0, Math.round(amt * 100) / 100, Math.round(projected));
  }
}

// GL spend that no connected feed explains is parked on one "Unallocated GL" campaign per brand and Level 1,
// so every ledger dollar shows up in ROI at Level 1 and can later be split out to real campaigns.
export function rebuildUnallocated(db) {
  const c = new Ctx(db);
  const feed = new Map(db.prepare(`SELECT c.brand_id b, c.level1_id l, s.month m, SUM(s.actual) t FROM spend s JOIN campaign c ON c.id = s.campaign_id
                                   WHERE c.source <> '${GL_SOURCE}' GROUP BY 1, 2, 3`).all().map((r) => [`${r.b}|${r.l}|${r.m}`, r.t]));
  const groups = new Map();
  for (const g of db.prepare('SELECT month, brand_id, level1_id, location_id, amount FROM gl').all()) {
    const k = `${g.brand_id}|${g.level1_id}|${g.month}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(g);
  }
  const l1name = Object.fromEntries(db.prepare('SELECT id, name FROM level1').all().map((r) => [r.id, r.name]));
  const agg = new Map(), ids = new Set(db.prepare(`SELECT id FROM campaign WHERE source = '${GL_SOURCE}'`).all().map((r) => r.id));
  let total = 0;
  for (const [k, rows] of groups) {
    const [b, l, m] = k.split('|');
    const residual = rows.reduce((a, r) => a + r.amount, 0) - (feed.get(k) || 0);
    if (residual < 1) continue;
    const camp = c.campaign(Number(b), `Unallocated GL – ${l1name[l]}`, Number(l), GL_SOURCE, null).id;
    ids.add(camp); total += residual;
    const pos = rows.filter((r) => r.amount > 0), base = pos.reduce((a, r) => a + r.amount, 0);
    for (const r of pos.length ? pos : [rows[0]]) {
      const kk = `${camp}|${r.location_id}|${m}`;
      agg.set(kk, (agg.get(kk) || 0) + (base ? residual * (r.amount / base) : residual));
    }
  }
  writeSpend(db, agg, ids);
  return total;
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
  const c = new Ctx(db), agg = new Map(), touched = new Set(), noFx = {}, providers = new Set();
  let C, rows = 0, noFxRows = 0, outside = 0, total = 0;
  for (const r of csvRows(file)) {
    if (!C) { C = Object.fromEntries(r.map((h, i) => [h.trim(), i])); continue; }
    rows++;
    const m = r[C.date].slice(0, 7), usd = r[C.spend_amount_usd];
    if (!MONTHS.includes(m)) { outside++; continue; }
    if (usd === '' || usd == null) { noFxRows++; noFx[r[C.currency]] = (noFx[r[C.currency]] || 0) + Number(r[C.spend_amount] || 0); continue; }
    if (!r[C.brand_name]) continue;
    const provider = r[C.provider], b = c.brand(r[C.brand_name]), l1 = c.level1(r[C.campaign_level_one_name] || UNSPEC, r[C.campaign_channel_name]);
    const camp = c.campaign(b, r[C.campaign_name] || '(no campaign name)', l1, provider, VENDOR[provider]);
    if (!camp.isNew && !touched.has(camp.id)) db.prepare('UPDATE campaign SET source = ?, vendor = COALESCE(vendor, ?) WHERE id = ?').run(provider, VENDOR[provider] || null, camp.id);
    touched.add(camp.id); providers.add(provider);
    const k = `${camp.id}|${c.location(b, r[C.market_location_name])}|${m}`;
    agg.set(k, (agg.get(k) || 0) + Number(usd)); total += Number(usd);
  }
  // A full feed replaces everything previously loaded from the same providers.
  for (const r of db.prepare(`SELECT id FROM campaign WHERE source IN (${[...providers].map((p) => `'${p.replace(/'/g, '')}'`).join(',') || "''"})`).all()) touched.add(r.id);
  writeSpend(db, agg, touched);
  const unallocated = rebuildUnallocated(db);
  return [
    `${rows.toLocaleString()} daily rows from ${[...providers].join(', ')}: ${money(total)} loaded across ${touched.size} campaigns`,
    ...(noFxRows ? [`${noFxRows} rows have no USD amount yet and were left out (${Object.entries(noFx).filter(([, v]) => v > 0).map(([k, v]) => `${Math.round(v).toLocaleString()} ${k}`).join(', ')} awaiting an FX rate)`] : []),
    ...(outside ? [`${outside} rows fall outside ${MONTHS[0].slice(0, 4)} and were left out`] : []),
    `${c.created.campaigns} new campaigns; ${money(unallocated)} of GL spend is not explained by a feed`,
  ];
}

// ---- Golden record CRM export ----------------------------------------------
// Definitions follow Sales_Funnel_Metric_Definitions_v3 (activity view):
//   Leads        non-cloned records, by lead created date
//   Appointments non-cloned, qualified records with an appointment booked, by appointment created date
//   Sales        non-cloned sold or completed records, by closed date
//   Bookings $   final contract amount of every sold or completed record (clones included), by closed date
function importGolden(db, file) {
  const c = new Ctx(db), agg = new Map(), keyCache = new Map(), won = new Set(['sold', 'completed']);
  let C, rows = 0;
  const T = { leads: 0, appts: 0, sales: 0, bookings: 0 };
  const bump = (nameKey, date, field, v) => {
    const m = date.slice(0, 7);
    if (!MONTHS.includes(m)) return;
    const k = `${nameKey}|${m}`; let a = agg.get(k);
    if (!a) agg.set(k, (a = { leads: 0, appts: 0, sales: 0, bookings: 0 }));
    a[field] += v; T[field] += v;
  };
  for (const r of csvRows(file)) {
    if (!C) { C = Object.fromEntries(r.map((h, i) => [h.trim(), i])); continue; }
    rows++;
    const year = MONTHS[0].slice(0, 4);
    if (!r[C.lead_created_at].startsWith(year) && !r[C.appointment_created_at].startsWith(year) && !r[C.closed_at].startsWith(year)) continue;
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
  return [
    `${rows.toLocaleString()} golden records read; ${MONTHS[0].slice(0, 4)} activity kept`,
    `${T.leads.toLocaleString()} leads, ${T.appts.toLocaleString()} appointments, ${T.sales.toLocaleString()} sales, ${money(T.bookings)} bookings`,
    `${c.created.campaigns} new CRM campaigns, ${c.created.locations} new market locations`,
  ];
}

// ---- Acumatica GL marketing spend ------------------------------------------
function importAcumatica(db, file) {
  const data = table(parseXlsx(fs.readFileSync(file)).Data, ['AccountName', 'Branch', 'Period', 'Debit', 'Credit']);
  const entities = new Map(db.prepare('SELECT code, brand_id, location_id FROM entity').all().map((e) => [e.code, e]));
  if (!entities.size) throw new Error('Import the mappings workbook first: it holds the branch → brand and GL account → Level 1 mappings');
  // One GL account can feed several Level 1s. Until lines are split by hand, each account lands on the Level 1
  // that shares its name ("Marketing - Other" → Other), or failing that the first one listed in the mapping.
  const byAccount = new Map();
  for (const g of db.prepare('SELECT g.account, g.level1_id, l.name FROM gl_map g JOIN level1 l ON l.id = g.level1_id ORDER BY g.seq').all())
    if (!byAccount.has(g.account) || g.account.endsWith('- ' + key(g.name))) byAccount.set(g.account, g.level1_id);
  const agg = new Map(), noBranch = {}, noAccount = {}, ledgers = {};
  let total = 0, kept = 0;
  for (const r of data) {
    const [mm, yyyy] = r.Period.split('-'), m = `${yyyy}-${mm}`, amt = (Number(r.Debit) || 0) - (Number(r.Credit) || 0);
    if (!MONTHS.includes(m)) continue;
    if (r.Ledger && r.Ledger !== 'ACTUAL') { ledgers[r.Ledger] = (ledgers[r.Ledger] || 0) + amt; continue; }
    const e = entities.get(r.Branch), l1 = byAccount.get(key(r.AccountName));
    if (!e) { noBranch[`${r.Branch} ${r['Branch Name']}`] = (noBranch[`${r.Branch} ${r['Branch Name']}`] || 0) + amt; continue; }
    if (!l1) { noAccount[r.AccountName] = (noAccount[r.AccountName] || 0) + amt; continue; }
    const k = `${m}|${e.brand_id}|${e.location_id}|${l1}`;
    agg.set(k, (agg.get(k) || 0) + amt); total += amt; kept++;
  }
  db.exec('DELETE FROM gl');
  const ins = db.prepare('INSERT INTO gl (month, brand_id, location_id, level1_id, amount) VALUES (?, ?, ?, ?, ?)');
  for (const [k, amt] of agg) { const [m, b, loc, l1] = k.split('|'); ins.run(m, Number(b), Number(loc), Number(l1), Math.round(amt * 100) / 100); }
  const unallocated = rebuildUnallocated(db);
  const list = (o) => Object.entries(o).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map(([k, v]) => `${k} ${money(v)}`).join(', ');
  return [
    `${kept.toLocaleString()} of ${data.length.toLocaleString()} ledger lines loaded: ${money(total)} of ${MONTHS[0].slice(0, 4)} marketing spend`,
    `${money(unallocated)} is not explained by a connected feed and sits on "Unallocated GL" campaigns by Level 1`,
    ...(Object.keys(noBranch).length ? [`Left out, branch not in the Vena mapping: ${list(noBranch)}`] : []),
    ...(Object.keys(noAccount).length ? [`Left out, GL account not mapped to a Level 1: ${list(noAccount)}`] : []),
    ...(Object.keys(ledgers).length ? [`Left out, non-actual ledgers: ${list(ledgers)}`] : []),
  ];
}

const KINDS = {
  mappings: { label: 'Mappings workbook', order: 1, run: importMappings },
  golden: { label: 'Golden record CRM export', order: 2, run: importGolden },
  spend: { label: 'Connected spend feed', order: 3, run: importSpend },
  acumatica: { label: 'Acumatica GL marketing spend', order: 4, run: importAcumatica },
};

// Recognise a file from its header row or sheet names without reading the whole thing.
export function detect(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.csv') {
      const head = csvRows(file).next().value?.map((h) => h.trim()) || [];
      if (['provider', 'spend_amount_usd', 'campaign_name'].every((h) => head.includes(h))) return 'spend';
      if (['lead_created_at', 'final_contract_amount', 'campaign_name', 'status_name'].every((h) => head.includes(h))) return 'golden';
    } else if (ext === '.xlsx') {
      const names = xlsxSheetNames(fs.readFileSync(file));
      if (names.includes('Golden Record Campaign mappings') || names.includes('Campaign Source Mapping')) return 'mappings';
      if (names.includes('Data') && names.includes('Parameters')) return 'acumatica';
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
    db.prepare('INSERT INTO audit (at, user, action, detail) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), user, `imported ${KINDS[kind].label}`, `${path.basename(file)}: ${result.join('; ')}`);
    db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`imported:${kind}`, JSON.stringify({ file: path.basename(file), at: new Date().toISOString(), result }));
    db.exec('COMMIT');
    return { kind, label: KINDS[kind].label, result: wiped ? ['Synthetic demo data cleared', ...result] : result };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
