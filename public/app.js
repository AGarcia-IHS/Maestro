// Maestro prototype front end. Plain ES modules, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sym = () => (state.cur === 'CAD' ? 'CA$' : '$');
const money = (n) => (n < 0 ? '-' : '') + sym() + Math.abs(Math.round(n)).toLocaleString('en-US');
const compact = (n) => { const a = Math.abs(n); return (n < 0 ? '-' : '') + sym() + (a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : Math.round(a).toLocaleString('en-US')); };
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—');
const ratio = (a, b, f) => (b > 0.5 ? f(a / b) : '—');
const cost = (a, b) => (a > 0 && b > 0 ? money(a / b) : '—');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (m) => MON[Number(m.slice(5)) - 1];
const COLORS = new Proxy([], { get: (_, i) => `var(--s${Math.min(9, Number(i) + 1)})` }); // channel colour by position; extras fold to grey
const PLATFORMS = ['google_ads', 'bing_ads', 'meta_ads', 'active_prospect'];
const PLATFORM_NAME = { google_ads: 'Google Ads', bing_ads: 'Bing Ads', meta_ads: 'Meta', active_prospect: 'Active Prospect', gl_assigned: 'Ledger' };
const ROLES = { marketer: 'Marketing manager (demo)', approver: 'Approver (demo)', finance: 'Finance (demo)' };

const saved = (() => { try { return localStorage.getItem('maestro-currency'); } catch { return null; } })();
const state = { ledger: { show: 'open', q: '' }, vsMode: 'budget', chartMode: 'channel', pMeasure: 'spend', pBasis: 't3', pOpen: new Set(), grain: 'month', dateMode: 'months', dFrom: '', dTo: '', rangeYear: '', prevRange: null, division: '', region: '', hiddenCh: new Set(), year: '', cur: saved === 'CAD' ? 'CAD' : 'USD', brand: '', location: '', role: 'marketer', measure: 'spend', from: null, to: null, open: new Set(), mapTab: 'names', glMonth: null };
let meta, facts;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Maestro-Role': state.role, 'X-Maestro-Currency': state.cur, 'X-Maestro-User': ROLES[state.role] },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), err ? 5000 : 2500);
}
const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await render(); } catch (e) { toast(e.message, true); } };
const scope = () => new URLSearchParams(Object.entries({ division: state.division, region: state.region, brand: state.brand, location: state.location }).filter(([, v]) => v)).toString();
const opts = (rows, sel, label = (r) => r.name) => rows.map((r) => `<option value="${r.id}" ${String(r.id) === String(sel) ? 'selected' : ''}>${esc(label(r))}</option>`).join('');
const closed = (m) => m <= meta.closedThrough;
const yearMonths = () => meta.months.filter((m) => m.startsWith(state.year));
const brandCode = (id) => meta.brands.find((b) => b.id === id)?.code;

// ---- shared model ----------------------------------------------------------
function buildModel(f, rollup = false) {
  const l1 = Object.fromEntries(meta.level1.map((l) => [l.id, l]));
  const ch = Object.fromEntries(meta.channels.map((c) => [c.id, c]));
  const blank = () => ({ budget: 0, actual: 0, projected: 0, leads: 0, appts: 0, sales: 0, bookings: 0 });
  const camps = new Map(f.campaigns.map((c) => [c.id, { ...c, level1: l1[c.level1_id], channel: ch[l1[c.level1_id].channel_id], m: {} }]));
  const unmapped = {};
  const cell = (store, m) => (store[m] ||= blank());
  for (const s of f.spend) { const c = camps.get(s.campaign_id); if (c) Object.assign(cell(c.m, s.month), { budget: s.budget, actual: s.actual, projected: s.projected }); }
  for (const k of f.crm) {
    const c = k.campaign_id ? camps.get(k.campaign_id) : null;
    Object.assign(cell(c ? c.m : unmapped, k.month), { leads: k.leads, appts: k.appts, sales: k.sales, bookings: k.bookings });
  }
  if (rollup) for (const c of [...camps.values()]) {
    const target = c.linked_to && camps.get(c.linked_to);
    if (!target) continue;
    for (const [m, v] of Object.entries(c.m)) { const t = cell(target.m, m); t.budget += v.budget; t.actual += v.actual; t.projected += v.projected; }
    (target.sourceList ||= []).push(c); target.sources = target.sourceList.length; camps.delete(c.id);
  }
  return { camps: [...camps.values()], unmapped, blank };
}
function sum(c, months, into) {
  const t = into || { budget: 0, actual: 0, projected: 0, leads: 0, appts: 0, sales: 0, bookings: 0 };
  for (const m of months) { const v = c.m ? c.m[m] : c[m]; if (v) for (const k in t) t[k] += v[k]; }
  return t;
}
const add = (a, b) => { for (const k in a) a[k] += b[k]; return a; };

// ---- dates -----------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
const toDate = (d) => new Date(d + 'T12:00:00');
const iso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const addDays = (d, n) => { const dt = toDate(d); dt.setDate(dt.getDate() + n); return iso(dt); };
const monthStart = (m) => m + '-01';
const monthEnd = (m) => iso(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0, 12));
const niceDay = (d, withYear = true) => toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
const GRAINS = { day: 'Day', week: 'Week', month: 'Month' };
// How a bucket key reads on the axis and in a tooltip, and the dates it covers.
const bucketLabel = { month: (k, bw = 99) => (bw >= 70 ? `${mlabel(k)} ${k.slice(0, 4)}` : bw < 30 ? mlabel(k)[0] : mlabel(k)), week: (k) => niceDay(k, false), day: (k) => niceDay(k, false) };
const bucketTitle = { month: (k) => `${mlabel(k)} ${k.slice(0, 4)}`, week: (k) => `Week of ${niceDay(k)}`, day: (k) => toDate(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) };
const bucketSpan = { month: (k) => [monthStart(k), monthEnd(k)], week: (k) => [k, addDays(k, 6)], day: (k) => [k, k] };

// ---- chart -----------------------------------------------------------------
// Stacked bars drawn at the real pixel width of their container and redrawn when that changes.
// A click on a bar and a double-click on a colour are told apart by a short delay.
function stackedChart(host, opts) {
  const { buckets, series, markers, fmt, label, title, onBucket, onSeries, hint, line, compare, compareName } = opts;
  const W = Math.max(300, Math.round(host.clientWidth || 960)), H = Math.round(Math.min(440, Math.max(230, W * 0.34)));
  const L = W < 520 ? 46 : 62, R = 14, T = 24, B = 32, pw = W - L - R, ph = H - T - B, n = Math.max(1, buckets.length);
  const totals = buckets.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i]), 0));
  const peak = line ? Math.max(0, ...series.flatMap((s) => s.values)) : Math.max(0, ...totals);
  const max = Math.max(1e-9, peak, ...(markers || []), ...(compare || []).filter((v) => v != null));
  const step = (() => { const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  const top = Math.ceil((max * (line ? 1.02 : 1.06)) / step) * step, y = (v) => T + ph - (v / top) * ph, bw = pw / n, w = Math.max(1, Math.min(150, bw * (bw < 6 ? 0.85 : 0.72)));
  const cx = (i) => L + bw * i + bw / 2, every = Math.max(1, Math.ceil(58 / bw)), gap = w >= 6 ? 1 : 0, stacks = [];
  let svg = `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="none" stroke="var(--grid)"/>`;
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? 'var(--grid)' : 'var(--axis)'}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  if (n <= 62) for (let i = 1; i < n; i++) svg += `<line x1="${L + bw * i}" x2="${L + bw * i}" y1="${T}" y2="${T + ph}" stroke="var(--grid)"/>`;
  svg += `<rect class="hov" x="0" y="${T}" width="${bw}" height="${ph}" fill="var(--ink)" opacity="0" pointer-events="none"/>`;
  if (line) {
    // Days read better as lines: one per series, with a point on each day when there is room.
    for (const s of series) {
      svg += `<path d="M${s.values.map((v, i) => `${cx(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`).join(' L')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n <= 45) svg += s.values.map((v, i) => `<circle cx="${cx(i)}" cy="${y(Math.max(0, v))}" r="3" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`).join('');
    }
    buckets.forEach((_, i) => stacks.push(series.map((s) => ({ id: s.id, at: y(Math.max(0, s.values[i])) }))));
  } else buckets.forEach((b, i) => {
    const x = L + bw * i + (bw - w) / 2, live = series.filter((s) => s.values[i] > 0), segs = [];
    let base = 0;
    live.forEach((s, k) => {
      const v = s.values[i], h = Math.max(0, y(base) - y(base + v) - (k < live.length - 1 ? gap : 0)), r = k === live.length - 1 ? Math.min(3, h, w / 2) : 0, yt = y(base) - h;
      svg += `<path d="M${x},${yt + h}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yt + h}Z" fill="${s.color}"/>`;
      segs.push({ id: s.id, y0: yt, y1: yt + h + gap });
      base += v;
    });
    stacks.push(segs);
    if (markers && markers[i] > 0) svg += `<line x1="${x - 5}" x2="${x + w + 5}" y1="${y(markers[i])}" y2="${y(markers[i])}" stroke="var(--ink)" stroke-width="2"/>`;
    if (bw >= 38 && totals[i] > 0) svg += `<text class="tot" x="${cx(i)}" y="${y(totals[i]) - 6}" text-anchor="middle">${fmt(totals[i])}</text>`;
  });
  // The same period a year earlier, as a dashed line over the bars.
  if (compare && compare.some((v) => v != null)) {
    const pts = compare.map((v, i) => (v == null ? null : [cx(i), y(v)])).filter(Boolean);
    svg += `<path d="M${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' L')}" fill="none" stroke="var(--py)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>`;
    if (n <= 62) svg += pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" fill="var(--py)" stroke="var(--surface)" stroke-width="2"/>`).join('');
  }
  buckets.forEach((b, i) => {
    if (i % every === 0) svg += `<text class="ax" x="${cx(i)}" y="${H - 10}" text-anchor="middle">${label(b, bw)}</text>`;
    svg += `<rect data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}" fill="transparent" style="cursor:${onBucket || onSeries ? 'pointer' : 'default'}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${line ? 'Lines' : 'Stacked bars'} over time">${svg}</svg><div class="tip"></div>`;
  const tip = $('.tip', host), hov = $('.hov', host), svgEl = $('svg', host);
  const segAt = (e) => {
    const i = e.target.dataset?.i; if (i == null) return null;
    const box = svgEl.getBoundingClientRect(), py = (e.clientY - box.top) * (H / box.height);
    if (!line) return stacks[i].find((s) => py >= s.y0 && py <= s.y1) || null;
    const near = stacks[i].map((s) => ({ ...s, d: Math.abs(s.at - py) })).sort((a, b) => a.d - b.d)[0];
    return near && near.d <= 14 ? near : null;
  };
  let timer;
  host.onclick = (e) => { const i = e.target.dataset?.i; if (i == null || !onBucket) return; clearTimeout(timer); timer = setTimeout(() => onBucket(buckets[i]), 260); };
  host.ondblclick = (e) => { clearTimeout(timer); const s = segAt(e); if (s && onSeries) onSeries(s.id); };
  host.onmousemove = (e) => {
    const i = e.target.dataset?.i; if (i == null) { hov.setAttribute('opacity', 0); return (tip.style.display = 'none'); }
    hov.setAttribute('x', L + bw * i); hov.setAttribute('opacity', 0.05);
    const at = segAt(e);
    tip.innerHTML = `<b>${title(buckets[i])}</b>` +
      series.filter((s) => s.values[i]).map((s) => `<div ${at?.id === s.id ? 'style="font-weight:700"' : ''}><span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span><span>${fmt(s.values[i])}</span></div>`).join('') +
      `<div><span><b style="display:inline">Total</b></span><span><b style="display:inline">${fmt(totals[i])}</b></span></div>` +
      (compare && compare[i] != null ? `<div><span><i class="dot" style="background:var(--py);border-radius:50%"></i>${compareName || 'Prior year'}</span><span>${fmt(compare[i])}</span></div>` : '') +
      (markers ? `<div><span>Budget</span><span>${fmt(markers[i])}</span></div>` : '') + (hint ? `<div style="margin-top:4px"><span>${hint}</span></div>` : '');
    const box = host.getBoundingClientRect(); tip.style.display = 'block';
    tip.style.left = Math.max(0, Math.min(e.clientX - box.left + 14, box.width - tip.offsetWidth - 4)) + 'px'; tip.style.top = Math.max(0, e.clientY - box.top - 20) + 'px';
  };
  host.onmouseleave = () => { tip.style.display = 'none'; hov.setAttribute('opacity', 0); };
  host._ro?.disconnect();
  host._ro = new ResizeObserver(() => { if (host.isConnected && Math.abs(host.clientWidth - W) > 6 && host.clientWidth > 0) stackedChart(host, opts); });
  host._ro.observe(host);
}
// Turn series rows from the server into chart series for one measure.
function pivot(data, measure, names, colorOf) {
  const idx = new Map(data.buckets.map((b, i) => [b, i])), by = new Map();
  for (const r of data.rows) {
    if (r.key == null) continue;
    const s = by.get(r.key) || by.set(r.key, { id: r.key, name: names(r.key), values: data.buckets.map(() => 0), total: { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 } }).get(r.key);
    s.values[idx.get(r.bucket)] += r[measure] || 0;
    for (const k in s.total) s.total[k] += r[k] || 0;
  }
  return [...by.values()].map((s) => ({ ...s, color: colorOf(s.id) }));
}

// ---- Insights --------------------------------------------------------------
const MEASURES = { spend: 'Spend', leads: 'Leads', appts: 'Appointments', sales: 'Sales', bookings: 'Bookings $' };
const rangeQuery = () => scope() + `&from=${state.dFrom}&to=${state.dTo}`;
let ins = null; // what the Insights screen last loaded
const yearBack = (d) => { const y = Number(d.slice(0, 4)) - 1, rest = d.slice(4) === '-02-29' ? '-02-28' : d.slice(4); return y + rest; };
// "VS. PY" chips in the portal's style: the change in the figure and in percent against the same dates last year.
function pyChips(now, before, { fmt, goodWhenUp = true, neutral = false, points = false }) {
  if (before == null || !Number.isFinite(before) || Math.abs(before) < 1e-9 || now == null) return '<div class="py"><span class="chip pyl">VS. PY</span><span class="muted" style="font-size:11.5px">no prior-year figure</span></div>';
  const diff = now - before, up = diff >= 0, cls = neutral ? 'flat' : up === goodWhenUp ? 'good' : 'bad';
  return `<div class="py"><span class="chip pyl">VS. PY</span><span class="chip ${cls}">${up ? '+' : '−'}${fmt(Math.abs(diff))}${points ? '' : ''}</span><span class="chip ${cls}">${up ? '▲' : '▼'} ${up ? '+' : '−'}${(Math.abs(diff / before) * 100).toFixed(1)}%</span></div>`;
}
async function insights(el) {
  const closedMonths = yearMonths().filter(closed);
  if (!closedMonths.length) { el.innerHTML = `<h1>Maestro <span class="hl">Insights</span> · ${state.year}</h1><div class="card">No months of ${state.year} are closed yet, so there are no actuals or outcomes to analyse. Insights fills in as actuals arrive; budgets and forecasts for ${state.year} are on the Projections screen. <button class="primary" id="back-year" style="margin-left:8px">Show ${meta.closedThrough.slice(0, 4)}</button></div>`; $('#back-year').onclick = () => { state.year = meta.closedThrough.slice(0, 4); $('#f-year').value = state.year; render(); }; return; }
  if (state.rangeYear !== state.year || !state.dFrom) { state.rangeYear = state.year; state.dFrom = monthStart(closedMonths[0]); state.dTo = monthEnd(closedMonths.at(-1)); state.prevRange = null; }
  const pyFrom = yearBack(state.dFrom), pyTo = yearBack(state.dTo), hasPy = pyFrom >= meta.months[0] + '-01';
  const [f, range, series, py, pySeries] = await Promise.all([api('/api/facts?' + scope()), api('/api/range?' + rangeQuery()), api(`/api/series?${rangeQuery()}&grain=${state.grain}&group=channel`),
    hasPy ? api(`/api/totals?${scope()}&from=${pyFrom}&to=${pyTo}`) : null,
    hasPy ? api(`/api/series?${scope()}&from=${pyFrom}&to=${pyTo}&grain=${state.grain}&group=channel`) : null]);
  facts = f; ins = { range, series, py, pySeries, pyFrom, pyTo };
  if (state.chartMode === 'compare') ins.plan = await api(`/api/projections?${scope()}&year=${state.year}`);
  drawInsights(el);
}
function drawInsights(el) {
  const l1 = Object.fromEntries(meta.level1.map((l) => [l.id, l])), ch = Object.fromEntries(meta.channels.map((c) => [c.id, c]));
  const zero = () => ({ actual: 0, budget: 0, leads: 0, appts: 0, sales: 0, bookings: 0 });
  const camps = new Map(facts.campaigns.map((c) => [c.id, { ...c, level1: l1[c.level1_id], channel: ch[l1[c.level1_id].channel_id], t: zero() }]));
  const un = zero();
  for (const r of ins.range.rows) { const t = r.key == null ? un : camps.get(r.key)?.t; if (t) { t.actual += r.spend; t.leads += r.leads; t.appts += r.appts; t.sales += r.sales; t.bookings += r.bookings; } }
  // Ad-platform spend that is linked to a CRM campaign is shown on that campaign, with its sources kept for the drill-down.
  const feeds = [...camps.values()].filter((c) => PLATFORMS.includes(c.source));
  const feedSpend = feeds.reduce((a, c) => a + c.t.actual, 0), feedLinked = feeds.filter((c) => c.linked_to || c.t.leads > 0).reduce((a, c) => a + c.t.actual, 0);
  for (const c of [...camps.values()]) {
    const target = c.linked_to && camps.get(c.linked_to);
    if (!target) continue;
    target.t.actual += c.t.actual; (target.sourceList ||= []).push(c); target.sources = target.sourceList.length; camps.delete(c.id);
  }
  const rows = [...camps.values()].map((c) => ({ c, t: c.t })).filter((r) => Math.abs(r.t.actual) > 0.005 || r.t.leads || r.t.appts || r.t.sales);
  const tot = rows.reduce((t, r) => add(t, r.t), zero());
  const budgetOf = (chId) => ins.range.budget.reduce((a, p) => a + (chId == null || p.channel_id === chId ? p.budget : 0), 0);
  tot.budget = budgetOf();
  // The table can set spend against the fixed budget or against the current projection.
  const vsPlan = state.vsMode === 'plan', vsName = vsPlan ? 'Projection' : 'Budget';
  const planOf = (chId) => ins.range.plan.reduce((a, p) => a + (chId == null || p.channel_id === chId ? p.plan : 0), 0);
  const cmpCh = (chId) => (vsPlan ? planOf(chId) : budgetOf(chId));
  const l1Budget = new Map(ins.range.budgetL1.map((b) => [b.level1_id, b.budget]));
  // Projections are held by channel, so a Level 1's projection is its budget scaled by how far its channel has moved from budget.
  const cmpL1 = (l) => { const b = l1Budget.get(l.id) || 0, chB = budgetOf(l.channel_id); return !vsPlan ? b : chB > 0 ? b * (planOf(l.channel_id) / chB) : 0; };
  const blended = tot.actual ? tot.bookings / tot.actual : 0;
  const weak = (r) => !r.c.source.startsWith('gl_') && r.t.leads > 0 && r.t.actual > tot.actual * 0.01 && r.t.bookings / r.t.actual < blended * 0.5;
  const v = tot.budget ? tot.actual / tot.budget - 1 : 0;
  const all = add({ ...tot }, un);
  // Each KPI card carries a small trend of the metric across the chart's current intervals.
  const spark = (m) => {
    const idx = new Map(ins.series.buckets.map((k, i) => [k, i])), top = ins.series.buckets.map(() => 0), bottom = ins.series.buckets.map(() => 0);
    for (const r of ins.series.rows) { const i = idx.get(r.bucket); if (m === 'roas') { top[i] += r.bookings; bottom[i] += r.spend; } else top[i] += r[m] || 0; }
    const vals = m === 'roas' ? top.map((x, i) => (bottom[i] > 0.5 ? x / bottom[i] : 0)) : top, max = Math.max(...vals, 1e-9);
    if (vals.length < 2) return '';
    const pts = vals.map((x, i) => `${((i / (vals.length - 1)) * 100).toFixed(2)},${(30 - (Math.max(0, x) / max) * 26).toFixed(2)}`);
    return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="M0,32 L${pts.join(' L')} L100,32 Z"/><path class="line" d="M${pts.join(' L')}"/></svg>`;
  };
  const P = ins.py, roasOf = (b, s) => (s > 0.5 ? b / s : null);
  const py = {
    spend: pyChips(tot.actual, P?.spend, { fmt: compact, neutral: true }), leads: pyChips(all.leads, P?.leads, { fmt: int }), appts: pyChips(all.appts, P?.appts, { fmt: int }),
    sales: pyChips(all.sales, P?.sales, { fmt: int }), bookings: pyChips(all.bookings, P?.bookings, { fmt: compact }),
    roas: pyChips(roasOf(all.bookings, tot.actual), P ? roasOf(P.bookings, P.spend) : null, { fmt: (x) => x.toFixed(1) + 'x' }),
  };
  const tiles = [
    ['spend', compact(tot.actual), tot.budget ? `<span class="${v > 0 ? 'down' : 'up'}">${v > 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span> vs budget ${compact(tot.budget)}` : 'No budget loaded yet'],
    ['leads', int(all.leads), `CPL ${cost(tot.actual, all.leads)}`],
    ['appts', int(all.appts), `CPA ${cost(tot.actual, all.appts)}`],
    ['sales', int(all.sales), `Closing rate ${ratio(all.sales, all.appts, pct)}`],
    ['bookings', compact(all.bookings), `Conversion ${ratio(all.appts, all.leads, pct)} lead → appt`],
    ['roas', ratio(all.bookings, tot.actual, (x) => x.toFixed(1) + 'x'), `MCOB ${ratio(tot.actual, all.bookings, pct)}`],
  ];
  const wholeMonths = state.dFrom.endsWith('-01') && state.dTo === monthEnd(state.dTo.slice(0, 7));
  const rangeText = wholeMonths ? (state.dFrom.slice(0, 7) === state.dTo.slice(0, 7) ? bucketTitle.month(state.dFrom.slice(0, 7)) : `${bucketTitle.month(state.dFrom.slice(0, 7))} to ${bucketTitle.month(state.dTo.slice(0, 7))}`) : `${niceDay(state.dFrom)} to ${niceDay(state.dTo)}`;
  // Footnote: third-party campaign detail only exists from the day each platform feed was switched on.
  const starts = Object.entries(meta.feedStart || {}).sort((a, b) => a[1].localeCompare(b[1]));
  const feedNote = starts.length && state.dFrom <= starts.at(-1)[1]
    ? `<p class="sub" style="margin:12px 0 0">Note: ad-platform campaign detail begins when each feed was switched on (${starts.map(([p, d]) => `${PLATFORM_NAME[p] || p} ${niceDay(d)}`).join(', ')}) and cannot be backfilled. Before those dates, spend for those platforms comes from the ledger only and shows as "Other GL spend" with no campaign names, so for earlier periods campaign-level CPL and CPA read lower, and ROAS higher, than they really were. Level 1 and channel figures are unaffected.</p>` : '';
  const dayNote = wholeMonths && state.grain === 'month' ? '' : `<p class="sub" style="margin:8px 0 0">Note: ad-platform spend and CRM outcomes are shown on the day they happened. Ledger-only spend has no meaningful day, so each month's amount is spread evenly across that month's days; part-month and weekly figures for it are estimates.</p>`;
  const head = '<tr><th>Channel / Level 1 / Campaign</th><th>Spend</th><th>' + vsName + '</th><th>Var</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th>CPL</th><th>CPA</th><th>Close %</th><th>ROAS</th><th title="Marketing cost of bookings: spend as a share of bookings">MCOB</th><th class="l">Flag</th></tr>';
  const line = (cls, key, label, t, flag = '') => `<tr class="${cls}" ${key ? `data-key="${key}"` : ''}><td>${label}</td><td>${money(t.actual)}</td><td>${t.budget ? money(t.budget) : '—'}</td>
    <td class="${t.budget && t.actual > t.budget ? 'down' : ''}">${ratio(t.actual - t.budget, t.budget, (x) => (x > 0 ? '+' : '') + pct(x))}</td><td>${int(t.leads)}</td><td>${int(t.appts)}</td><td>${int(t.sales)}</td><td>${money(t.bookings)}</td>
    <td>${cost(t.actual, t.leads)}</td><td>${cost(t.actual, t.appts)}</td><td>${ratio(t.sales, t.appts, pct)}</td><td>${ratio(t.bookings, t.actual, (x) => x.toFixed(1) + 'x')}</td><td>${t.actual > 0 ? ratio(t.actual, t.bookings, pct) : '—'}</td><td class="l">${flag}</td></tr>`;
  let body = '';
  meta.channels.forEach((c, ci) => {
    const inCh = rows.filter((r) => r.c.channel.id === c.id); if (!inCh.length) return;
    const chOpen = !state.open.has('c' + c.id); // channels start expanded
    body += line('ch', 'c' + c.id, `${chOpen ? '▾' : '▸'} <i class="dot" style="background:${COLORS[ci]}"></i>${esc(c.name)}`, Object.assign(inCh.reduce((t, r) => add(t, r.t), zero()), { budget: cmpCh(c.id) }));
    if (!chOpen) return;
    for (const l of meta.level1.filter((x) => x.channel_id === c.id)) {
      const inL = inCh.filter((r) => r.c.level1.id === l.id); if (!inL.length) continue;
      const lOpen = state.open.has('l' + l.id), nWeak = inL.filter(weak).length;
      body += line('l1', 'l' + l.id, `${lOpen ? '▾' : '▸'} ${esc(l.name)} <span class="muted">(${inL.length})</span>`, Object.assign(inL.reduce((t, r) => add(t, r.t), zero()), { budget: cmpL1(l) }), nWeak && !lOpen ? `<span class="chip warn">⚠ ${nWeak} low return</span>` : '');
      if (lOpen) for (const r of inL.sort((a, b) => b.t.actual - a.t.actual)) {
        // A campaign fed by linked ad-platform campaigns opens to show them: the lowest level of third-party detail.
        const srcKey = r.c.sources ? 's' + r.c.id : '', srcOpen = srcKey && state.open.has(srcKey);
        body += line('cp', srcKey, (srcKey ? (srcOpen ? '▾ ' : '▸ ') : '') + esc(r.c.name) + (state.brand ? '' : ` <span class="muted">· ${brandCode(r.c.brand_id)}</span>`) + (r.c.sources ? ` <span class="chip">${r.c.sources} spend source${r.c.sources > 1 ? 's' : ''}</span>` : ''), r.t, weak(r) ? '<span class="chip warn">⚠ Low return</span> <a href="#projections">Reallocate</a>' : '');
        if (srcOpen) {
          const srcs = r.c.sourceList.map((s) => ({ s, spend: s.t.actual })).sort((a, b) => b.spend - a.spend), linked = srcs.reduce((a, x) => a + x.spend, 0);
          for (const x of srcs) body += `<tr class="src"><td>${esc(x.s.name)} <span class="chip">${PLATFORM_NAME[x.s.source] || esc(x.s.source)}</span></td><td>${money(x.spend)}</td><td colspan="12" class="l muted">${x.spend ? `${pct(linked ? x.spend / linked : 0)} of this campaign's platform spend` : 'No spend in this period'} · ${esc(x.s.level1.name)}</td></tr>`;
          if (Math.abs(r.t.actual - linked) > 1) body += `<tr class="src"><td class="muted">Spend recorded on the CRM campaign itself</td><td>${money(r.t.actual - linked)}</td><td colspan="12"></td></tr>`;
        }
      }
    }
  });
  if (un.leads) body += line('l1', '', 'Not mapped to a campaign', un, '<a href="#mappings">Map names</a>');
  body += line('total', '', 'Total', Object.assign(add({ ...tot }, un), { budget: cmpCh() }));

  const through = meta.dataThrough, months = meta.months.filter((m) => m <= through.slice(0, 7));
  const monthOpts = (sel) => months.map((m) => `<option ${m === sel ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('');
  const off = meta.mode === 'real' ? meta.brands.filter((b) => !b.in_ledger && (!state.brand || String(b.id) === state.brand) && rows.some((r) => r.c.brand_id === b.id && r.t.actual)) : [];
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><h1>Maestro <span class="hl">Insights</span></h1><p class="sub" style="margin:0">Return on marketing spend. Outcomes follow the CRM lead-created campaign; spend follows the campaign's connected source.</p></div>
      <div class="row">
        <label>Period by <div class="seg"><button data-mode="months" class="${state.dateMode === 'months' ? 'on' : ''}">Month</button><button data-mode="dates" class="${state.dateMode === 'dates' ? 'on' : ''}">Dates</button></div></label>
        ${state.dateMode === 'months'
          ? `<label>From <select id="from-m">${monthOpts(state.dFrom.slice(0, 7))}</select></label><label>To <select id="to-m">${monthOpts(state.dTo.slice(0, 7))}</select></label>`
          : `<label>From <input type="date" id="from-d" value="${state.dFrom}" min="${meta.months[0]}-01" max="${through}"></label><label>To <input type="date" id="to-d" value="${state.dTo}" min="${meta.months[0]}-01" max="${through}"></label>`}
        ${state.prevRange ? '<button id="full-range">Back to full period</button>' : ''}
      </div>
    </div>
    ${un.leads ? `<div class="banner">${int(un.leads)} leads and ${money(un.bookings)} of bookings in this period sit under CRM campaign names that are not mapped yet. <a href="#mappings">Review mappings</a></div>` : ''}
    ${feedSpend ? `<div class="banner" style="background:var(--wash);border-color:#cfe0f5">${compact(feedLinked)} of ${compact(feedSpend)} ad-platform spend (${pct(feedLinked / feedSpend)}) is linked to a CRM campaign, so those campaigns show their own CPL, CPA and ROAS. The rest meets its outcomes at Level 1 only. <a href="#mappings" id="go-links">Review spend links</a></div>` : ''}
    ${off.length ? `<div class="banner">${off.map((b) => esc(b.name)).join(', ')} ${off.length > 1 ? 'are' : 'is'} not in any loaded ledger. ${off.length > 1 ? 'Their' : 'Its'} spend here is ad-platform feeds only, so anything bought outside those platforms is missing.</div>` : ''}
    <div class="tiles">${tiles.map(([m, val, d]) => `<div class="tile kpi"><div class="kpi-top"><span class="k">${KPIS[m].name}<span class="help" title="${esc(KPIS[m].help)}">?</span></span><button class="zoom" data-zoom="${m}" title="Break ${KPIS[m].name} down by brand, market location, service offering and customer type"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Zoom</button></div><div class="v">${val}</div><div class="d">${d}</div>${py[m]}${spark(m)}</div>`).join('')}</div>
    ${ins.py ? `<p class="sub" style="margin:-6px 0 14px">VS. PY compares with ${niceDay(ins.pyFrom)} to ${niceDay(ins.pyTo)}. Brands that joined part-way through that period have only part of it to compare against, and spend then came from the ledger alone.</p>` : ''}
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><h2>${state.chartMode === 'compare' ? `${MEASURES[state.measure]}: actual vs budget vs projection, by month` : `${MEASURES[state.measure]} by channel, by ${state.grain}`}</h2><p class="sub" style="margin:0">${rangeText}. ${state.grain === 'day' ? 'Days are drawn as a line per channel. Click a day to focus on it; double-click a line' : 'Click a bar to zoom into it; double-click a colour'}, or a channel in the legend, to open its Level 1 breakdown. A single click on a legend entry hides or shows it.</p></div>
      <div class="seg" aria-label="Chart type"><button data-cmode="channel" class="${state.chartMode === 'channel' ? 'on' : ''}">${MEASURES[state.measure]} by channel</button><button data-cmode="compare" class="${state.chartMode === 'compare' ? 'on' : ''}">${MEASURES[state.measure]} comparison</button></div>
      </div>
      <div class="row chart-ctl"><div class="row"><span class="ctl-l">Stage</span><div class="seg pills" aria-label="Measure">${Object.entries(MEASURES).map(([k, n]) => `<button data-measure="${k}" class="${k === state.measure ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="row"><span class="ctl-l">View by</span><div class="seg upper" aria-label="Chart interval">${Object.entries(GRAINS).map(([k, n]) => `<button data-grain="${k}" class="${k === state.grain ? 'on' : ''}">${n}</button>`).join('')}</div></div></div>
      <div class="legend">${meta.channels.map((c, i) => `<button class="lg${state.hiddenCh.has(c.id) ? ' off' : ''}" data-lg="${c.id}" aria-pressed="${!state.hiddenCh.has(c.id)}" title="Click to hide or show ${esc(c.name)}; double-click to break it down by Level 1"><i style="background:${COLORS[i]}"></i>${esc(c.name)}</button>`).join('')}${state.hiddenCh.size ? '<button class="lg" id="lg-all">Show all</button>' : ''}${ins.pySeries && state.grain !== 'day' && state.chartMode !== 'compare' ? '<span class="lg-py"><i></i>Same period last year</span>' : ''}</div>
      <div class="chart" id="chart"></div>${dayNote}
    </div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2>Channel and Level 1 performance</h2>
      <div class="row"><span class="ctl-l">Spend against</span><div class="seg upper"><button data-vs="budget" class="${vsPlan ? '' : 'on'}">Budget</button><button data-vs="plan" class="${vsPlan ? 'on' : ''}">Projection</button></div></div></div>
      <p class="sub">${rangeText}. ${vsPlan ? 'The Projection column is the current plan for these dates: hand-entered projections where they exist, otherwise the budget. Level 1 projections follow their channel.' : 'The Budget column is the budget as loaded, by channel and Level 1.'} Level 1 spend for closed months equals the ledger: platform campaigns sit underneath at their own amounts, with "Other GL spend" and "Platform spend not yet in GL" lines making up the difference. Select a row to expand. A campaign is flagged when its ROAS is under half the blended ${blended.toFixed(1)}x.</p>
      <div class="scroll"><table>${head}${body}</table></div>${feedNote}</div>`;

  const chIndex = new Map(meta.channels.map((c, i) => [c.id, i]));
  const series = pivot(ins.series, state.measure, (id) => ch[id]?.name || 'Other', (id) => COLORS[chIndex.get(id) ?? 8]).sort((a, b) => chIndex.get(a.id) - chIndex.get(b.id)).filter((s) => !state.hiddenCh.has(s.id));
  const g = state.grain, reload = () => insights(el);
  const setRange = (a, b, keepPrev) => { if (!keepPrev) state.prevRange = null; state.dFrom = a; state.dTo = b > through ? through : b; if (state.dFrom > state.dTo) state.dFrom = state.dTo; reload(); };
  // Prior-year totals for the same intervals, drawn as a dashed line. Days are lines per channel, so no total is overlaid there.
  const pyLine = ins.pySeries && g !== 'day' ? (() => {
    const idx = new Map(ins.pySeries.buckets.map((k, i) => [k, i])), vals = ins.pySeries.buckets.map(() => 0);
    for (const r of ins.pySeries.rows) if (r.key != null && !state.hiddenCh.has(r.key)) vals[idx.get(r.bucket)] += r[state.measure] || 0;
    return ins.series.buckets.map((_, i) => (i < vals.length ? vals[i] : null));
  })() : null;
  stackedChart($('#chart'), {
    buckets: ins.series.buckets, series, fmt: state.measure === 'spend' || state.measure === 'bookings' ? compact : int,
    line: g === 'day', compare: pyLine, compareName: 'Same period last year',
    label: bucketLabel[g], title: bucketTitle[g], hint: g === 'day' ? 'Click to focus this day · double-click a colour to break it down' : 'Click to zoom in · double-click a colour to break it down',
    // Zooming remembers where you came from, and steps the interval down so there is something to see.
    onBucket: (k) => { state.prevRange ||= { from: state.dFrom, to: state.dTo, grain: state.grain }; const [a, b] = bucketSpan[g](k); if (g !== 'day') state.grain = 'day'; setRange(a < meta.months[0] + '-01' ? meta.months[0] + '-01' : a, b, true); },
    onSeries: (id) => openDrill([{ group: 'level1', id, name: ch[id]?.name }]),
  });
  // The comparison view replaces the channel chart: the whole of the selected year, month by month.
  if (state.chartMode === 'compare') compareChart($('#chart'));
  $$('[data-cmode]', el).forEach((b) => (b.onclick = () => { state.chartMode = b.dataset.cmode; insights(el); }));
  let lgTimer;
  $$('[data-lg]', el).forEach((b) => {
    b.onclick = () => { clearTimeout(lgTimer); lgTimer = setTimeout(() => { const id = Number(b.dataset.lg); state.hiddenCh.has(id) ? state.hiddenCh.delete(id) : state.hiddenCh.add(id); drawInsights(el); }, 260); };
    b.ondblclick = () => { clearTimeout(lgTimer); const id = Number(b.dataset.lg); openDrill([{ group: 'level1', id, name: ch[id]?.name }]); };
  });
  if ($('#lg-all')) $('#lg-all').onclick = () => { state.hiddenCh.clear(); drawInsights(el); };
  if ($('#full-range')) $('#full-range').onclick = () => { const p = state.prevRange; state.grain = p.grain; setRange(p.from, p.to); };
  if ($('#go-links')) $('#go-links').onclick = () => { state.mapTab = 'links'; };
  $$('[data-mode]', el).forEach((b) => (b.onclick = () => { state.dateMode = b.dataset.mode; if (state.dateMode === 'months') setRange(monthStart(state.dFrom.slice(0, 7)), monthEnd(state.dTo.slice(0, 7))); else drawInsights(el); }));
  if ($('#from-m')) {
    $('#from-m').onchange = (e) => setRange(monthStart(e.target.value), e.target.value > state.dTo.slice(0, 7) ? monthEnd(e.target.value) : state.dTo);
    $('#to-m').onchange = (e) => setRange(e.target.value < state.dFrom.slice(0, 7) ? monthStart(e.target.value) : state.dFrom, monthEnd(e.target.value));
  } else {
    $('#from-d').onchange = (e) => e.target.value && setRange(e.target.value, e.target.value > state.dTo ? e.target.value : state.dTo);
    $('#to-d').onchange = (e) => e.target.value && setRange(e.target.value < state.dFrom ? e.target.value : state.dFrom, e.target.value);
  }
  $$('[data-grain]', el).forEach((b) => (b.onclick = () => { state.grain = b.dataset.grain; reload(); }));
  $$('[data-measure]', el).forEach((b) => (b.onclick = () => { state.measure = b.dataset.measure; drawInsights(el); }));
  $$('[data-vs]', el).forEach((b) => (b.onclick = () => { state.vsMode = b.dataset.vs; drawInsights(el); }));
  $$('[data-zoom]', el).forEach((b) => (b.onclick = () => openZoom(b.dataset.zoom)));
  $$('tr[data-key]', el).forEach((r) => (r.onclick = () => { const k = r.dataset.key; state.open.has(k) ? state.open.delete(k) : state.open.add(k); drawInsights(el); }));
}

// ---- drill-down window -----------------------------------------------------
// Opens over the page: a channel broken down by Level 1, then a Level 1 broken down by campaign.
// `path` is the trail so far, e.g. [{ group: 'level1', id: channelId, name: 'Digital' }, { group: 'campaign', id: level1Id, name: 'Paid Search' }].
async function openDrill(path) {
  let dlg = $('#drill');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'drill'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
  const step = path.at(-1), byCampaign = step.group === 'campaign';
  dlg.innerHTML = '<p class="sub" style="margin:0">Loading…</p>';
  if (!dlg.open) dlg.showModal();
  let data;
  try { data = await api(`/api/series?${rangeQuery()}&grain=${state.grain}&group=${step.group}&id=${step.id}`); } catch (e) { dlg.innerHTML = `<p>${esc(e.message)}</p><button id="d-close">Close</button>`; $('#d-close', dlg).onclick = () => dlg.close(); return; }
  const l1 = Object.fromEntries(meta.level1.map((l) => [l.id, l.name])), nameOf = (id) => (byCampaign ? data.names?.[id] : l1[id]) || 'Unknown';
  const draw = () => {
    // The eight largest get their own colour; the rest fold into "Other" so the chart stays readable.
    const all = pivot(data, state.measure, nameOf, () => '').sort((a, b) => b.total[state.measure] - a.total[state.measure]);
    const top = all.slice(0, 8).map((s, i) => ({ ...s, color: COLORS[i] })), rest = all.slice(8);
    const chart = rest.length ? [...top, { id: 'other', name: `Other (${rest.length})`, color: COLORS[8], values: data.buckets.map((_, i) => rest.reduce((a, s) => a + s.values[i], 0)) }] : top;
    const colour = new Map(top.map((s) => [s.id, s.color])), fmt = state.measure === 'spend' || state.measure === 'bookings' ? compact : int;
    const T = all.reduce((t, s) => { for (const k in t) t[k] += s.total[k]; return t; }, { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 });
    const row = (s, cls = '') => `<tr class="${cls}" ${cls || byCampaign ? '' : `data-drill="${s.id}" title="Double-click to see its campaigns"`}><td><i class="dot" style="background:${colour.get(s.id) || COLORS[8]}"></i>${esc(s.name)}</td><td>${money(s.total.spend)}</td><td>${int(s.total.leads)}</td><td>${int(s.total.appts)}</td><td>${int(s.total.sales)}</td><td>${money(s.total.bookings)}</td><td>${cost(s.total.spend, s.total.leads)}</td><td>${cost(s.total.spend, s.total.appts)}</td><td>${ratio(s.total.bookings, s.total.spend, (x) => x.toFixed(1) + 'x')}</td></tr>`;
    dlg.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><p class="sub" style="margin:0">${path.map((p, i) => (i < path.length - 1 ? `<button class="link" data-crumb="${i}">${esc(p.name)}</button> › ` : `<b>${esc(p.name)}</b>`)).join('')}</p>
          <h2 style="margin-top:4px">${MEASURES[state.measure]} by ${byCampaign ? 'campaign' : 'Level 1'}, by ${state.grain}</h2>
          <p class="sub" style="margin:0">${niceDay(state.dFrom)} to ${niceDay(state.dTo)}. ${byCampaign ? 'This is the lowest level of detail. Linked ad-platform spend sits on its CRM campaign.' : 'Double-click a colour, a legend entry or a table row to see its campaigns.'}</p></div>
        <div class="row"><div class="seg">${Object.entries(MEASURES).map(([k, n]) => `<button data-dmeasure="${k}" class="${k === state.measure ? 'on' : ''}">${n}</button>`).join('')}</div><button id="d-close" aria-label="Close">Close ✕</button></div>
      </div>
      <div class="legend">${chart.map((s) => `<button class="lg" ${s.id === 'other' || byCampaign ? 'disabled' : `data-drill="${s.id}"`}><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join('')}</div>
      <div class="chart" id="d-chart"></div>
      <div class="scroll" style="max-height:38vh;overflow-y:auto;margin-top:12px"><table><tr><th>${byCampaign ? 'Campaign' : 'Level 1'}</th><th>Spend</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th>CPL</th><th>CPA</th><th>ROAS</th></tr>
        ${all.map((s) => row(s)).join('') || '<tr><td class="l muted" colspan="9">Nothing in this period.</td></tr>'}${all.length > 1 ? row({ id: 't', name: 'Total', total: T }, 'total') : ''}</table></div>`;
    stackedChart($('#d-chart', dlg), { buckets: data.buckets, series: chart, fmt, line: state.grain === 'day', label: bucketLabel[state.grain], title: bucketTitle[state.grain], hint: byCampaign ? '' : 'Double-click a colour to see its campaigns',
      onSeries: byCampaign ? null : (id) => id !== 'other' && openDrill([...path, { group: 'campaign', id, name: l1[id] }]) });
    $('#d-close', dlg).onclick = () => dlg.close();
    $$('[data-dmeasure]', dlg).forEach((b) => (b.onclick = () => { state.measure = b.dataset.dmeasure; draw(); if (location.hash.slice(1) === 'insights' || !location.hash) drawInsights($('#view')); }));
    $$('[data-crumb]', dlg).forEach((b) => (b.onclick = () => openDrill(path.slice(0, Number(b.dataset.crumb) + 1))));
    $$('[data-drill]', dlg).forEach((b) => (b.ondblclick = () => openDrill([...path, { group: 'campaign', id: Number(b.dataset.drill), name: l1[b.dataset.drill] }])));
  };
  draw();
}

// ---- KPI zoom --------------------------------------------------------------
// A KPI card's Zoom opens the metric broken down by Brand, then Market location, then Service offering, then
// Customer type. Selecting a row filters to it and moves to the next breakdown; selecting the total lists the records.
const KPIS = {
  spend: { name: 'Spend', help: 'Marketing spend for the period. For closed months this equals the ledger; ad-platform campaigns and reconciling lines sit underneath.', fmt: (v) => money(v), of: (r) => r.spend, records: true, additive: true, crm: false },
  leads: { name: 'Leads', help: 'New leads created in the period. Additional projects on an existing lead are not counted.', fmt: int, of: (r) => r.leads, records: true, additive: true, crm: true },
  appts: { name: 'Appointments', help: 'Qualified leads with an appointment booked in the period, counted on the date the appointment was booked.', fmt: int, of: (r) => r.appts, records: true, additive: true, crm: true },
  sales: { name: 'Sales', help: 'Sold or completed jobs closed in the period. Additional projects on the same sale are not counted.', fmt: int, of: (r) => r.sales, records: true, additive: true, crm: true },
  bookings: { name: 'Bookings $', help: 'Final contract value of every sold or completed project closed in the period, including additional projects.', fmt: (v) => money(v), of: (r) => r.bookings, records: true, additive: true, crm: true },
  roas: { name: 'ROAS', help: 'Bookings $ divided by spend. MCOB is the same relationship the other way round: spend as a share of bookings.', fmt: (v) => (v == null ? '—' : v.toFixed(1) + 'x'), of: (r) => (r.spend > 0.5 ? r.bookings / r.spend : null), records: false, additive: false, crm: false },
};
const ZOOM_DIMS = [['brand', 'Brand'], ['location', 'Market location'], ['service', 'Service offering'], ['ctype', 'Customer type']];
let zoom = null;
function openZoom(measure) {
  zoom = { measure, dim: state.brand ? 'location' : 'brand', f: {}, view: 'breakdown' };
  drawZoom();
}
async function drawZoom() {
  let dlg = $('#drill');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'drill'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
  if (!dlg.open) { dlg.innerHTML = '<p class="sub" style="margin:0">Loading…</p>'; dlg.showModal(); }
  const k = KPIS[zoom.measure], f = zoom.f;
  const fq = Object.entries(f).map(([d, v]) => `&f_${d}=${encodeURIComponent(v.key)}`).join('');
  const dimName = Object.fromEntries(ZOOM_DIMS);
  const labelOf = (dim, key) => (dim === 'brand' ? meta.brands.find((b) => b.id === key)?.name : dim === 'location' ? meta.locations.find((l) => l.id === key)?.name : key) || '(Not recorded)';
  const chips = Object.entries(f).map(([d, v]) => `<button class="chip fchip" data-unf="${d}" title="Remove this filter">${dimName[d]}: ${esc(v.label)} ✕</button>`).join(' ');
  const head = `
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><h2>${k.name} <span class="hl">Zoom</span></h2><p class="sub" style="margin:0">${niceDay(state.dFrom)} to ${niceDay(state.dTo)}. ${esc(k.help)}</p></div>
      <button id="d-close" aria-label="Close">Close ✕</button>
    </div>
    ${chips ? `<p style="margin:8px 0 0">${chips}</p>` : ''}`;
  const close = () => { $('#d-close', dlg).onclick = () => dlg.close(); $$('[data-unf]', dlg).forEach((b) => (b.onclick = () => { delete zoom.f[b.dataset.unf]; zoom.view = 'breakdown'; drawZoom(); })); };

  if (zoom.view === 'records') {
    const url = `/api/records?${rangeQuery()}&measure=${zoom.measure}${fq}`;
    let d; try { d = await api(url); } catch (e) { dlg.innerHTML = head + `<p>${esc(e.message)}</p>`; close(); return; }
    const isMoney = (c) => /Amount|Contract/.test(c);
    dlg.innerHTML = head + `
      <div class="row" style="justify-content:space-between;margin-top:12px"><p class="sub" style="margin:0"><button class="link" id="z-back">‹ Back to the breakdown</button> · ${d.count.toLocaleString()} ${zoom.measure === 'spend' ? 'ledger lines' : 'records'}${d.count > d.shown ? `, showing the first ${d.shown.toLocaleString()}` : ''} · total ${money(d.total)}</p>
        <a class="btn" href="${url}&format=csv&cur=${state.cur}" download>Download all as CSV</a></div>
      ${zoom.measure === 'spend' ? '<p class="sub" style="margin:6px 0 0">These are the ledger lines for the months in the period, which is the official spend. Ad-platform campaign detail is in the chart drill-down. Brands or months with no ledger loaded have no lines here.</p>' : ''}
      <div class="scroll" style="max-height:56vh;overflow-y:auto;margin-top:10px"><table><tr>${d.cols.map((c, i) => `<th class="${isMoney(c) ? '' : 'l'}">${esc(c)}</th>`).join('')}</tr>
        ${d.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${isMoney(d.cols[i]) ? '' : 'l'}">${v == null || v === '' ? '—' : isMoney(d.cols[i]) ? money(v) : esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td class="l muted" colspan="${d.cols.length}">No records for this selection.</td></tr>`}</table></div>`;
    close(); $('#z-back', dlg).onclick = () => { zoom.view = 'breakdown'; drawZoom(); };
    return;
  }

  let d; try { d = await api(`/api/zoom?${rangeQuery()}&dim=${zoom.dim}${fq}`); } catch (e) { dlg.innerHTML = head + `<p>${esc(e.message)}</p>`; close(); return; }
  const crmOnly = !d.hasSpend, blocked = !k.crm && crmOnly;
  const rows = d.rows.map((r) => ({ ...r, label: labelOf(zoom.dim, r.key), v: k.of(r) })).filter((r) => r.spend || r.leads || r.appts || r.sales || r.bookings).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
  const T = rows.reduce((t, r) => { for (const x of ['spend', 'leads', 'appts', 'sales', 'bookings']) t[x] += r[x] || 0; return t; }, { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 });
  if (crmOnly) T.spend = null;
  const totalV = k.of(T), max = Math.max(1, ...rows.map((r) => Math.abs(r.v || 0)));
  const next = ZOOM_DIMS.map(([id]) => id).filter((id) => id !== zoom.dim && !f[id]).find((id) => ZOOM_DIMS.findIndex(([x]) => x === id) > ZOOM_DIMS.findIndex(([x]) => x === zoom.dim));
  // CPA and MCOB need spend, so they are blank on the service offering and customer type breakdowns.
  const cells = (r) => `<td>${r.spend == null ? '—' : money(r.spend)}</td><td>${int(r.leads)}</td><td>${int(r.appts)}</td><td>${int(r.sales)}</td><td>${money(r.bookings)}</td>
    <td>${r.spend == null ? '—' : cost(r.spend, r.appts)}</td><td>${ratio(r.sales, r.appts, pct)}</td><td>${r.spend == null ? '—' : ratio(r.spend, r.bookings, pct)}</td>`;
  const tab = ([id, name]) => { const off = f[id] || ((id === 'service' || id === 'ctype') && (!k.crm || !d.hasRecords)); return `<button data-zdim="${id}" class="${id === zoom.dim ? 'on' : ''}" ${off ? `disabled title="${f[id] ? 'Already filtered' : !d.hasRecords ? 'Needs CRM records, which the demo data does not have' : 'Not recorded for this measure'}"` : ''}>${name}</button>`; };
  dlg.innerHTML = head + `
    <div class="row" style="justify-content:space-between;margin-top:12px"><div class="tabs" style="margin:0;border:0">${ZOOM_DIMS.map(tab).join('')}</div>
      <p class="sub" style="margin:0">${next ? `Select a row to filter to it and continue to ${dimName[next]}.` : 'Select a row to filter to it.'} ${k.records ? 'Select the total to list the underlying records.' : ''}</p></div>
    ${!k.crm ? '<p class="sub" style="margin:6px 0 0">Service offering and customer type are recorded on CRM records only, so they are not available for spend-based measures.</p>' : ''}
    ${blocked ? '<p style="margin-top:12px">This measure needs spend, which is not recorded by service offering or customer type. Remove that filter to see it.</p>' : `
    <div class="scroll" style="max-height:56vh;overflow-y:auto;margin-top:10px"><table>
      <tr><th>${dimName[zoom.dim]}</th><th>${k.name}</th><th class="l" style="width:16%">${k.additive ? 'Share' : ''}</th><th>Spend</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th title="Spend per appointment">CPA</th><th title="Sales as a share of appointments">Closing rate</th><th title="Marketing cost of bookings: spend as a share of bookings">MCOB</th></tr>
      ${rows.map((r, i) => `<tr class="zrow" data-zrow="${i}" title="Filter to ${esc(r.label)}"><td>${esc(r.label)}</td><td><b>${r.v == null ? '—' : k.fmt(r.v)}</b></td>
        <td class="l">${k.additive ? `<span class="bar"><i style="width:${Math.max(1, (Math.abs(r.v) / max) * 100)}%"></i></span> <span class="muted">${totalV ? pct(r.v / totalV) : ''}</span>` : ''}</td>${cells(r)}</tr>`).join('') || '<tr><td class="l muted" colspan="11">Nothing in this period for this selection.</td></tr>'}
      <tr class="total ${k.records ? 'zrow' : ''}" ${k.records ? 'id="z-total" title="List the underlying records"' : ''}><td>Total${k.records ? ' <span class="muted" style="font-weight:400">· view records ›</span>' : ''}</td><td>${totalV == null ? '—' : k.fmt(totalV)}</td><td></td>${cells(T)}</tr></table></div>`}`;
  close();
  $$('[data-zdim]', dlg).forEach((b) => (b.onclick = () => { zoom.dim = b.dataset.zdim; drawZoom(); }));
  $$('[data-zrow]', dlg).forEach((tr) => (tr.onclick = () => { const r = rows[Number(tr.dataset.zrow)]; zoom.f[zoom.dim] = { key: r.key ?? '', label: r.label }; if (next) zoom.dim = next; else zoom.view = k.records ? 'records' : 'breakdown'; drawZoom(); }));
  if ($('#z-total', dlg)) $('#z-total', dlg).onclick = () => { zoom.view = 'records'; drawZoom(); };
}

// ---- Projections -----------------------------------------------------------
// Spend, appointments and bookings, projected by channel (starting from budget) and shared down to the brand's CRM campaigns.
const PROJ = { spend: { name: 'Spend', money: true }, appts: { name: 'Appointments', money: false }, bookings: { name: 'Bookings $', money: true } };
const BASIS = { t3: 'Last 3 closed months', t12: 'Last 12 closed months', ly: 'Same month last year' };
async function projections(el) {
  const k = state.pMeasure, P = PROJ[k], fmt = P.money ? money : int, big = P.money ? compact : int;
  const [d, f, log] = await Promise.all([api(`/api/projections?${scope()}&year=${state.year}&basis=${state.pBasis}`), state.location ? null : api('/api/facts?' + scope()), api('/api/projections/log?' + scope())]);
  // Figures are entered for one market location; wider views add the locations up and are read-only.
  const months = d.months, openMonths = months.filter((m) => !closed(m)), closedMonths = months.filter(closed), canEdit = !!d.brand && !!d.location;
  const locName = d.location ? meta.locations.find((l) => l.id === d.location)?.name : '';
  const sumOf = (arr, pick) => arr.reduce((a, v, i) => a + (pick(months[i]) ? v : 0), 0), all = () => true, isOpen = (m) => !closed(m);
  const T = d.channels.reduce((t, c) => { const x = c.m[k]; t.budget += sumOf(x.budget, all); t.ytd += sumOf(x.actual, closed); t.ytdBudget += sumOf(x.budget, closed); t.open += sumOf(x.proj, isOpen); t.openBudget += sumOf(x.budget, isOpen); return t; }, { budget: 0, ytd: 0, ytdBudget: 0, open: 0, openBudget: 0 });
  const outlook = T.ytd + T.open, diff = outlook - T.budget, has = d.hasBudget[k], moreIsGood = k !== 'spend';
  const th = months.map((m) => `<th>${mlabel(m)}${closed(m) ? '' : '*'}</th>`).join('');
  const val = (v) => (Math.abs(v) >= 0.5 ? int(v) : '—');
  const input = (v, attrs, set, tip) => `<td class="cell"><input type="number" min="0" step="${P.money ? 100 : 1}" class="${set ? 'set' : ''}" value="${P.money ? Math.round(v) : Math.round(v * 10) / 10}" data-was="${P.money ? Math.round(v) : Math.round(v * 10) / 10}" ${attrs} title="${tip}"></td>`;
  let body = '';
  d.channels.forEach((c) => {
    const x = c.m[k], ci = meta.channels.findIndex((m) => m.id === c.id), open = state.pOpen.has(c.id), camps = d.campaigns.filter((cp) => cp.ch === c.id);
    const b = sumOf(x.budget, all), o = sumOf(x.proj, all);
    body += `<tr class="ch" ${d.brand ? `data-pch="${c.id}"` : ''}><td class="l">${d.brand ? (open ? '▾ ' : '▸ ') : ''}<i class="dot" style="background:${COLORS[ci]}"></i>${esc(c.name)}${d.brand ? ` <span class="muted" style="font-weight:400">(${camps.length})</span>` : ''}</td>` + months.map((m, i) => {
      const tip = `Budget ${fmt(x.budget[i])}${x.fromRunRate[i] ? ' · no budget for this month, so it starts from the average of the last 3 closed months' : ''}${x.set[i] ? ' · adjusted from the default (clear the cell to reset)' : ''}`;
      return closed(m) || !canEdit ? `<td class="${closed(m) ? 'closed' : ''}" title="${tip}">${val(x.proj[i])}</td>` : input(x.proj[i], `data-ch="${c.id}" data-m="${m}" aria-label="${esc(c.name)} ${P.name} ${mlabel(m)}"`, x.set[i], tip);
    }).join('') + `<td>${b ? fmt(b) : '—'}</td><td>${fmt(o)}</td><td class="${b && (o > b) !== moreIsGood ? 'down' : b ? 'up' : ''}">${b ? (o - b >= 0 ? '+' : '−') + fmt(Math.abs(o - b)) : '—'}</td></tr>`;
    if (!open || !d.brand) return;
    // the brand's CRM campaigns in this channel, largest first
    for (const cp of camps.sort((a1, b1) => sumOf(b1.m[k].proj, all) - sumOf(a1.m[k].proj, all))) {
      const y = cp.m[k];
      body += `<tr class="cp"><td class="l">${esc(cp.name)} <span class="muted">· ${esc(cp.level1)}</span></td>` + months.map((m, i) => (closed(m) || !canEdit ? `<td class="${closed(m) ? 'closed' : ''}">${val(y.proj[i])}</td>`
        : input(y.proj[i], `data-camp="${cp.id}" data-m="${m}" aria-label="${esc(cp.name)} ${P.name} ${mlabel(m)}"`, y.manual[i], y.manual[i] ? 'Entered by hand. Clear the cell to go back to its automatic share.' : 'Automatic share of the channel figure. Type a number to set it by hand.'))).join('') +
        `<td></td><td>${fmt(sumOf(y.proj, all))}</td><td></td></tr>`;
    }
    const u = d.unassigned[c.id]?.[k] || months.map(() => 0);
    if (u.some((v) => Math.abs(v) >= 0.5)) body += `<tr class="cp un"><td class="l muted">Not on a CRM campaign</td>` + months.map((m, i) => `<td class="${closed(m) ? 'closed' : ''} ${!closed(m) && u[i] < -0.5 ? 'down' : 'muted'}" title="${closed(m) ? 'Actuals in this channel that are not recorded against a CRM campaign' : u[i] < -0.5 ? 'Campaign overrides add up to more than the channel figure' : 'Channel projection not yet given to a campaign'}">${val(u[i])}</td>`).join('') + `<td></td><td class="muted">${fmt(sumOf(u, all))}</td><td></td></tr>`;
  });
  const totals = months.map((_, i) => d.channels.reduce((a, c) => a + c.m[k].proj[i], 0));
  body += `<tr class="total"><td class="l">Total</td>${totals.map((v, i) => `<td class="${closed(months[i]) ? 'closed' : ''}">${val(v)}</td>`).join('')}<td>${T.budget ? fmt(T.budget) : '—'}</td><td>${fmt(outlook)}</td><td>${T.budget ? (diff >= 0 ? '+' : '−') + fmt(Math.abs(diff)) : '—'}</td></tr>`;

  // GL reconciliation, as before: ledger spend against spend tied to campaigns, by Level 1
  let gl = '';
  if (f && closedMonths.length) {
    state.glMonth = closedMonths.includes(state.glMonth) ? state.glMonth : closedMonths.at(-1);
    const l1Of = new Map(f.campaigns.map((c) => [c.id, c])), src = {};
    for (const s of f.spend) { const c = l1Of.get(s.campaign_id); if (c && s.month === state.glMonth && !c.source.startsWith('gl_')) src[c.level1_id] = (src[c.level1_id] || 0) + s.actual; }
    const rows = meta.level1.map((l) => ({ l, gl: f.gl.filter((g) => g.level1_id === l.id && g.month === state.glMonth).reduce((a, g) => a + g.amount, 0), src: src[l.id] || 0 })).filter((r) => r.gl || r.src);
    const t = rows.reduce((a, r) => ({ gl: a.gl + r.gl, src: a.src + r.src }), { gl: 0, src: 0 });
    const note = (x, g) => (Math.abs(x) < Math.max(50, g * 0.02) ? 'Tied out' : x > 0 ? 'In GL, not tied to a campaign: allocate' : 'Sourced, not in GL yet: accrual candidate');
    gl = `<div class="card"><div class="row" style="justify-content:space-between"><div><h2>GL reconciliation and accrual signal</h2><p class="sub">General ledger marketing spend against spend from the connected ad platforms, by Level 1.</p></div>
      <label>Month <select id="gl-month">${closedMonths.map((m) => `<option ${m === state.glMonth ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label></div>
      <div class="scroll"><table><tr><th>Level 1</th><th>GL account</th><th>GL actual</th><th>From ad platforms</th><th>Difference</th><th class="l">Reading</th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.l.name)}</td><td>${esc(r.l.gl_account || '—')}</td><td>${money(r.gl)}</td><td>${money(r.src)}</td><td>${money(r.gl - r.src)}</td><td class="l muted">${note(r.gl - r.src, r.gl)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td></td><td>${money(t.gl)}</td><td>${money(t.src)}</td><td>${money(t.gl - t.src)}</td><td class="l">${ratio(t.src, t.gl, pct)} of GL explained by a platform</td></tr></table></div></div>`;
  }

  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <div><h1>Maestro <span class="hl">Projections</span> · ${state.year}</h1><p class="sub" style="margin:0">Each open month starts at budget and is adjusted from there, by channel. The channel figure is then shared across the brand's CRM campaigns automatically, or you can set a campaign by hand.</p></div>
      <div class="row"><span class="ctl-l">Projecting</span><div class="seg pills">${Object.entries(PROJ).map(([id, p]) => `<button data-pm="${id}" class="${id === k ? 'on' : ''}">${p.name}</button>`).join('')}</div></div>
    </div>
    ${!has ? `<div class="banner">No ${P.name.toLowerCase()} budget is loaded for ${state.year}, so open months start from the average of the last three closed months instead. Load a budget on the Import screen and they will start from budget.</div>` : ''}
    ${!d.brand ? '<div class="banner" style="background:var(--wash);border-color:#cfe0f5">Showing channel totals for every brand in view. Pick a brand and one of its market locations above to enter projections.</div>' : !d.location ? '<div class="banner" style="background:var(--wash);border-color:#cfe0f5">This is the total of the brand\'s market locations. Projections are entered by market location: pick one above to adjust it.</div>' : ''}
    <div class="tiles">
      <div class="tile"><div class="k">Annual budget</div><div class="v">${has ? big(T.budget) : '—'}</div><div class="d">${has ? 'Set once, does not move' : 'Not loaded for ' + state.year}</div></div>
      <div class="tile"><div class="k">Actual to date</div><div class="v">${big(T.ytd)}</div><div class="d">${has ? 'Budget to date ' + big(T.ytdBudget) : closedMonths.length + ' closed months'}</div></div>
      <div class="tile"><div class="k">Projected, open months</div><div class="v">${big(T.open)}</div><div class="d">${has ? 'Budget for those months ' + big(T.openBudget) : openMonths.length + ' open months'}</div></div>
      <div class="tile"><div class="k">Full-year outlook</div><div class="v">${big(outlook)}</div><div class="d">${has ? `<span class="${(diff > 0) === moreIsGood ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${big(Math.abs(diff))}</span> ${diff > 0 ? 'over' : 'under'} budget` : 'Actuals plus projection'}</div></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><h2>${P.name} by channel${d.brand ? ' and CRM campaign' : ''}${locName ? ` · ${esc(locName)}` : ''}</h2>
        <p class="sub" style="margin:0">Grey cells are actuals. ${canEdit ? 'White cells are projections: type a figure and press Enter. A bold cell has been changed by hand; clear it to go back to the default. Select a channel to open its campaigns.' : 'Months marked * are open.'}</p></div>
        ${canEdit && openMonths.length ? '<button class="primary" id="p-move">Move between campaigns</button>' : ''}
        ${d.brand ? `<label>Share a channel across its campaigns by <select id="p-basis">${Object.entries(BASIS).map(([id, n]) => `<option value="${id}" ${id === state.pBasis ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}</div>
      ${d.brand ? `<p class="sub" style="margin:6px 0 0">Campaigns without a hand-entered figure share what is left of their channel in proportion to their ${k === 'bookings' ? 'bookings' : 'appointments'} at that market location over the chosen period${k === 'spend' ? ' (spend follows appointments, on the assumption that campaigns bringing in appointments are the ones being paid for)' : ''}. A campaign with no activity in that period gets nothing until you enter a figure for it.</p>` : ''}
      <div class="scroll" style="margin-top:10px"><table><tr><th>Channel${d.brand ? ' / CRM campaign' : ''}</th>${th}<th>FY budget</th><th>FY outlook</th><th>Var</th></tr>${body}</table></div>
    </div>
    <div class="card"><h2>Change log</h2><p class="sub">Every change to a projection for the brands and market location in view, newest first: who, when, what it was and what it became. The budget is never changed here.</p>
      <div class="scroll" style="max-height:340px;overflow-y:auto"><table><tr><th>When</th><th class="l">Who</th><th class="l">Change</th><th class="l">Detail</th></tr>
      ${log.map((a) => `<tr><td class="l">${new Date(a.at).toLocaleString()}</td><td class="l">${esc(a.user)}</td><td class="l">${esc({ 'projection: channel': 'Channel adjusted', 'projection: channel reset': 'Channel reset', 'projection: campaign': 'Campaign set by hand', 'projection: campaign reset': 'Campaign reset', 'projection: move': 'Moved between campaigns' }[a.action] || a.action)}</td><td class="l wrap">${esc(a.detail)}</td></tr>`).join('') || '<tr><td class="l muted" colspan="4">No changes yet.</td></tr>'}</table></div></div>
    ${gl}`;

  if ($('#p-move')) $('#p-move').onclick = () => openMove(d);
  $$('[data-pm]', el).forEach((b) => (b.onclick = () => { state.pMeasure = b.dataset.pm; render(); }));
  if ($('#p-basis')) $('#p-basis').onchange = (e) => { state.pBasis = e.target.value; render(); };
  $$('tr[data-pch]', el).forEach((r) => (r.onclick = (e) => { if (e.target.tagName === 'INPUT') return; const id = Number(r.dataset.pch); state.pOpen.has(id) ? state.pOpen.delete(id) : state.pOpen.add(id); render(); }));
  $$('td.cell input', el).forEach((i) => {
    i.oninput = () => i.classList.toggle('dirty', i.value !== i.dataset.was);
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); };
    i.onchange = () => {
      if (i.value === i.dataset.was) return;
      const amount = i.value === '' ? null : Number(i.value);
      if (i.dataset.ch) act(() => api('/api/projections/channel', { location_id: d.location, channel_id: Number(i.dataset.ch), month: i.dataset.m, measure: k, amount }), amount == null ? 'Back to the default' : 'Channel projection saved');
      else act(() => api('/api/projections/campaign', { basis: state.pBasis, location_id: d.location, campaign_id: Number(i.dataset.camp), month: i.dataset.m, measure: k, amount }), amount == null ? 'Back to its automatic share' : 'Campaign set by hand');
    };
  });
  if ($('#gl-month')) $('#gl-month').onchange = (e) => { state.glMonth = e.target.value; render(); };
}

// ---- move a projection between campaigns --------------------------------------
// Opens over the Projections screen for the market location in view. The budget is never touched.
async function openMove(d) {
  const k = state.pMeasure, P = PROJ[k], fmt = P.money ? money : (v) => (Math.round(v * 10) / 10).toLocaleString('en-US');
  const openMonths = d.months.filter((m) => !closed(m)), loc = meta.locations.find((l) => l.id === d.location);
  const everyone = (await api('/api/campaigns?brand=' + d.brand)).filter((c) => ['crm', 'manual'].includes(c.source) && ['live', 'approved'].includes(c.status)).sort((a, b) => a.name.localeCompare(b.name));
  let dlg = $('#drill');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'drill'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
  const s = { month: openMonths[0], from: '', to: '', amount: '', reason: '' };
  const cur = (id, m) => d.campaigns.find((c) => String(c.id) === String(id))?.m[k].proj[d.months.indexOf(m)] || 0;
  const draw = () => {
    const sources = d.campaigns.filter((c) => cur(c.id, s.month) >= 0.5).sort((a, b) => cur(b.id, s.month) - cur(a.id, s.month));
    if (!sources.some((c) => String(c.id) === String(s.from))) s.from = sources[0] ? String(sources[0].id) : '';
    const avail = cur(s.from, s.month), amt = Number(s.amount) || 0, a = avail, b = s.to ? cur(s.to, s.month) : 0;
    const fromName = sources.find((c) => String(c.id) === s.from)?.name || '—', toC = everyone.find((c) => String(c.id) === s.to);
    const issues = [!s.from && 'There is nothing projected to move in that month.', !s.to && 'Choose a destination campaign.', s.to && s.to === s.from && 'Source and destination must be different campaigns.',
      !(amt > 0) && 'Enter an amount to move.', amt > avail + 0.5 && `Only ${fmt(avail)} is available on the source campaign.`, s.reason.trim().length < 15 && 'Give a reason of at least 15 characters; it goes in the change log.'].filter(Boolean);
    const channelOf = (c) => meta.level1.find((l) => l.id === c?.level1_id)?.channel_id, fromC = everyone.find((c) => String(c.id) === s.from);
    const crossChannel = !!toC && !!fromC && channelOf(toC) !== channelOf(fromC);
    dlg.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2>Move projected ${P.name.toLowerCase().replace(' $', '')} <span class="hl">between campaigns</span></h2>
        <p class="sub" style="margin:0">${esc(loc?.name || '')} · ${meta.brands.find((x) => x.id === d.brand)?.name || ''}</p></div><button id="mv-x" aria-label="Close">Close ✕</button></div>
      <div class="move">
        <div>
          <label>Source campaign<select id="mv-from">${sources.map((c) => `<option value="${c.id}" ${String(c.id) === s.from ? 'selected' : ''}>${esc(c.name)} · ${fmt(cur(c.id, s.month))} avail.</option>`).join('') || '<option value="">Nothing projected this month</option>'}</select></label>
          <p class="sub" style="margin:4px 0 10px">Available to move in ${mlabel(s.month)} ${s.month.slice(0, 4)}: ${fmt(avail)}, the campaign's current projection.</p>
          <label>Destination campaign<select id="mv-to"><option value="">Select…</option>${everyone.filter((c) => String(c.id) !== s.from).map((c) => `<option value="${c.id}" ${String(c.id) === s.to ? 'selected' : ''}>${esc(c.name)} · ${esc(c.level1)}</option>`).join('')}</select></label>
          <div class="row" style="margin-top:10px"><label style="flex:1">Amount<input id="mv-amt" type="number" min="0" step="${P.money ? 100 : 1}" value="${esc(s.amount)}"></label>
            <label style="flex:1">Effective<select id="mv-month">${openMonths.map((m) => `<option value="${m}" ${m === s.month ? 'selected' : ''}>${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label></div>
          <p style="margin:6px 0 10px">${[[0.25, '25%'], [0.5, '50%'], [1, 'Max']].map(([f, n]) => `<button class="link" data-part="${f}" style="margin-right:14px">${n}</button>`).join('')}</p>
          <label>Reason for the move<textarea id="mv-why" rows="3" placeholder="e.g. Affiliates running at twice the target cost per appointment for three months; LSA has headroom below target.">${esc(s.reason)}</textarea></label>
          <div class="issues">${issues.map((x) => `<div>✕ ${esc(x)}</div>`).join('')}</div>
        </div>
        <div>
          <p class="ctl-l" style="margin:0 0 6px">Before and after · ${mlabel(s.month)} ${s.month.slice(0, 4)} projection</p>
          <table><tr><th>Campaign</th><th>Current</th><th>Proposed</th><th>Change</th></tr>
            <tr><td>${esc(fromName)}</td><td>${fmt(a)}</td><td>${fmt(Math.max(0, a - amt))}</td><td class="down">−${fmt(amt)}</td></tr>
            <tr><td>${toC ? esc(toC.name) : 'Destination'}</td><td>${fmt(b)}</td><td>${fmt(b + amt)}</td><td class="up">+${fmt(amt)}</td></tr></table>
          ${crossChannel ? '<p class="sub" style="margin:10px 0 0">These campaigns are in different channels, so the two channel projections move by the same amount.</p>' : ''}
          <p class="sub" style="margin:10px 0 0">Both campaigns become hand-entered figures for this month, and every other campaign keeps the figure it has now.</p>
        </div>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:14px;border-top:1px solid var(--grid);padding-top:12px"><p class="sub" style="margin:0">A move changes the projection only. The budget stays as loaded, and actuals keep coming from the ledger and the ad platforms.</p>
        <div class="row"><button id="mv-cancel">Cancel</button><button class="primary" id="mv-go" ${issues.length ? 'disabled' : ''}>Apply move</button></div></div>`;
    const keep = (id, key) => { const el = $(id, dlg); el.oninput = () => { s[key] = el.value; const pos = el.selectionStart; draw(); const again = $(id, dlg); again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* number inputs have no caret position */ } }; };
    keep('#mv-amt', 'amount'); keep('#mv-why', 'reason');
    $('#mv-from', dlg).onchange = (e) => { s.from = e.target.value; draw(); };
    $('#mv-to', dlg).onchange = (e) => { s.to = e.target.value; draw(); };
    $('#mv-month', dlg).onchange = (e) => { s.month = e.target.value; draw(); };
    $$('[data-part]', dlg).forEach((btn) => (btn.onclick = () => { s.amount = String(P.money ? Math.floor(avail * Number(btn.dataset.part)) : Math.floor(avail * Number(btn.dataset.part) * 10) / 10); draw(); }));
    $('#mv-x', dlg).onclick = $('#mv-cancel', dlg).onclick = () => dlg.close();
    $('#mv-go', dlg).onclick = async () => {
      try { await api('/api/projections/move', { location_id: d.location, from: Number(s.from), to: Number(s.to), month: s.month, measure: k, amount: amt, reason: s.reason, basis: state.pBasis }); dlg.close(); toast('Projection moved'); render(); }
      catch (e) { toast(e.message, true); }
    };
  };
  draw();
  if (!dlg.open) dlg.showModal();
}

// ---- actual vs budget vs projection chart ----------------------------------------
// The same stage as the channel chart, as three bars a month: what happened, the fixed budget, and the current projection.
function compareChart(host) {
  host._ro?.disconnect();
  const k = state.measure, P = ins.plan;
  if (!P || !PROJ[k]) { host.innerHTML = '<p class="sub" style="padding:28px 0;margin:0">Budget and projections exist for Spend, Appointments and Bookings $. Pick one of those stages to compare.</p>'; return; }
  const fmt = PROJ[k].money ? compact : int, months = P.months, chans = P.channels.filter((c) => !state.hiddenCh.has(c.id)), lastData = meta.dataThrough.slice(0, 7);
  const tot = (f) => months.map((_, i) => chans.reduce((a, c) => a + c.m[k][f][i], 0));
  const groups = [{ name: 'Actual', color: '#1e3a5f', values: tot('actual').map((v, i) => (months[i] <= lastData ? v : null)) }, { name: 'Budget', color: '#a8b4c4', values: tot('budget') }, { name: 'Projection', color: 'var(--accent)', values: tot('plan') }];
  const draw = () => {
    const W = Math.max(300, Math.round(host.clientWidth || 960)), H = Math.round(Math.min(440, Math.max(230, W * 0.34))), L = W < 520 ? 46 : 62, R = 14, T = 16, B = 32, pw = W - L - R, ph = H - T - B;
    const max = Math.max(1e-9, ...groups.flatMap((g) => g.values.map((v) => v || 0)));
    const step = (() => { const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= raw); })();
    const top = Math.ceil((max * 1.04) / step) * step, y = (v) => T + ph - (v / top) * ph, bw = pw / months.length, w = Math.max(2, Math.min(34, (bw * 0.8) / 3 - 2));
    let svg = `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="none" stroke="var(--grid)"/>`;
    for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? 'var(--grid)' : 'var(--axis)'}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
    months.forEach((m, i) => {
      const x0 = L + bw * i + (bw - (w + 2) * 3 + 2) / 2;
      if (i) svg += `<line x1="${L + bw * i}" x2="${L + bw * i}" y1="${T}" y2="${T + ph}" stroke="var(--grid)"/>`;
      groups.forEach((g, gi) => { const v = g.values[i]; if (v == null || v <= 0) return; const h = y(0) - y(v), r = Math.min(3, h, w / 2), x = x0 + gi * (w + 2), yt = y(v); svg += `<path d="M${x},${yt + h}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yt + h}Z" fill="${g.color}"/>`; });
      svg += `<text class="ax" x="${L + bw * i + bw / 2}" y="${H - 10}" text-anchor="middle">${bucketLabel.month(m, bw)}${closed(m) ? '' : '*'}</text><rect data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}" fill="transparent"/>`;
    });
    host.innerHTML = `<div class="legend" style="margin-top:0">${groups.map((g) => `<span class="lg-py"><i style="display:inline-block;width:10px;height:10px;border:0;border-radius:2px;background:${g.color};vertical-align:-1px;margin-right:5px"></i>${g.name}</span>`).join('')}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Actual, budget and projection by month">${svg}</svg><div class="tip"></div>`;
    const tip = $('.tip', host), vs = (a, b) => (a == null || !b ? '—' : `${a - b >= 0 ? '+' : '−'}${fmt(Math.abs(a - b))} (${a - b >= 0 ? '+' : '−'}${(Math.abs(a / b - 1) * 100).toFixed(1)}%)`);
    host.onclick = host.ondblclick = null;
    host.onmousemove = (e) => {
      const i = e.target.dataset?.i; if (i == null) return (tip.style.display = 'none');
      const [a, b, p] = groups.map((g) => g.values[i]);
      tip.innerHTML = `<b>${bucketTitle.month(months[i])}${closed(months[i]) ? '' : months[i] <= lastData ? ' · month to date' : ' · not started'}</b>` + groups.map((g) => `<div><span><i class="dot" style="background:${g.color}"></i>${g.name}</span><span>${g.values[i] == null ? '—' : fmt(g.values[i])}</span></div>`).join('') +
        `<div style="margin-top:4px"><span>Actual vs budget</span><span>${vs(a, b)}</span></div><div><span>Actual vs projection</span><span>${vs(a, p)}</span></div>`;
      const box = host.getBoundingClientRect(); tip.style.display = 'block';
      tip.style.left = Math.max(0, Math.min(e.clientX - box.left + 14, box.width - tip.offsetWidth - 4)) + 'px'; tip.style.top = Math.max(0, e.clientY - box.top - 20) + 'px';
    };
    host.onmouseleave = () => (tip.style.display = 'none');
    host._w = W;
  };
  draw();
  host._ro = new ResizeObserver(() => { if (host.isConnected && host.clientWidth > 0 && Math.abs(host.clientWidth - host._w) > 6) draw(); });
  host._ro.observe(host);
}

// ---- ledger lines: assign or split one at a time ------------------------------
let ledgerGroups = [], ledgerCampaigns = [];
async function openLedgerLines(g) {
  let dlg = $('#drill');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'drill'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
  const l1 = meta.level1.find((l) => l.id === g.level1_id)?.name || '';
  const campOptions = (sel) => `<option value="">Choose a campaign…</option>${meta.level1.filter((l) => ledgerCampaigns.some((c) => c.level1_id === l.id)).map((l) => `<optgroup label="${esc(l.name)}">${opts(ledgerCampaigns.filter((c) => c.level1_id === l.id), sel)}</optgroup>`).join('')}`;
  let editing = null, draft = []; // the line being assigned, and its parts
  const load = () => api(`/api/ledger/lines?${scope()}&year=${state.year}&level1=${g.level1_id}&vendor=${encodeURIComponent(g.vendor_key)}`);
  let lines = await load();
  const draw = () => {
    const left = (ln) => ln.amount - draft.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    dlg.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:flex-start"><div><h2>${esc(g.vendor || 'Lines with no vendor')} <span class="hl">· ${esc(l1)}</span></h2>
        <p class="sub" style="margin:0">${lines.length} ledger lines in ${state.year}. Assign a line to one CRM campaign, or split it across several. Anything you leave unassigned stays in "Other GL spend".</p></div><button id="ll-x">Close ✕</button></div>
      <div class="scroll" style="max-height:66vh;overflow-y:auto;margin-top:10px"><table>
        <tr><th>Date</th><th class="l">Description</th><th class="l">Reference</th><th class="l">Market location</th><th>Amount</th><th class="l">Assigned to</th><th class="l"></th></tr>
        ${lines.map((ln, i) => `<tr><td class="l">${esc(ln.day || ln.month)}</td><td class="l wrap">${esc(ln.description || '—')}</td><td class="l">${esc(ln.ref || '—')}</td><td class="l">${esc(ln.location)}</td><td>${money(ln.amount)}</td>
            <td class="l wrap">${ln.covered ? '<span class="muted">Covered by ad platform</span>' : ln.parts.length ? ln.parts.map((p) => `${esc(p.name)} ${money(p.amount)}${p.rule ? ' <span class="muted">(rule)</span>' : ''}`).join('<br>') : '<span class="chip rejected">Needs a campaign</span>'}</td>
            <td class="l">${ln.covered ? '' : `<button data-ll-edit="${i}">${ln.parts.length ? 'Change' : 'Assign / split'}</button>`}</td></tr>
          ${editing === i ? `<tr class="src"><td colspan="7" style="padding:10px 12px"><div class="split">
            ${draft.map((p, j) => `<div class="row"><select data-ll-camp="${j}" style="flex:2;max-width:420px">${campOptions(p.campaign_id)}</select><input type="number" step="0.01" data-ll-amt="${j}" value="${esc(p.amount)}" style="width:130px" aria-label="Amount">${draft.length > 1 ? `<button class="link" data-ll-del="${j}">Remove</button>` : ''}</div>`).join('')}
            <div class="row" style="justify-content:space-between"><div class="row"><button class="link" id="ll-add">+ Split to another campaign</button>
              <span class="muted">${Math.abs(left(ln)) < 0.005 ? 'The whole line is assigned.' : left(ln) * Math.sign(ln.amount || 1) > 0 ? `${money(left(ln))} of this line stays unassigned.` : `<span class="down">Over by ${money(-left(ln))}.</span>`}</span></div>
              <div class="row">${ln.parts.length ? '<button id="ll-clear">Clear assignment</button>' : ''}<button id="ll-cancel">Cancel</button><button class="primary" id="ll-save" ${draft.some((p) => p.campaign_id && Number(p.amount)) && left(ln) * Math.sign(ln.amount || 1) > -0.005 ? '' : 'disabled'}>Save</button></div></div>
          </div></td></tr>` : ''}`).join('') || '<tr><td class="l muted" colspan="7">No lines.</td></tr>'}</table></div>`;
    $('#ll-x', dlg).onclick = () => dlg.close();
    $$('[data-ll-edit]', dlg).forEach((b) => (b.onclick = () => { editing = Number(b.dataset.llEdit); const ln = lines[editing]; draft = ln.parts.filter((p) => !p.rule || true).map((p) => ({ campaign_id: p.campaign_id, amount: String(Math.round(p.amount * 100) / 100) })); if (!draft.length) draft = [{ campaign_id: '', amount: String(Math.round(ln.amount * 100) / 100) }]; draw(); }));
    if (editing == null) return;
    const ln = lines[editing];
    $$('[data-ll-camp]', dlg).forEach((s) => (s.onchange = () => { draft[Number(s.dataset.llCamp)].campaign_id = s.value; draw(); }));
    $$('[data-ll-amt]', dlg).forEach((inp) => (inp.onchange = () => { draft[Number(inp.dataset.llAmt)].amount = inp.value; draw(); }));
    $$('[data-ll-del]', dlg).forEach((b) => (b.onclick = () => { draft.splice(Number(b.dataset.llDel), 1); draw(); }));
    $('#ll-add', dlg).onclick = () => { draft.push({ campaign_id: '', amount: String(Math.round(Math.max(0, left(ln) * Math.sign(ln.amount || 1)) * Math.sign(ln.amount || 1) * 100) / 100) }); draw(); };
    $('#ll-cancel', dlg).onclick = () => { editing = null; draw(); };
    const send = async (parts, msg) => { try { await api('/api/ledger/assign', { ext: ln.ext, parts }); toast(msg); editing = null; lines = await load(); draw(); render(); } catch (e) { toast(e.message, true); } };
    $('#ll-save', dlg).onclick = () => send(draft.filter((p) => p.campaign_id && Number(p.amount)).map((p) => ({ campaign_id: Number(p.campaign_id), amount: Number(p.amount) })), draft.length > 1 ? 'Line split' : 'Line assigned');
    if ($('#ll-clear', dlg)) $('#ll-clear', dlg).onclick = () => send([], 'Assignment cleared');
  };
  draw();
  if (!dlg.open) dlg.showModal();
}

// ---- Campaigns -------------------------------------------------------------
async function campaigns(el) {
  const list = await api('/api/campaigns?' + scope());
  const brandId = Number(state.brand || meta.brands[0].id), brand = meta.brands.find((b) => b.id === brandId);
  const locs = meta.locations.filter((l) => l.brand_id === brandId), openMonths = meta.months.filter((m) => m.slice(0, 4) >= meta.closedThrough.slice(0, 4));
  const waiting = list.filter((c) => c.status === 'pending').length;
  const actions = (c) => c.status === 'pending' ? (state.role === 'approver' ? `<button data-decide="approved" data-id="${c.id}" class="primary">Approve</button> <button data-decide="rejected" data-id="${c.id}">Reject</button>` : '<span class="muted">Waiting for approver</span>')
    : c.status === 'approved' ? `<button data-push="${c.id}" class="primary">Push to CRM</button>` : '';
  el.innerHTML = `
    <h1>Maestro <span class="hl">Campaigns</span></h1><p class="sub">New campaigns start here. A campaign is created in the CRM only after it is approved, so the name is the same everywhere. ${waiting ? `<b>${waiting} waiting for approval.</b>` : ''}</p>
    <div class="card"><h2>Request a new campaign</h2><p class="sub">For ${esc(brand.name)}. Change the brand filter above to request for another brand.</p>
      <form id="new"><div class="grid2">
        <label>Level 1 <select name="level1_id">${meta.channels.map((ch) => `<optgroup label="${esc(ch.name)}">${opts(meta.level1.filter((l) => l.channel_id === ch.id))}</optgroup>`).join('')}</select></label>
        <label>Short descriptor <input name="descriptor" type="text" placeholder="Spring Storm Mailer" required></label>
        <label>Vendor <input name="vendor" type="text" placeholder="Valpak"></label>
        <label>Service period starts <select name="start_month">${openMonths.map((m) => `<option value="${m}" ${m === 'x' ? '' : m > meta.closedThrough && !openMonths.find((o) => o > meta.closedThrough && o < m) ? 'selected' : ''}>${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label>
        <label>Service period ends <select name="end_month">${openMonths.map((m) => `<option value="${m}" ${m === openMonths.at(-1) ? 'selected' : ''}>${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label>
        <label>Projected spend per month ($) <input name="monthly_spend" type="number" min="0" step="50" value="2000"></label>
        <label>Expected appointments per month <input name="exp_appts" type="number" min="0" value="12"></label>
        <label>Expected bookings per month ($) <input name="exp_bookings" type="number" min="0" step="500" value="50000"></label>
        <label>Landing page URL <input name="landing_url" type="url" placeholder="https://…"></label>
      </div>
      <p class="sub" style="margin:12px 0 4px">Market locations</p><div class="checks">${locs.map((l) => `<label><input type="checkbox" name="loc" value="${l.id}" checked>${esc(l.name)}</label>`).join('')}</div>
      <div class="preview" id="n-prev"></div>
      <p style="margin:12px 0 0"><button class="primary" type="submit">Submit for approval</button></p></form></div>
    <div class="card"><h2>Campaign master</h2><p class="sub">${list.length.toLocaleString()} campaigns${state.brand ? '' : ' across all brands'}${list.length > 300 ? '. Showing the first 300; pick a brand to narrow the list' : ''}.</p><div class="scroll"><table>
      <tr><th>Campaign</th><th class="l">Brand</th><th class="l">Level 1</th><th class="l">Service period</th><th>Plan $/mo</th><th>Plan CPA</th><th class="l">Status</th><th class="l">Tracking</th><th class="l">Action</th></tr>
      ${list.slice(0, 300).map((c) => `<tr><td class="mono">${esc(c.name)}</td><td class="l">${esc(c.brand)}</td><td class="l">${esc(c.level1)}</td>
        <td class="l">${c.start_month ? `${mlabel(c.start_month)} – ${mlabel(c.end_month)} ${c.end_month.slice(0, 4)}` : '—'}</td>
        <td>${c.monthly_spend ? money(c.monthly_spend) : '—'}</td><td>${c.exp_appts ? money(c.monthly_spend / c.exp_appts) : '—'}</td>
        <td class="l"><span class="chip ${c.status}">${c.status}</span>${c.decided_by ? ` <span class="muted">by ${esc(c.decided_by)}</span>` : ''}</td>
        <td class="l wrap mono">${c.tracking_phone ? `${esc(c.tracking_phone)}<br>${esc(c.tracking_url)}` : '—'}</td><td class="l">${actions(c)}</td></tr>`).join('')}</table></div></div>`;

  const form = $('#new'), l1name = () => meta.level1.find((l) => String(l.id) === form.level1_id.value).name;
  const clean = (s) => s.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const prev = () => {
    const sp = Number(form.monthly_spend.value) || 0, ap = Number(form.exp_appts.value) || 0, bk = Number(form.exp_bookings.value) || 0;
    $('#n-prev').innerHTML = `Campaign name: <span class="mono">${esc(`${brand.code}_${clean(l1name())}_${clean(form.descriptor.value) || '…'}_${form.start_month.value.slice(0, 4)}`)}</span><br>
      Plan: CPA ${ap ? money(sp / ap) : '—'}, ROAS ${sp ? (bk / sp).toFixed(1) + 'x' : '—'}. The tracking link and phone number are issued when the campaign is pushed to the CRM.`;
  };
  form.oninput = prev; prev();
  form.onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form)); delete d.loc;
    act(() => api('/api/campaigns', { ...d, brand_id: brandId, level1_id: Number(d.level1_id), location_ids: $$('input[name=loc]:checked', form).map((i) => Number(i.value)) }), 'Campaign submitted for approval');
  };
  $$('[data-decide]', el).forEach((b) => (b.onclick = () => act(() => api('/api/campaigns/decide', { id: Number(b.dataset.id), decision: b.dataset.decide }), `Campaign ${b.dataset.decide}`)));
  $$('[data-push]', el).forEach((b) => (b.onclick = () => act(() => api('/api/campaigns/push', { id: Number(b.dataset.push) }), 'Campaign pushed to CRM (simulated)')));
}

// ---- Mappings --------------------------------------------------------------
async function mappings(el) {
  const tabs = { names: 'CRM campaign names', links: 'Spend links', ledger: 'Ledger spend', hierarchy: 'Channel and Level 1', brands: 'Brands and regions', changes: 'Changes' };
  let html = `<h1>Maestro <span class="hl">Mappings</span></h1><p class="sub">Tie each CRM campaign name to one campaign, each campaign to a Level 1, and each Level 1 to a Channel.</p>
    <div class="tabs">${Object.entries(tabs).map(([k, n]) => `<button data-tab="${k}" class="${k === state.mapTab ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  if (state.mapTab === 'names') {
    const names = await api('/api/mappings?' + scope()), open = names.filter((n) => n.status === 'open'), fix = names.filter((n) => n.status === 'fix_in_crm');
    const extra = names.filter((n) => n.status === 'mapped' && n.raw_name !== n.campaign);
    const all = open.length ? await api('/api/campaigns?' + scope()) : [];
    const un = await api('/api/unspecified?' + scope());
    const pick = (n) => { const sug = n.suggestions || [], rest = all.filter((c) => c.brand_id === n.brand_id && c.status !== 'rejected' && c.status !== 'pending' && !sug.some((s) => s.id === c.id));
      return `<select data-pick="${n.id}">${sug.length ? `<optgroup label="Suggested">${sug.map((s) => `<option value="${s.id}">${esc(s.name)} · ${s.confidence}% match</option>`).join('')}</optgroup>` : '<option value="">No close match: choose…</option>'}<optgroup label="All campaigns">${opts(rest)}</optgroup></select>`; };
    html += `<div class="tiles"><div class="tile"><div class="k">Names to map</div><div class="v">${open.length}</div><div class="d">${int(open.reduce((a, n) => a + n.leads, 0))} leads waiting</div></div>
      <div class="tile"><div class="k">Mapped</div><div class="v">${names.length - open.length - fix.length}</div><div class="d">${extra.length} are alternate spellings</div></div>
      <div class="tile"><div class="k">Campaigns without a Level 1</div><div class="v">${un.length}</div><div class="d">${int(un.reduce((a, c) => a + c.leads, 0))} leads, ${compact(un.reduce((a, c) => a + c.spend, 0))} spend</div></div>
      <div class="tile"><div class="k">Fix in the CRM</div><div class="v">${fix.length}</div><div class="d">Not real campaign names</div></div></div>
      <div class="card"><h2>Names to map</h2><p class="sub">Sorted by leads. The suggested match is scored on how closely the name resembles a campaign in the same brand.</p><div class="scroll"><table>
      <tr><th>CRM campaign name</th><th class="l">Brand</th><th>Leads</th><th>Bookings $</th><th class="l">First seen</th><th class="l">Map to campaign</th><th class="l"></th></tr>
      ${open.map((n) => `<tr><td>${esc(n.raw_name)}</td><td class="l">${esc(n.brand)}</td><td>${int(n.leads)}</td><td>${money(n.bookings)}</td><td class="l">${esc(n.first_seen)}</td><td class="l">${pick(n)}</td>
        <td class="l"><button class="primary" data-map="${n.id}">Map</button> <button data-fix="${n.id}">Fix in CRM</button></td></tr>`).join('') || '<tr><td colspan="7" class="l muted">Nothing left to map.</td></tr>'}</table></div></div>
      <div class="card"><h2>Campaigns without a Level 1</h2><p class="sub">Sorted by leads and spend. Where another brand already maps the same campaign name, that Level 1 is pre-selected.${un.length > 100 ? ` Showing the top 100 of ${un.length}.` : ''}</p><div class="scroll"><table>
      <tr><th>Campaign</th><th class="l">Brand</th><th>Leads</th><th>Bookings $</th><th>Spend</th><th class="l">Level 1</th><th class="l">Why</th><th class="l"></th></tr>
      ${un.slice(0, 100).map((c) => `<tr><td>${esc(c.name)}</td><td class="l">${esc(c.brand)}</td><td>${int(c.leads)}</td><td>${money(c.bookings)}</td><td>${money(c.spend)}</td>
        <td class="l"><select data-un="${c.id}">${c.suggest ? '' : '<option value="">Choose…</option>'}${meta.channels.map((ch) => `<optgroup label="${esc(ch.name)}">${opts(meta.level1.filter((l) => l.channel_id === ch.id && l.name !== '(Unspecified)'), c.suggest?.id)}</optgroup>`).join('')}</select></td>
        <td class="l muted">${c.suggest ? esc(c.suggest.why) : 'No suggestion'}</td><td class="l"><button class="primary" data-assign="${c.id}">Assign</button></td></tr>`).join('') || '<tr><td colspan="8" class="l muted">Every campaign has a Level 1.</td></tr>'}</table></div></div>
      <div class="card"><h2>Alternate spellings and CRM fixes</h2><div class="scroll"><table><tr><th>CRM campaign name</th><th class="l">Brand</th><th>Leads</th><th class="l">Outcome</th><th class="l"></th></tr>
      ${[...extra, ...fix].map((n) => `<tr><td>${esc(n.raw_name)}</td><td class="l">${esc(n.brand)}</td><td>${int(n.leads)}</td><td class="l">${n.status === 'mapped' ? `Mapped to ${esc(n.campaign)}` : 'Flagged to fix in the CRM'}</td><td class="l"><button class="link" data-reopen="${n.id}">Reopen</button></td></tr>`).join('') || '<tr><td colspan="5" class="l muted">None yet.</td></tr>'}</table></div></div>`;
  } else if (state.mapTab === 'links') {
    const rows = await api('/api/links?' + scope()), total = rows.reduce((a, r) => a + r.spend, 0);
    const by = (s) => rows.filter((r) => r.status === s), amt = (list) => list.reduce((a, r) => a + r.spend, 0);
    const done = [...by('linked'), ...by('same name')], todo = [...by('suggested'), ...by('needs a pick'), ...by('no candidate')];
    const crm = state.brand ? (await api('/api/campaigns?' + scope())).filter((c) => c.source === 'crm') : [];
    const pick = (r) => `<select data-link-pick="${r.id}">${r.suggestions.length ? `<optgroup label="Suggested">${r.suggestions.map((s) => `<option value="${s.id}">${esc(s.name)} · ${int(s.leads)} leads</option>`).join('')}</optgroup>` : '<option value="">Choose…</option>'}${crm.length ? `<optgroup label="All CRM campaigns">${opts(crm.filter((c) => !r.suggestions.some((s) => s.id === c.id)))}</optgroup>` : ''}</select>`;
    const chip = { suggested: 'approved', 'needs a pick': 'pending', 'no candidate': 'rejected', linked: 'live', 'same name': 'live' };
    html += `<div class="tiles">
      <div class="tile"><div class="k">Linked spend</div><div class="v">${total ? pct(amt(done) / total) : '—'}</div><div class="d">${compact(amt(done))} of ${compact(total)} across ${done.length} campaigns</div></div>
      <div class="tile"><div class="k">Ready to accept</div><div class="v">${by('suggested').length}</div><div class="d">${compact(amt(by('suggested')))}, one clear CRM match</div></div>
      <div class="tile"><div class="k">Needs a pick</div><div class="v">${by('needs a pick').length}</div><div class="d">${compact(amt(by('needs a pick')))}, several CRM names fit</div></div>
      <div class="tile"><div class="k">No candidate</div><div class="v">${by('no candidate').length}</div><div class="d">${compact(amt(by('no candidate')))}, leads use another name</div></div></div>
      <div class="card"><div class="row" style="justify-content:space-between"><div><h2>Ad-platform campaigns to link</h2><p class="sub">Sorted by spend, full year. Linking moves a campaign's spend onto the CRM campaign in Insights; several ad campaigns can share one CRM campaign.${state.brand ? '' : ' Pick a brand above to choose from all of its CRM campaigns.'}${todo.length > 150 ? ` Showing the top 150 of ${todo.length}.` : ''}</p></div>
        <button class="primary" id="accept-links" ${by('suggested').length ? '' : 'disabled'}>Accept ${by('suggested').length} clear matches</button></div>
      <div class="scroll"><table><tr><th>Ad-platform campaign</th><th class="l">Brand</th><th class="l">Platform</th><th class="l">Level 1</th><th>Spend</th><th class="l">Status</th><th class="l">CRM campaign</th><th class="l">Why</th><th class="l"></th></tr>
      ${todo.slice(0, 150).map((r) => `<tr><td class="wrap">${esc(r.name)}</td><td class="l">${esc(r.brand)}</td><td class="l">${PLATFORM_NAME[r.source]}</td><td class="l">${esc(r.level1)}</td><td>${money(r.spend)}</td>
        <td class="l"><span class="chip ${chip[r.status]}">${r.status}</span></td><td class="l">${pick(r)}</td><td class="l wrap muted">${esc(r.suggestions[0]?.why || 'No CRM campaign in this brand resembles it')}</td>
        <td class="l"><button class="primary" data-link="${r.id}">Link</button></td></tr>`).join('') || '<tr><td colspan="9" class="l muted">Every ad-platform campaign is linked.</td></tr>'}</table></div></div>
      <div class="card"><h2>Linked</h2><div class="scroll"><table><tr><th>Ad-platform campaign</th><th class="l">Brand</th><th class="l">Platform</th><th>Spend</th><th class="l">CRM campaign</th><th class="l"></th></tr>
      ${done.slice(0, 300).map((r) => `<tr><td class="wrap">${esc(r.name)}</td><td class="l">${esc(r.brand)}</td><td class="l">${PLATFORM_NAME[r.source]}</td><td>${money(r.spend)}</td>
        <td class="l">${r.status === 'linked' ? esc(r.linked_name) : 'Same name in the CRM'}</td><td class="l">${r.status === 'linked' ? `<button class="link" data-unlink="${r.id}">Unlink</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="l muted">Nothing linked yet.</td></tr>'}</table></div></div>`;
  } else if (state.mapTab === 'ledger') {
    if (!state.brand) html += '<div class="banner" style="background:var(--wash);border-color:#cfe0f5">Pick one brand above to see its ledger spend and assign it to CRM campaigns.</div>';
    else {
      const d = await api(`/api/ledger?${scope()}&year=${state.year}`), T = d.totals, f = state.ledger;
      const status = (g) => (g.rule ? 'rule' : g.covered >= g.amount - 0.5 && g.amount > 0 ? 'covered' : g.open > 0.5 ? (g.assigned > 0.5 ? 'part' : 'open') : 'done');
      const label = { rule: ['live', 'Vendor rule'], covered: ['', 'Covered by ad platform'], part: ['pending', 'Partly assigned'], open: ['rejected', 'Needs a campaign'], done: ['live', 'Assigned'] };
      const shown = d.groups.filter((g) => (f.show === 'all' || (f.show === 'open' ? ['open', 'part'].includes(status(g)) : f.show === 'assigned' ? ['rule', 'done', 'part'].includes(status(g)) : status(g) === 'covered')) && (!f.q || (g.vendor || '(no vendor)').toLowerCase().includes(f.q.toLowerCase())));
      const l1n = Object.fromEntries(meta.level1.map((l) => [l.id, l.name]));
      const pickCamp = (sel, attrs) => `<select ${attrs}><option value="">Choose a campaign…</option>${meta.level1.filter((l) => d.campaigns.some((c) => c.level1_id === l.id)).map((l) => `<optgroup label="${esc(l.name)}">${opts(d.campaigns.filter((c) => c.level1_id === l.id), sel)}</optgroup>`).join('')}</select>`;
      ledgerCampaigns = d.campaigns;
      html += `<div class="tiles">
        <div class="tile"><div class="k">Ledger spend · ${d.year}</div><div class="v">${compact(T.amount)}</div><div class="d">${d.groups.reduce((a, g) => a + g.lines, 0).toLocaleString()} lines</div></div>
        <div class="tile"><div class="k">On a CRM campaign</div><div class="v">${compact(T.assigned)}</div><div class="d">${T.amount ? pct(T.assigned / T.amount) : '—'} of the ledger, by rule or by hand</div></div>
        <div class="tile"><div class="k">Covered by ad platform</div><div class="v">${compact(T.covered)}</div><div class="d">Campaign detail comes from the feed</div></div>
        <div class="tile"><div class="k">Needs a campaign</div><div class="v">${compact(T.open)}</div><div class="d">${T.amount ? pct(T.open / T.amount) : '—'} of the ledger, shown as "Other GL spend"</div></div></div>
      <div class="card"><div class="row" style="justify-content:space-between"><div><h2>Ledger spend by vendor</h2><p class="sub" style="margin:0">Nothing is assigned automatically. Choose the CRM campaign a vendor's spend is for and select "Assign all" to make it a rule for that vendor, or open the lines to assign or split them one at a time. Lines with no vendor name are grouped by Level 1 and can take a rule the same way.</p></div>
        <div class="row"><label>Show <select id="lg-show">${[['open', 'Needs a campaign'], ['assigned', 'Assigned'], ['covered', 'Covered by ad platform'], ['all', 'Everything']].map(([v, n]) => `<option value="${v}" ${v === f.show ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Vendor contains <input type="text" id="lg-q" value="${esc(f.q)}" placeholder="e.g. iHeart"></label></div></div>
        <div class="scroll" style="margin-top:10px"><table><tr><th>Vendor</th><th class="l">Level 1</th><th>Lines</th><th>Ledger spend</th><th>Still to assign</th><th class="l">Status</th><th class="l">CRM campaign</th><th class="l">Why suggested</th><th class="l"></th></tr>
        ${shown.slice(0, 200).map((g) => { const st = status(g), i = d.groups.indexOf(g); return `<tr><td class="wrap">${g.vendor ? esc(g.vendor) : '<span class="muted">No vendor on the line</span>'}</td><td class="l">${esc(l1n[g.level1_id] || '')}</td><td>${g.lines}</td><td>${money(g.amount)}</td><td>${st === 'covered' ? '—' : money(Math.max(0, g.open))}</td>
          <td class="l"><span class="chip ${label[st][0]}">${label[st][1]}</span></td>
          <td class="l">${st === 'covered' ? '<span class="muted">—</span>' : pickCamp(g.rule?.campaign_id ?? g.suggest?.id, `data-lg-pick="${i}"`)}</td>
          <td class="l wrap muted">${g.rule ? 'Rule in place' : g.suggest ? esc(g.suggest.why[0].toUpperCase() + g.suggest.why.slice(1)) : st === 'covered' ? '' : 'No clear campaign'}</td>
          <td class="l" style="white-space:nowrap">${st !== 'covered' ? `<button class="primary" data-lg-rule="${i}" title="${g.vendor_key ? 'Every line from this vendor in this Level 1, now and on future imports' : 'Every line in this Level 1 that has no vendor name, now and on future imports'}">${g.rule ? 'Change' : 'Assign all'}</button> ` : ''}${g.rule ? `<button data-lg-unrule="${i}">Remove rule</button> ` : ''}<button data-lg-lines="${i}">Lines ›</button></td></tr>`; }).join('') || '<tr><td class="l muted" colspan="9">Nothing here for this selection.</td></tr>'}</table></div>
        ${shown.length > 200 ? `<p class="sub" style="margin:8px 0 0">Showing the 200 largest of ${shown.length}. Use the vendor search to narrow it.</p>` : ''}</div>`;
      ledgerGroups = d.groups;
    }
  } else if (state.mapTab === 'brands') {
    const list = [...meta.brands].sort((x, y) => x.region.localeCompare(y.region) || x.name.localeCompare(y.name));
    html += `<div class="card"><h2>Brands and regions</h2><p class="sub">Each brand sits in one region, and the region sets its division (Canada, or US for every other region). These drive the Division and Region filters at the top of every screen.</p><div class="scroll"><table>
      <tr><th>Brand</th><th class="l">Division</th><th class="l">Region</th><th class="l">Currency</th><th class="l">Ledger loaded</th><th>Market locations</th></tr>
      ${list.map((b) => `<tr><td>${esc(b.name)}</td><td class="l">${b.division}</td><td class="l"><select data-region="${b.id}" aria-label="Region for ${esc(b.name)}">${meta.regions.concat(meta.regions.includes('Unassigned') ? [] : ['Unassigned']).map((r) => `<option ${r === b.region ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="l">${b.currency}</td><td class="l">${b.in_ledger ? 'Yes' : 'No'}</td><td>${meta.locations.filter((l) => l.brand_id === b.id).length}</td></tr>`).join('')}</table></div></div>`;
  } else if (state.mapTab === 'hierarchy') {
    const all = state.brand ? (await api('/api/campaigns?' + scope())).filter((c) => c.status !== 'rejected') : [];
    html += `<div class="cols" style="margin-bottom:16px">${meta.channels.map((ch, i) => `<div class="card"><h2><i class="dot" style="background:${COLORS[i]}"></i>${esc(ch.name)}</h2><ul>
      ${meta.level1.filter((l) => l.channel_id === ch.id).map((l) => `<li><span>${esc(l.name)}<br><span class="muted">GL ${esc(l.gl_account || '—')}</span></span><select data-l1="${l.id}" aria-label="Channel for ${esc(l.name)}">${opts(meta.channels, ch.id)}</select></li>`).join('') || '<li class="muted">No Level 1 here</li>'}</ul></div>`).join('')}</div>
      <div class="card"><h2>Campaign to Level 1</h2><p class="sub">${state.brand ? `${all.length} campaigns.` : 'Pick a brand above to list its campaigns.'}</p><div class="scroll"><table><tr><th>Campaign</th><th class="l">Brand</th><th class="l">Vendor</th><th class="l">Level 1</th></tr>
      ${all.map((c) => `<tr><td>${esc(c.name)}</td><td class="l">${esc(c.brand)}</td><td class="l">${esc(c.vendor || '—')}</td><td class="l"><select data-camp="${c.id}">${opts(meta.level1, c.level1_id)}</select></td></tr>`).join('')}</table></div></div>`;
  } else {
    const log = await api('/api/audit');
    html += `<div class="card"><h2>Change log</h2><p class="sub">Every mapping, re-forecast and campaign decision, newest first.</p><div class="scroll"><table><tr><th>When</th><th class="l">Who</th><th class="l">Action</th><th class="l">Detail</th></tr>
      ${log.map((a) => `<tr><td class="l">${new Date(a.at).toLocaleString()}</td><td class="l">${esc(a.user)}</td><td class="l">${esc(a.action)}</td><td class="l wrap">${esc(a.detail)}</td></tr>`).join('')}</table></div></div>`;
  }
  el.innerHTML = html;
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { state.mapTab = b.dataset.tab; render(); }));
  $$('[data-map]', el).forEach((b) => (b.onclick = () => { const v = $(`[data-pick="${b.dataset.map}"]`).value; if (!v) return toast('Choose a campaign first', true); act(() => api('/api/mappings', { id: Number(b.dataset.map), campaign_id: Number(v) }), 'Name mapped'); }));
  if ($('#lg-show')) { $('#lg-show').onchange = (e) => { state.ledger.show = e.target.value; render(); }; $('#lg-q').onchange = (e) => { state.ledger.q = e.target.value; render(); }; }
  const ruleFor = (i, campaign_id) => ({ brand_id: Number(state.brand), level1_id: ledgerGroups[i].level1_id, vendor: ledgerGroups[i].vendor, campaign_id });
  $$('[data-lg-rule]', el).forEach((b) => (b.onclick = () => { const i = Number(b.dataset.lgRule), v = $(`[data-lg-pick="${i}"]`).value; if (!v) return toast('Choose a campaign first', true); act(() => api('/api/ledger/rule', ruleFor(i, Number(v))), 'Vendor rule saved: its lines now sit on that campaign'); }));
  $$('[data-lg-unrule]', el).forEach((b) => (b.onclick = () => act(() => api('/api/ledger/rule', ruleFor(Number(b.dataset.lgUnrule), null)), 'Rule removed')));
  $$('[data-lg-lines]', el).forEach((b) => (b.onclick = () => openLedgerLines(ledgerGroups[Number(b.dataset.lgLines)])));
  $$('[data-assign]', el).forEach((b) => (b.onclick = () => { const v = $(`[data-un="${b.dataset.assign}"]`).value; if (!v) return toast('Choose a Level 1 first', true); act(() => api('/api/campaigns/level1', { id: Number(b.dataset.assign), level1_id: Number(v) }), 'Level 1 assigned'); }));
  $$('[data-link]', el).forEach((b) => (b.onclick = () => { const v = $(`[data-link-pick="${b.dataset.link}"]`).value; if (!v) return toast('Choose a CRM campaign first', true); act(() => api('/api/links', { id: Number(b.dataset.link), crm_id: Number(v) }), 'Spend linked'); }));
  $$('[data-unlink]', el).forEach((b) => (b.onclick = () => act(() => api('/api/links', { id: Number(b.dataset.unlink), crm_id: null }), 'Spend unlinked')));
  if ($('#accept-links')) $('#accept-links').onclick = () => act(async () => { const r = await api('/api/links/accept', { brand: state.brand || null, region: state.region || null, division: state.division || null }); toast(`${r.linked} campaigns linked`); });
  $$('[data-region]', el).forEach((s) => (s.onchange = () => act(async () => { await api('/api/brands/region', { id: Number(s.dataset.region), region: s.value }); await loadMeta(); }, 'Region updated')));
  $$('[data-fix]', el).forEach((b) => (b.onclick = () => act(() => api('/api/mappings', { id: Number(b.dataset.fix), status: 'fix_in_crm' }), 'Flagged to fix in the CRM')));
  $$('[data-reopen]', el).forEach((b) => (b.onclick = () => act(() => api('/api/mappings', { id: Number(b.dataset.reopen) }), 'Name reopened')));
  $$('[data-l1]', el).forEach((s) => (s.onchange = () => act(async () => { await api('/api/level1', { id: Number(s.dataset.l1), channel_id: Number(s.value) }); meta = await api('/api/meta'); }, 'Level 1 moved')));
  $$('[data-camp]', el).forEach((s) => (s.onchange = () => act(() => api('/api/campaigns/level1', { id: Number(s.dataset.camp), level1_id: Number(s.value) }), 'Campaign moved')));
}

// ---- shell -----------------------------------------------------------------
// ---- Import ----------------------------------------------------------------
async function imports(el) {
  const s = await api('/api/import');
  const size = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB');
  el.innerHTML = `<h1>Maestro <span class="hl">Import</span></h1><p class="sub">Load extract files from a folder on this computer. Files are read in place; nothing is uploaded anywhere. Import the mappings workbook first.
    ${s.mode === 'real' ? 'The app is running on imported data.' : 'The app is running on synthetic demo data, which the first import replaces.'}</p>
    <div class="card"><h2>Import folder</h2><div class="row" style="margin-top:8px"><label style="flex:1">Folder path <input id="i-dir" type="text" value="${esc(s.dir)}" placeholder="Paste the folder that holds your extract files"></label><button id="i-set">Use this folder</button></div></div>
    <div class="card"><h2>Files</h2><p class="sub">${s.dir ? (s.exists ? `${s.files.length} spreadsheet files found.` : 'That folder no longer exists.') : 'Set a folder to see its files.'} Large files can take a few seconds.</p><div class="scroll"><table>
      <tr><th>File</th><th class="l">Recognised as</th><th>Size</th><th class="l">Modified</th><th class="l">Last import</th><th class="l"></th></tr>
      ${s.files.map((f) => { const d = f.kind && s.done[f.kind]; return `<tr><td>${esc(f.name)}</td><td class="l">${f.label ? esc(f.label) : '<span class="muted">Not recognised</span>'}</td><td>${size(f.size)}</td><td class="l">${new Date(f.modified).toLocaleString()}</td>
        <td class="l wrap muted">${d ? `${esc(d.file)} · ${new Date(d.at).toLocaleString()}<br>${d.result.map(esc).join('<br>')}` : '—'}</td>
        <td class="l">${f.kind ? `<button class="primary" data-import="${esc(f.name)}">Import</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="6" class="l muted">No .csv or .xlsx files here.</td></tr>'}</table></div></div>`;
  $('#i-set').onclick = () => act(() => api('/api/import/dir', { dir: $('#i-dir').value }), 'Folder set');
  $$('[data-import]', el).forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Importing…';
    try { const r = await api('/api/import/run', { name: b.dataset.import }); await loadMeta(); toast(`${r.label} imported`); render(); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Import'; }
  }));
}

const VIEWS = { insights, projections, campaigns, mappings, import: imports };
async function render() {
  const name = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'insights';
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + name));
  try { await VIEWS[name]($('#view')); } catch (e) { $('#view').innerHTML = `<div class="card">Could not load this screen: ${esc(e.message)}</div>`; }
}
// Division → Region → Brand → Market location: each choice narrows the lists after it.
const divisionOfRegion = (r) => (r === 'Canada' ? 'Canada' : 'US');
const inEntityScope = (b) => (!state.division || b.division === state.division) && (!state.region || b.region === state.region);
function fillFilters() {
  const pick = (id, all, list, sel) => ($(id).innerHTML = `<option value="">${all}</option>` + list.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join(''));
  pick('#f-division', 'All divisions', meta.divisions, state.division);
  pick('#f-region', 'All regions', meta.regions.filter((r) => !state.division || divisionOfRegion(r) === state.division), state.region);
  const brands = meta.brands.filter(inEntityScope).sort((a, b) => a.name.localeCompare(b.name)), ids = new Set(brands.map((b) => b.id));
  $('#f-brand').innerHTML = '<option value="">All brands</option>' + opts(brands, state.brand);
  $('#f-location').innerHTML = '<option value="">All locations</option>' + opts(meta.locations.filter((l) => (state.brand ? String(l.brand_id) === state.brand : ids.has(l.brand_id))), state.location, (l) => (state.brand ? l.name : `${l.name} · ${brandCode(l.brand_id)}`));
}
async function loadMeta() {
  meta = await api('/api/meta');
  if (!meta.regions.includes(state.region)) state.region = '';
  if (!meta.brands.some((b) => String(b.id) === state.brand && inEntityScope(b))) { state.brand = ''; state.location = ''; }
  if (!meta.years.includes(state.year)) state.year = meta.closedThrough.slice(0, 4);
  $('#f-year').innerHTML = meta.years.map((y) => `<option ${y === state.year ? 'selected' : ''}>${y}</option>`).join('');
  $('.tag').textContent = meta.mode === 'real' ? 'Prototype · imported data' : 'Prototype · synthetic data';
  fillFilters();
}
async function init() {
  await loadMeta();
  const narrowed = () => { state.brand = ''; state.location = ''; fillFilters(); render(); };
  $('#f-division').onchange = (e) => { state.division = e.target.value; if (state.region && state.division && divisionOfRegion(state.region) !== state.division) state.region = ''; narrowed(); };
  $('#f-region').onchange = (e) => { state.region = e.target.value; if (state.region) state.division = divisionOfRegion(state.region); narrowed(); };
  $('#f-brand').onchange = (e) => { state.brand = e.target.value; state.location = ''; fillFilters(); render(); };
  $('#f-location').onchange = (e) => {
    state.location = e.target.value;
    if (state.location && !state.brand) state.brand = String(meta.locations.find((l) => String(l.id) === state.location).brand_id);
    fillFilters(); render();
  };
  $('#f-year').onchange = (e) => { state.year = e.target.value; render(); };
  $('#role').onchange = (e) => { state.role = e.target.value; render(); };
  const paintCur = () => {
    $$('#cur button').forEach((b) => b.classList.toggle('on', b.dataset.cur === state.cur));
    const cad = meta.brands.filter((b) => b.currency === 'CAD').map((b) => b.name), other = state.cur === 'CAD' ? 'US-dollar' : 'Canadian-dollar';
    $('#fxnote').textContent = `Amounts in ${state.cur}. ` + (state.cur === 'USD' && !cad.length ? '' : `${other[0].toUpperCase() + other.slice(1)} brands${state.cur === 'USD' ? ` (${cad.join(', ')})` : ''} are translated at 1 CAD = ${meta.fx.toFixed(2)} USD.`);
  };
  $$('#cur button').forEach((b) => (b.onclick = () => { state.cur = b.dataset.cur; try { localStorage.setItem('maestro-currency', state.cur); } catch { /* private window */ } paintCur(); render(); }));
  paintCur();
  window.onhashchange = render;
  render();
}
init();
