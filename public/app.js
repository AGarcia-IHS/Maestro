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
const state = { perfBy: 'channel', paceOpen: new Set(), attnAll: false, perfSort: null, ledger: { show: 'open', q: '' }, vsMode: 'budget', chartMode: 'channel', pMeasure: 'spend', pBasis: 't3', pOpen: new Set(), grain: 'month', dateMode: 'months', dFrom: '', dTo: '', rangeYear: '', prevRange: null, division: '', region: '', hiddenCh: new Set(), year: '', cur: saved === 'CAD' ? 'CAD' : 'USD', brand: '', location: '', role: 'marketer', measure: 'spend', from: null, to: null, open: new Set(), mapTab: 'names', glMonth: null };
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

// ---- sortable tables ---------------------------------------------------------
// sort is { k, dir } (dir -1 = largest first). get[k] reads the value to sort on from a row. Blanks always go last.
function sortRows(rows, sort, get) {
  if (!sort || !get[sort.k]) return rows;
  const f = get[sort.k], blank = (v) => v == null || (typeof v === 'number' && !Number.isFinite(v));
  return rows.sort((a, b) => { const x = f(a), y = f(b); if (blank(x) || blank(y)) return blank(x) - blank(y); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir; });
}
const sortMark = (sort, k) => (sort?.k === k ? (sort.dir < 0 ? ' ▼' : ' ▲') : '');
// What a click on heading k does to the current sort. With "off", a third click returns to the default order.
const nextSort = (sort, k, off) => (sort?.k !== k ? { k, dir: k === 'name' ? 1 : -1 } : off && sort.dir === (k === 'name' ? -1 : 1) ? null : { k, dir: -sort.dir });
const changeOn = (now, before) => (now != null && before != null && Math.abs(before) > 1e-9 ? now / before - 1 : null);

// ---- chart -----------------------------------------------------------------
// Stacked bars drawn at the real pixel width of their container and redrawn when that changes.
// A click on a bar and a double-click on a colour are told apart by a short delay.
function stackedChart(host, opts) {
  const { buckets, series, markers, fmt, label, title, onBucket, onSeries, hint, line, compare, compareName, noTotal, small } = opts;
  const W = Math.max(300, Math.round(host.clientWidth || 960)), H = Math.round(Math.min(440, Math.max(small ? 190 : 230, W * (small ? 0.46 : 0.34))));
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
      // an interval with no figure (a ratio with nothing to divide by) breaks the line rather than dropping to zero
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? ' L' : ' M'}${cx(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`; pen = true; });
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.bold ? 3.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n <= 45) svg += s.values.map((v, i) => (v == null ? '' : `<circle cx="${cx(i)}" cy="${y(Math.max(0, v))}" r="${s.bold ? 4 : 3}" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`)).join('');
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
    if (n <= (small ? 16 : 62)) svg += pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${small ? 3 : 4}" fill="var(--py)" stroke="var(--surface)" stroke-width="${small ? 1.5 : 2}"/>`).join('');
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
      (noTotal ? '' : `<div><span><b style="display:inline">Total</b></span><span><b style="display:inline">${fmt(totals[i])}</b></span></div>`) +
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
  const idx = new Map(data.buckets.map((b, i) => [b, i])), by = new Map(), rt = RATIO_OF[measure];
  for (const r of data.rows) {
    if (r.key == null) continue;
    const s = by.get(r.key) || by.set(r.key, { id: r.key, name: names(r.key), values: data.buckets.map(() => 0), den: data.buckets.map(() => 0), total: { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 } }).get(r.key);
    if (rt) { s.values[idx.get(r.bucket)] += r[rt[0]] || 0; s.den[idx.get(r.bucket)] += r[rt[1]] || 0; } else s.values[idx.get(r.bucket)] += r[measure] || 0;
    for (const k in s.total) s.total[k] += r[k] || 0;
  }
  return [...by.values()].map((s) => ({ ...s, values: rt ? s.values.map((v, i) => (s.den[i] > 0.5 ? v / s.den[i] : null)) : s.values, color: colorOf(s.id) }));
}

// ---- Marketing Dashboard ---------------------------------------------------
const MEASURES = { spend: 'Spend', leads: 'Leads', appts: 'Appointments', sales: 'Sales', bookings: 'Bookings $' };
const rangeQuery = () => scope() + `&from=${state.dFrom}&to=${state.dTo}`;
let ins = null; // what the Marketing Dashboard and Insights screens last loaded
// ---- chart measures ----------------------------------------------------------
// The trend chart can show the five funnel stages or the five ratios. Ratios cannot be stacked, so they are drawn as lines.
const RATIO_NAMES = { cpl: 'CPL', cpa: 'CPA', mcob: 'MCOB', conv: 'Conversion', close: 'Closing rate' };
const CHART_MEASURES = { ...MEASURES, ...RATIO_NAMES };
const mfmt = (m) => (m === 'spend' || m === 'bookings' ? compact : m === 'cpl' || m === 'cpa' ? money : RATIO_OF[m] ? pct : int);
// One figure per interval for everything in a series response (optionally one channel, or all but the hidden ones).
function seriesTotal(data, measure, keep = () => true) {
  const idx = new Map(data.buckets.map((b, i) => [b, i])), rt = RATIO_OF[measure], top = data.buckets.map(() => 0), den = data.buckets.map(() => 0);
  for (const r of data.rows) { if (r.key == null || !keep(r.key)) continue; const i = idx.get(r.bucket); if (rt) { top[i] += r[rt[0]] || 0; den[i] += r[rt[1]] || 0; } else top[i] += r[measure] || 0; }
  return rt ? top.map((v, i) => (den[i] > 0.5 ? v / den[i] : null)) : top;
}
// Each channel against the same period last year: one small chart per channel, this year in the channel's colour and
// last year as the dashed line, so every channel is read on its own scale.
function pyCharts(host, el) {
  host._ro?.disconnect();
  const m = state.measure, g = state.grain, rt = RATIO_OF[m], fmt = mfmt(m), P = ins.pySeries;
  if (!P) { host.innerHTML = '<p class="sub" style="padding:28px 0;margin:0">There is no prior-year data loaded for these dates.</p>'; return; }
  const sums = (data, keep) => { const t = { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 }; for (const r of data.rows) if (r.key != null && keep(r.key)) for (const k in t) t[k] += r[k] || 0; return t; };
  const figure = (t) => (rt ? ratioOf(t, m) : t[m]);
  const align = (vals) => ins.series.buckets.map((_, i) => (i < vals.length ? vals[i] : null));
  const shown = (id) => !state.hiddenCh.has(id);
  const panels = [{ id: 'all', name: 'All channels', color: 'var(--ink)', keep: shown }, ...meta.channels.map((c, i) => ({ id: c.id, name: c.name, color: COLORS[i], keep: (k) => k === c.id })).filter((p) => shown(p.id))]
    .map((p) => ({ ...p, now: figure(sums(ins.series, p.keep)), before: figure(sums(P, p.keep)), values: seriesTotal(ins.series, m, p.keep), py: align(seriesTotal(P, m, p.keep)) }))
    .filter((p) => p.now || p.before);
  const chip = (p) => {
    if (p.now == null || p.before == null || !(Math.abs(p.before) > 1e-9)) return '<span class="muted">no prior year</span>';
    const d = p.now / p.before - 1, up = d >= 0, cls = m === 'spend' ? 'flat' : up !== !!KPIS[m]?.lowGood ? 'up' : 'down';
    return `<span class="zpy ${cls}">${up ? '▲ +' : '▼ −'}${(Math.abs(d) * 100).toFixed(1)}%</span>`;
  };
  host.innerHTML = `<div class="pygrid">${panels.map((p, i) => `<div class="pyp"><div class="pyp-h"><span><i class="dot" style="background:${p.color}"></i><b>${esc(p.name)}</b></span>
    <span>${p.now == null ? '—' : fmt(p.now)} <span class="muted">vs ${p.before == null ? '—' : fmt(p.before)}</span> ${chip(p)}</span></div><div class="chart" data-pyc="${i}"></div></div>`).join('') || '<p class="sub" style="padding:28px 0;margin:0">Nothing to show for this selection.</p>'}</div>`;
  panels.forEach((p, i) => stackedChart($(`[data-pyc="${i}"]`, host), {
    buckets: ins.series.buckets, series: [{ id: p.id, name: 'This year', color: p.color, values: p.values }], fmt, line: g === 'day' || !!rt, noTotal: true, small: true,
    compare: p.py, compareName: 'Last year', label: bucketLabel[g], title: bucketTitle[g], hint: p.id === 'all' ? '' : 'Double-click to break it down by Level 1',
    onSeries: p.id === 'all' ? null : () => openDrill([{ group: 'level1', id: p.id, name: p.name }]),
  }));
}


const yearBack = (d) => { const y = Number(d.slice(0, 4)) - 1, rest = d.slice(4) === '-02-29' ? '-02-28' : d.slice(4); return y + rest; };
// "VS. PY" chips in the portal's style: the change in the figure and in percent against the same dates last year.
function pyChips(now, before, { fmt, goodWhenUp = true, neutral = false, points = false }) {
  if (before == null || !Number.isFinite(before) || Math.abs(before) < 1e-9 || now == null) return '<div class="py"><span class="chip pyl">VS. PY</span><span class="muted" style="font-size:11.5px">no prior-year figure</span></div>';
  const diff = now - before, up = diff >= 0, cls = neutral ? 'flat' : up === goodWhenUp ? 'good' : 'bad';
  return `<div class="py"><span class="chip pyl">VS. PY</span><span class="chip ${cls}">${up ? '+' : '−'}${fmt(Math.abs(diff))}${points ? '' : ''}</span><span class="chip ${cls}">${up ? '▲' : '▼'} ${up ? '+' : '−'}${(Math.abs(diff / before) * 100).toFixed(1)}%</span></div>`;
}
// ---- spend reconciliation: ledger, ad platforms and what Maestro presents, by month ----
function reconCard() {
  const R = ins.recon, months = R.months, at = new Map(months.map((m, i) => [m, i]));
  if (!months.length) return '';
  const l1n = Object.fromEntries(meta.level1.map((l) => [l.id, l.name])), bn = Object.fromEntries(meta.brands.map((b) => [b.id, b.name]));
  const is = (k) => (c) => (c.kind === k ? 1 : 0);
  // each row is a weight on every cell, so a difference row is just "shown minus ledger"
  const vec = (w, keyOf) => { const by = new Map(); for (const c of R.cells) { const x = w(c); if (!x) continue; const k = keyOf ? keyOf(c) : 0; (by.get(k) || by.set(k, months.map(() => 0)).get(k))[at.get(c.month)] += x * c.v; } return by; };
  const tot = (a) => a.reduce((x, y) => x + y, 0), cell = (v) => (Math.abs(v) < 0.5 ? '<span class="muted">—</span>' : money(v));
  // closed months get their own total, so an open month's provisional figures do not blur whether the closed ones tie
  const hasOpen = months.some((m) => !closed(m)), totClosed = (a) => a.reduce((x, v, i) => x + (closed(months[i]) ? v : 0), 0), red = (flag, v) => (flag && Math.abs(v) >= 100 ? 'down' : '');
  const tds = (a, flag) => a.map((v) => `<td class="${red(flag, v)}">${cell(v)}</td>`).join('') + (hasOpen ? `<td class="${red(flag, totClosed(a))}"><b>${cell(totClosed(a))}</b></td>` : '') + `<td class="${red(flag, tot(a))}"><b>${cell(tot(a))}</b></td>`;
  const row = (key, cls, label, w, { byBrand = false, flag = false, hideZero = false, help = '' } = {}) => {
    const a = vec(w).get(0) || months.map(() => 0);
    if (hideZero && !a.some((v) => Math.abs(v) >= 0.5)) return '';
    const open = state.open.has('r:' + key);
    let h = `<tr class="${cls}" data-key="r:${key}" style="cursor:pointer" ${help ? `title="${esc(help)}"` : ''}><td>${open ? '▾' : '▸'} ${label}</td>${tds(a, flag)}</tr>`;
    if (open) {
      const parts = [...vec(w, (c) => (byBrand ? c.brand_id : c.level1_id))].filter(([, x]) => x.some((v) => Math.abs(v) >= 0.5)).sort((x, y) => Math.abs(tot(y[1])) - Math.abs(tot(x[1])));
      h += parts.map(([k, x]) => `<tr class="src"><td>${esc((byBrand ? bn[k] : l1n[k]) || 'Other')}</td>${tds(x, flag)}</tr>`).join('') || `<tr class="src"><td class="muted">Nothing in ${R.year}</td><td colspan="${months.length + (hasOpen ? 2 : 1)}"></td></tr>`;
    }
    return h;
  };
  const many = !state.brand, openM = months.filter((m) => !closed(m));
  return `<div class="card"><h2>Spend reconciliation by month · ${R.year}</h2>
    <p class="sub">The ledger is the official spend. Maestro starts from what the ad platforms report, then adds reconciling lines so that each closed month comes back to the ledger. Select a row to open it by ${many ? 'Level 1 (the difference row opens by brand)' : 'Level 1'}.</p>
    <div class="scroll"><table><tr><th>Spend</th>${months.map((m) => `<th>${mlabel(m)}${closed(m) ? '' : ' *'}</th>`).join('')}${hasOpen ? '<th>Closed months</th>' : ''}<th>Total</th></tr>
      ${row('ledger', 'ch', 'Ledger actual (Acumatica)', is('ledger'), { help: 'Marketing accounts posted in Acumatica (QuickBooks for Watkins Construction), in the ACTUAL and ACTUALCAD ledgers' })}
      ${row('platform', 'ch', 'Third-party platform actual', is('platform'), { help: 'Google Ads, Bing Ads, Meta and Active Prospect, as reported by each platform feed' })}
      ${row('assigned', 'l1', 'Reconciling: ledger lines assigned to CRM campaigns', is('assigned'), { hideZero: true, help: 'Ledger lines someone assigned to a CRM campaign on Mappings → Ledger spend' })}
      ${row('other', 'l1', 'Reconciling: other GL spend (in the ledger, not on a platform)', is('other'), { help: 'Ledger spend that no platform feed reports: traditional media, agencies, events, and platform spend from before a feed was switched on' })}
      ${row('timing', 'l1', 'Reconciling: platform spend not yet in the GL', is('timing'), { help: 'Negative: the platforms report more than the ledger has booked for that Level 1 and month, from invoice timing or account coding' })}
      ${row('entered', 'l1', 'Reconciling: spend entered in Maestro', is('entered'), { hideZero: true })}
      ${row('shown', 'total', 'Spend presented in Maestro', (c) => (c.kind === 'ledger' ? 0 : 1), { help: 'Third-party platform actual plus the reconciling lines. This is the spend on the cards, chart and table above.' })}
      ${row('diff', 'ch', 'Difference: Maestro less ledger', (c) => (c.kind === 'ledger' ? -1 : 1), { byBrand: many, flag: true, help: 'Zero when a month is fully reconciled' })}
    </table></div>
    <p class="sub" style="margin:10px 0 0">A difference is left only where the ledger is not final: ${openM.length ? `open months (* ${openM.map(mlabel).join(', ')}), ` : ''}a brand-month with nothing posted in the ledger yet, or a brand that is not in any loaded ledger. There Maestro shows the platform figures as they are and does not net them down. Canadian brands are translated at ${meta.fx} throughout.${state.location ? ' For a single market location the reconciling lines are a share of the brand\'s, because platforms and the ledger do not always put spend on the same location, so a small difference by location is expected; it nets to zero for the brand.' : ''}</p></div>`;
}

// A figure with its variance underneath: the amount, then the percentage.
const sgn = (x, f) => (x >= 0 ? '+' : '−') + f(Math.abs(x));
function varCell(main, now, before, f, good, tip = '') {
  if (before == null || now == null || !(Math.abs(before) > 1e-9)) return `<td>${main}</td>`;
  const d = now - before, cls = good === 'flat' || Math.abs(d) < 1e-9 ? 'flat' : d > 0 === (good === 'up') ? 'up' : 'down';
  return `<td title="${tip}">${main}<div class="vr ${cls}">${sgn(d, f)} · ${sgn(d / Math.abs(before), pct)}</div></td>`;
}
const mcobOf = (spend, bookings) => (spend > 0 && bookings > 0.5 ? spend / bookings : null);
const ptsFmt = (x) => (x * 100).toFixed(1) + ' pts';
const groupBy = (list, f) => { const m = new Map(); for (const x of list) { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return [...m]; };
const brandName = (id) => meta.brands.find((b) => b.id === id)?.name || 'No brand';
const placeNames = () => ({ brandOf: new Map(meta.locations.map((l) => [l.id, l.brand_id])), loc: new Map(meta.locations.map((l) => [l.id, l.name])), ch: new Map(meta.channels.map((c) => [c.id, c.name])) });

// ---- month in progress -----------------------------------------------------
// Where a set of market-location and channel cells is heading by month-end. Ad-platform spend and outcomes are taken at
// their daily rate so far; spend that only arrives through the ledger is taken at its average of the last three closed months.
function paceFigures(cells, P) {
  const dS = Number(P.spendTo.slice(8)), dC = Number(P.crmTo.slice(8)), s = (f) => cells.reduce((a, x) => a + (f(x) || 0), 0), end = (v) => (v / dC) * P.days;
  const o = { platform: s((x) => x.platform), other: s((x) => x.other), leads: s((x) => x.leads), appts: s((x) => x.appts), bookings: s((x) => x.bookings),
    bSpend: s((x) => x.budget?.spend), bAppts: s((x) => x.budget?.appts), bBookings: s((x) => x.budget?.bookings) };
  // the recent average is moved by the season the budget expects: this month's budget against the budget of those three months
  const b3 = s((x) => x.b3);
  if (b3 > 0 && o.bSpend > 0) o.other *= o.bSpend / b3;
  return Object.assign(o, { spendEnd: (o.platform / dS) * P.days + o.other, leadsEnd: end(o.leads), apptsEnd: end(o.appts), bookingsEnd: end(o.bookings) });
}
function paceCard() {
  const P = ins.pace;
  if (!P?.month || !P.rows.length) return '';
  const N = placeNames(), levels = state.location ? ['ch'] : state.brand ? ['lo', 'ch'] : ['brand', 'lo'];
  const keyOf = { brand: (x) => N.brandOf.get(x.lo), lo: (x) => x.lo, ch: (x) => x.ch };
  const nameOf = { brand: brandName, lo: (id) => N.loc.get(id) || 'No market location', ch: (id) => N.ch.get(id) || 'Not mapped to a campaign' };
  const rowsOf = (cells, lv) => groupBy(cells, keyOf[lv]).map(([id, ls]) => ({ id, ls, name: nameOf[lv](id), f: paceFigures(ls, P) }))
    .filter((r) => r.f.spendEnd > 0.5 || r.f.leads || r.f.appts || r.f.bSpend > 0.5).sort((a, b) => b.f.spendEnd - a.f.spendEnd);
  const tr = (cls, key, label, f) => { return `<tr class="${cls}" ${key ? `data-pace="${key}"` : ''}><td>${label}</td><td>${money(f.platform)}</td>
    ${varCell(money(f.spendEnd), f.spendEnd, f.bSpend, compact, 'down', `Budget ${money(f.bSpend)}. Ad platforms at their daily rate ${money(f.spendEnd - f.other)}, plus other spend from its recent average ${money(f.other)}`)}
    <td>${int(f.leads)}</td><td>${int(f.leadsEnd)}</td><td>${int(f.appts)}</td>${varCell(int(f.apptsEnd), f.apptsEnd, f.bAppts, int, 'up', `Budget ${int(f.bAppts)}`)}
    <td>${money(f.bookings)}</td></tr>`; };
  let body = '';
  for (const r of rowsOf(P.rows, levels[0])) {
    const key = levels[1] ? `${levels[0]}${r.id}` : '', open = key && state.paceOpen.has(key);
    body += tr('ch', key, (key ? (open ? '▾ ' : '▸ ') : '') + esc(r.name), r.f);
    if (open) for (const c of rowsOf(r.ls, levels[1])) body += tr('l1', '', esc(c.name), c.f);
  }
  body += tr('total', '', 'Total', paceFigures(P.rows, P));
  const dS = Number(P.spendTo.slice(8)), dC = Number(P.crmTo.slice(8)), mName = `${bucketTitle.month(P.month)}`;
  return `<div class="card"><h2>${mName} leads so far, and where the month is heading</h2>
    <p class="sub">Ad-platform spend through ${niceDay(P.spendTo, false)} (${dS} of ${P.days} days); CRM outcomes through ${niceDay(P.crmTo, false)} (${dC} of ${P.days} days). The month-end estimates carry leads, their appointments and ad-platform spend forward at their daily rate so far. Bookings $ is what this month's leads have sold so far; it is not carried forward, because most of their sales are still to come. Spend that only reaches Maestro through the ledger is not posted yet for ${mlabel(P.month)}, so it is taken at its average of the last three closed months, moved up or down by how the month's budget compares with the budget of those three. The small line is the estimate against the month's budget${levels[1] ? `; select a row to open its ${levels[1] === 'lo' ? 'market locations' : 'channels'}` : ''}.</p>
    <div class="scroll"><table><tr><th>${{ brand: 'Brand / Market location', lo: 'Market location / Channel', ch: 'Channel' }[levels[0]]}</th><th>Ad-platform spend to date</th><th>Spend, month-end est.</th><th>Leads to date</th><th>Leads, month-end est.</th><th>Appts to date</th><th>Appts, month-end est.</th><th>Bookings $ from these leads so far</th></tr>${body}</table></div></div>`;
}

// ---- needs attention -------------------------------------------------------
// Everything in the current view that is more than 10% off budget, ranked by what it is worth in dollars.
function attention() {
  const C = ins.cmp;
  if (!C) return [];
  const N = placeNames(), by = state.location || state.brand ? 'lo' : 'brand', eOf = (x) => (by === 'brand' ? N.brandOf.get(x.lo) : x.lo), eName = (id) => (by === 'brand' ? brandName(id) : N.loc.get(id) || 'No market location');
  const go = (id) => (state.location ? '' : by === 'brand' ? `data-go-brand="${id}"` : `data-go-loc="${id}"`);
  const cells = new Map(), cell = (lo, ch) => { const e = eOf({ lo }), k = `${e}|${ch}`; return cells.get(k) || cells.set(k, { e, ch, spend: 0, appts: 0, bookings: 0, bSpend: 0, bAppts: 0, bBookings: 0 }).get(k); };
  for (const r of C.rows) { const x = cell(r.lo, r.ch); x.spend += r.spend; x.appts += r.appts; x.bookings += r.bookings; }
  for (const p of C.plan) { const x = cell(p.lo, p.ch); x.bSpend += p.budget.spend; x.bAppts += p.budget.appts; x.bBookings += p.budget.bookings; }
  const items = [], off = (gap, base, floor) => base > 0 && gap > Math.max(floor, base * 0.1);
  const outcomes = (e, tag, when, appts, bookings, bAppts, bBookings, worth) => {
    const sa = bAppts - appts, sb = bBookings - bookings, aBad = off(sa, bAppts, 5), bBad = off(sb, bBookings, 25000);
    if (!aBad && !bBad) return;
    const each = worth ?? (appts > 0 ? bookings / appts : bAppts > 0 ? bBookings / bAppts : 0);
    items.push({ tag, cls: 'warn', go: go(e), impact: Math.max(bBad ? sb : 0, aBad ? sa * each : 0), text: `<b>${esc(eName(e))}</b> ${when}${[aBad ? `appointments ${int(appts)}, ${int(sa)} behind budget (−${pct(sa / bAppts)})` : '', bBad ? `bookings ${compact(bookings)}, ${compact(sb)} behind budget (−${pct(sb / bBookings)})` : ''].filter(Boolean).join('; ')}` });
  };
  for (const x of cells.values()) if (off(x.spend - x.bSpend, x.bSpend, 5000))
    items.push({ tag: 'Spend', cls: '', go: go(x.e), impact: x.spend - x.bSpend, text: `<b>${esc(eName(x.e))} · ${esc(N.ch.get(x.ch) || 'Other')}</b> spend ${compact(x.spend)}, ${compact(x.spend - x.bSpend)} over budget (+${pct(x.spend / x.bSpend - 1)})` });
  for (const [e, xs] of groupBy([...cells.values()], (x) => x.e)) {
    const s = (k) => xs.reduce((a, x) => a + x[k], 0), spend = s('spend'), bookings = s('bookings');
    outcomes(e, 'Outcomes', '', s('appts'), bookings, s('bAppts'), s('bBookings'));
    const m = mcobOf(spend, bookings), mb = mcobOf(s('bSpend'), s('bBookings'));
    if (m != null && mb != null && m - mb > 0.005 && m > mb * 1.1) items.push({ tag: 'MCOB', cls: '', go: go(e), impact: (m - mb) * bookings, text: `<b>${esc(eName(e))}</b> MCOB ${pct(m)} against a budgeted ${pct(mb)}: ${compact((m - mb) * bookings)} more spend than budgeted for these bookings` });
  }
  const P = ins.pace;
  if (P?.month) for (const [e, ls] of groupBy(P.rows, eOf)) {
    const f = paceFigures(ls, P), mon = mlabel(P.month);
    if (off(f.spendEnd - f.bSpend, f.bSpend, 5000)) items.push({ tag: `${mon} pace`, cls: 'approved', go: go(e), impact: f.spendEnd - f.bSpend, text: `<b>${esc(eName(e))}</b> ${mon} spend is heading for ${compact(f.spendEnd)}, ${compact(f.spendEnd - f.bSpend)} over budget (+${pct(f.spendEnd / f.bSpend - 1)})` });
    outcomes(e, `${mon} pace`, `${mon} is heading for `, f.apptsEnd, 0, f.bAppts, 0, f.bAppts > 0 ? f.bBookings / f.bAppts : 0);
  }
  for (const i of items) if (i.tag.endsWith(' pace')) i.cls = 'approved';
  // Bookings dollars would always crowd out spend dollars, so the kinds take turns: the largest of each, then the next of each.
  const kinds = groupBy(items.sort((a, b) => b.impact - a.impact), (i) => i.tag).map(([, list]) => list), out = [];
  for (let n = 0; out.length < items.length; n++) for (const list of kinds) if (list[n]) out.push(list[n]);
  return out;
}
function attentionCard(rangeText) {
  const items = attention(), shown = state.attnAll ? items : items.slice(0, 6), what = state.location ? '' : state.brand ? 'market location' : 'brand';
  if (!ins.cmp) return '';
  return `<div class="card"><h2>Needs attention</h2>
    <p class="sub">${rangeText} against budget${ins.pace?.month ? `, and ${bucketTitle.month(ins.pace.month)} at its pace so far` : ''}: everything more than 10% off, the largest of each kind first, sized by what it is worth in dollars (for appointments, at the average bookings per appointment). Outcomes are by lead date, so the newest months are still filling in against a budget that is not.${what ? ` Select a line to open the Marketing Dashboard for that ${what}.` : ''}</p>
    ${items.length ? `<div class="attn">${shown.map((i) => `<div class="attn-i${i.go ? ' go' : ''}" ${i.go}><span class="chip ${i.cls}">${i.tag}</span><span>${i.text}</span><b class="amt">${compact(i.impact)}</b></div>`).join('')}</div>
    ${items.length > 6 ? `<button id="attn-more" style="margin-top:10px">${state.attnAll ? 'Show the top 6' : `Show all ${items.length}`}</button>` : ''}` : '<p style="margin:0">Nothing in this view is more than 10% off budget.</p>'}</div>`;
}

// ---- time frame ------------------------------------------------------------
// Ready-made periods for the Marketing Dashboard and Insights, counted back from the last day of data. Each one sets the
// same From and To the screens' own pickers do, with a chart interval that suits its length.
function timeFrames() {
  const through = meta.dataThrough, t = toDate(through), y = t.getFullYear(), m = t.getMonth(), q = Math.floor(m / 3) * 3, d = (yy, mm, dd) => iso(new Date(yy, mm, dd, 12));
  const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7)); // weeks run Monday to Sunday, as on the charts
  const first = meta.months[0] + '-01', from = (a) => (a < first ? first : a);
  return [
    ['wtd', 'WTD', 'Week to date', iso(mon), through, 'day'],
    ['lwk', 'LWK', 'Last week', d(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7), d(mon.getFullYear(), mon.getMonth(), mon.getDate() - 1), 'day'],
    ['mtd', 'MTD', 'Month to date', d(y, m, 1), through, 'day'],
    ['lmo', 'Last Mo', 'Last month', d(y, m - 1, 1), d(y, m, 0), 'day'],
    ['lqt', 'Last Qtr', 'Last quarter', d(y, q - 3, 1), d(y, q, 0), 'week'],
    ['qtd', 'QTD', 'Quarter to date', d(y, q, 1), through, 'week'],
    ['ytd', 'YTD', 'Year to date', d(y, 0, 1), through, 'month'],
  ].map(([k, name, title, a, b, grain]) => ({ k, name, title, from: from(a), to: b, grain })).filter((f) => f.to >= first);
}
function drawTimeFrame() {
  const on = ['dashboard', 'insights'].includes(location.hash.slice(1) || 'dashboard');
  $('#tf').hidden = !on;
  if (!on || !meta) return;
  const frames = timeFrames(), now = state.tfCustom ? null : frames.find((f) => f.from === state.dFrom && f.to === state.dTo);
  $('#tf-b').innerHTML = frames.map((f) => `<button data-tf="${f.k}" class="${f === now ? 'on' : ''}" title="${f.title}: ${niceDay(f.from)} to ${niceDay(f.to)}">${f.name}</button>`).join('')
    + `<button data-tf="custom" class="${now ? '' : 'on'}" title="Any dates, set with From and To on the screen${state.dFrom ? `. Now ${niceDay(state.dFrom)} to ${niceDay(state.dTo)}` : ''}">Custom</button>`;
  $$('[data-tf]', $('#tf-b')).forEach((b) => (b.onclick = () => {
    const f = frames.find((x) => x.k === b.dataset.tf);
    if (!f) { state.tfCustom = true; state.dateMode = 'dates'; render(); return; } // Custom: show the date pickers
    state.tfCustom = false;
    state.dFrom = f.from; state.dTo = f.to; state.grain = f.grain; state.prevRange = null;
    state.dateMode = f.from.endsWith('-01') && f.to === monthEnd(f.to.slice(0, 7)) ? 'months' : 'dates';
    const yr = f.to.slice(0, 4); if (meta.years.includes(yr)) { state.year = yr; $('#f-year').value = yr; }
    state.rangeYear = state.year;
    render();
  }));
}

// ---- Insights: what needs attention, and where the month is heading ----------
// Shares the filters and the period with the Marketing Dashboard, so moving between the two keeps your place.
async function attentionView(el) {
  const closedMonths = yearMonths().filter(closed);
  if (!closedMonths.length) { el.innerHTML = `<h1>Maestro <span class="hl">Insights</span> · ${state.year}</h1><div class="card">No months of ${state.year} are closed yet, so there is nothing to set against budget.</div>`; return; }
  if (state.rangeYear !== state.year || !state.dFrom) { state.rangeYear = state.year; state.dFrom = monthStart(closedMonths[0]); state.dTo = monthEnd(closedMonths.at(-1)); state.prevRange = null; }
  const pyFrom = yearBack(state.dFrom), pyTo = yearBack(state.dTo), hasPy = pyFrom >= meta.months[0] + '-01';
  const [cmp, pace] = await Promise.all([api(`/api/compare?${rangeQuery()}${hasPy ? `&pfrom=${pyFrom}&pto=${pyTo}` : ''}`), api('/api/pacing?' + scope())]);
  ins = { ...(ins || {}), cmp, pace };
  const through = meta.dataThrough, months = meta.months.filter((m) => m <= through.slice(0, 7));
  const opts = (sel) => months.map((m) => `<option ${m === sel ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('');
  const setRange = (a, b) => { state.prevRange = null; state.dFrom = a; state.dTo = b > through ? through : b; attentionView(el); };
  const draw = () => {
    drawTimeFrame();
    const a = state.dFrom.slice(0, 7), b = state.dTo.slice(0, 7), whole = state.dFrom.endsWith('-01') && state.dTo === monthEnd(b);
    const rangeText = whole ? (a === b ? bucketTitle.month(a) : `${bucketTitle.month(a)} to ${bucketTitle.month(b)}`) : `${niceDay(state.dFrom)} to ${niceDay(state.dTo)}`;
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div><h1>Maestro <span class="hl">Insights</span></h1><p class="sub" style="margin:0">What is off budget and worth a look, and where the month in progress is heading. The figures behind every line are on the <a href="#dashboard">Marketing Dashboard</a>.</p></div>
        <div class="row"><label>From <select id="a-from">${opts(a)}</select></label><label>To <select id="a-to">${opts(b)}</select></label></div>
      </div>
      ${attentionCard(rangeText)}
      ${paceCard()}`;
    $('#a-from').onchange = (e) => setRange(monthStart(e.target.value), e.target.value > b ? monthEnd(e.target.value) : state.dTo);
    $('#a-to').onchange = (e) => setRange(e.target.value < a ? monthStart(e.target.value) : state.dFrom, monthEnd(e.target.value));
    $$('tr[data-pace]', el).forEach((r) => (r.onclick = () => { const k = r.dataset.pace; state.paceOpen.has(k) ? state.paceOpen.delete(k) : state.paceOpen.add(k); draw(); }));
    if ($('#attn-more')) $('#attn-more').onclick = () => { state.attnAll = !state.attnAll; draw(); };
    // a line opens the dashboard for that brand or market location
    $$('[data-go-brand], [data-go-loc]', el).forEach((r) => (r.onclick = () => { if (r.dataset.goBrand) { state.brand = r.dataset.goBrand; state.location = ''; } else state.location = r.dataset.goLoc; fillFilters(); location.hash = '#dashboard'; }));
  };
  draw();
}

async function insights(el) {
  const closedMonths = yearMonths().filter(closed);
  if (!closedMonths.length) { el.innerHTML = `<h1>Marketing <span class="hl">Dashboard</span> · ${state.year}</h1><div class="card">No months of ${state.year} are closed yet, so there are no actuals or outcomes to analyse. The dashboard fills in as actuals arrive; budgets and forecasts for ${state.year} are on the Budget Manager screen. <button class="primary" id="back-year" style="margin-left:8px">Show ${meta.closedThrough.slice(0, 4)}</button></div>`; $('#back-year').onclick = () => { state.year = meta.closedThrough.slice(0, 4); $('#f-year').value = state.year; render(); }; return; }
  if (state.rangeYear !== state.year || !state.dFrom) { state.rangeYear = state.year; state.dFrom = monthStart(closedMonths[0]); state.dTo = monthEnd(closedMonths.at(-1)); state.prevRange = null; }
  const pyFrom = yearBack(state.dFrom), pyTo = yearBack(state.dTo), hasPy = pyFrom >= meta.months[0] + '-01';
  const [f, range, series, py, pySeries, recon, pyRange, cmp] = await Promise.all([api('/api/facts?' + scope()), api('/api/range?' + rangeQuery()), api(`/api/series?${rangeQuery()}&grain=${state.grain}&group=channel`),
    hasPy ? api(`/api/totals?${scope()}&from=${pyFrom}&to=${pyTo}&asof=1`) : null,
    hasPy ? api(`/api/series?${scope()}&from=${pyFrom}&to=${pyTo}&asof=1&grain=${state.grain}&group=channel`) : null,
    api(`/api/recon?${scope()}&year=${state.year}`),
    hasPy ? api(`/api/range?${scope()}&from=${pyFrom}&to=${pyTo}&asof=1`) : null,
    api(`/api/compare?${rangeQuery()}${hasPy ? `&pfrom=${pyFrom}&pto=${pyTo}` : ''}`)]);
  facts = f; ins = { range, series, py, pySeries, pyFrom, pyTo, recon, pyRange, cmp };
  if (state.chartMode === 'budget') ins.plan = await api(`/api/projections?${scope()}&year=${state.year}`);
  drawInsights(el);
}
function drawInsights(el) {
  drawTimeFrame();
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
  const rows = [...camps.values()].map((c) => ({ c, t: c.t })).filter((r) => Math.abs(r.t.actual) > 0.005 || r.t.leads || r.t.appts || r.t.sales || Math.abs(r.t.bookings) > 0.005);
  const tot = rows.reduce((t, r) => add(t, r.t), zero());
  const budgetOf = (chId) => ins.range.budget.reduce((a, p) => a + (chId == null || p.channel_id === chId ? p.budget : 0), 0);
  tot.budget = budgetOf();
  // The table can set spend against the fixed budget or against the current projection.
  const vs = ['budget', 'plan', 'py'].includes(state.vsMode) ? state.vsMode : 'budget', vsName = { budget: 'Budget', plan: 'Projection', py: 'Prior year' }[vs];
  // Budgets are loaded for spend, appointments and bookings, by Level 1. Projections are held by channel for the same three.
  const l1B = new Map();
  for (const b of ins.range.budgetL1) (l1B.get(b.level1_id) || l1B.set(b.level1_id, {}).get(b.level1_id))[b.measure] = b.budget;
  const chBudget = (chId, k) => (k === 'spend' ? budgetOf(chId) : meta.level1.reduce((a, l) => a + (chId == null || l.channel_id === chId ? l1B.get(l.id)?.[k] || 0 : 0), 0));
  const chPlan = (chId, k) => ins.range.plan.reduce((a, p) => a + (chId == null || p.channel_id === chId ? p[k === 'spend' ? 'plan' : k] || 0 : 0), 0);
  // The same period last year, added up the same way as this year: by campaign, with linked ad-platform spend moved to its CRM campaign.
  const info = new Map(facts.campaigns.map((c) => [c.id, c])), bump = (map, k) => map.get(k) || map.set(k, zero()).get(k);
  const pyT = new Map(), pyL1 = new Map(), pyCh = new Map(), pyAll = zero(), pyUn = zero();
  for (const r of ins.pyRange?.rows || []) {
    const c = r.key == null ? null : info.get(r.key); if (r.key != null && !c) continue;
    const own = !c || !(c.linked_to && info.has(c.linked_to)), t = !c ? pyUn : bump(pyT, own ? c.id : c.linked_to);
    t.actual += r.spend; if (own) { t.leads += r.leads; t.appts += r.appts; t.sales += r.sales; t.bookings += r.bookings; }
  }
  for (const [id, t] of pyT) { const l = l1[info.get(id).level1_id]; add(bump(pyL1, l.id), t); add(bump(pyCh, l.channel_id), t); add(pyAll, t); }
  const three = (f) => ({ actual: f('spend'), appts: f('appts'), bookings: f('bookings') });
  const cmpCh = (chId) => (vs === 'py' ? (!ins.pyRange ? null : chId == null ? add({ ...pyAll }, pyUn) : pyCh.get(chId)) : three((k) => (vs === 'plan' ? chPlan : chBudget)(chId, k)));
  // Projections are held by channel, so a Level 1's projection is its budget scaled by how far its channel has moved from budget.
  const cmpL1 = (l) => (vs === 'py' ? pyL1.get(l.id) : three((k) => { const b = l1B.get(l.id)?.[k] || 0, chB = chBudget(l.channel_id, k); return vs !== 'plan' ? b : chB > 0 ? b * (chPlan(l.channel_id, k) / chB) : 0; }));
  const mcOf = (x) => (x && x.actual > 0 && x.bookings > 0.5 ? x.actual / x.bookings : null);
  // Hovering over a figure shows what it is compared with.
  const vcell = (main, now, before, f, good, bf) => varCell(main, now, before, f, good, before == null ? '' : `${vsName} ${bf(before)}`);
  const blended = tot.actual ? tot.bookings / tot.actual : 0;
  const weak = (r) => !r.c.source.startsWith('gl_') && r.t.leads > 0 && r.t.actual > tot.actual * 0.01 && r.t.bookings / r.t.actual < blended * 0.5;
  const v = tot.budget ? tot.actual / tot.budget - 1 : 0;
  const all = add({ ...tot }, un);
  // Each KPI card carries a small trend of the metric across the chart's current intervals.
  const spark = (m) => {
    const idx = new Map(ins.series.buckets.map((k, i) => [k, i])), top = ins.series.buckets.map(() => 0), bottom = ins.series.buckets.map(() => 0);
    const rt = RATIO_OF[m];
    for (const r of ins.series.rows) { const i = idx.get(r.bucket); if (rt) { top[i] += r[rt[0]] || 0; bottom[i] += r[rt[1]] || 0; } else top[i] += r[m] || 0; }
    const vals = rt ? top.map((x, i) => (bottom[i] > 0.5 ? x / bottom[i] : 0)) : top, max = Math.max(...vals, 1e-9);
    if (vals.length < 2) return '';
    const pts = vals.map((x, i) => `${((i / (vals.length - 1)) * 100).toFixed(2)},${(30 - (Math.max(0, x) / max) * 26).toFixed(2)}`);
    return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="M0,32 L${pts.join(' L')} L100,32 Z"/><path class="line" d="M${pts.join(' L')}"/></svg>`;
  };
  const P = ins.py, now = { ...all, spend: tot.actual }, days = Math.round((toDate(state.dTo) - toDate(state.dFrom)) / 864e5) + 1;
  const rate = (t, m) => (t && t[RATIO_OF[m][1]] > 0.5 ? t[RATIO_OF[m][0]] / t[RATIO_OF[m][1]] : null), pts = (x) => (x * 100).toFixed(1) + ' pts', perDay = (n) => `${(n / days).toFixed(n / days < 10 ? 1 : 0)} per day`;
  const py = {
    spend: pyChips(tot.actual, P?.spend, { fmt: compact, neutral: true }), leads: pyChips(all.leads, P?.leads, { fmt: int }), appts: pyChips(all.appts, P?.appts, { fmt: int }),
    sales: pyChips(all.sales, P?.sales, { fmt: int }), bookings: pyChips(all.bookings, P?.bookings, { fmt: compact }),
    mcob: pyChips(rate(now, 'mcob'), rate(P, 'mcob'), { fmt: pts, goodWhenUp: false }), cpl: pyChips(rate(now, 'cpl'), rate(P, 'cpl'), { fmt: money, goodWhenUp: false }), cpa: pyChips(rate(now, 'cpa'), rate(P, 'cpa'), { fmt: money, goodWhenUp: false }),
    close: pyChips(rate(now, 'close'), rate(P, 'close'), { fmt: pts }), conv: pyChips(rate(now, 'conv'), rate(P, 'conv'), { fmt: pts }),
  };
  const tiles = [
    ['spend', compact(tot.actual), tot.budget ? `<span class="${v > 0 ? 'down' : 'up'}">${v > 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span> vs budget ${compact(tot.budget)}` : 'No budget loaded yet'],
    ['leads', int(all.leads), perDay(all.leads)],
    ['appts', int(all.appts), perDay(all.appts)],
    ['sales', int(all.sales), perDay(all.sales)],
    ['bookings', compact(all.bookings), `Average sale ${cost(all.bookings, all.sales)}`],
    // second row: the ratio that belongs under each card above
    ['mcob', ratio(tot.actual, all.bookings, pct), `Spend ÷ bookings · ROAS ${ratio(all.bookings, tot.actual, (x) => x.toFixed(1) + 'x')}`],
    ['cpl', cost(tot.actual, all.leads), 'Spend ÷ leads'],
    ['cpa', cost(tot.actual, all.appts), 'Spend ÷ appointments'],
    ['close', ratio(all.sales, all.appts, pct), 'Sales ÷ appointments'],
    ['conv', ratio(all.appts, all.leads, pct), 'Appointments ÷ leads'],
  ];
  // Leads take time to close, so the newest cohorts are still filling in.
  const young = Math.round((toDate(meta.dataThrough) - toDate(state.dTo)) / 864e5) < 120;
  const cohortNote = young ? `<p class="sub" style="margin:-6px 0 8px">Lead-cohort basis: leads created in the last few months are still closing, so Sales, Bookings $, closing rate and MCOB for this period will keep improving as they do. ${meta.pyCutoff ? `Prior-year figures are like for like: last year's leads are counted as they stood on ${niceDay(meta.pyCutoff)}, a year before the newest lead in the CRM extract (${niceDay(meta.crmAsOf)}).` : ''} The budget is for finished months, so recent periods look weaker against it than they will end up.</p>` : '';
  const wholeMonths = state.dFrom.endsWith('-01') && state.dTo === monthEnd(state.dTo.slice(0, 7));
  const rangeText = wholeMonths ? (state.dFrom.slice(0, 7) === state.dTo.slice(0, 7) ? bucketTitle.month(state.dFrom.slice(0, 7)) : `${bucketTitle.month(state.dFrom.slice(0, 7))} to ${bucketTitle.month(state.dTo.slice(0, 7))}`) : `${niceDay(state.dFrom)} to ${niceDay(state.dTo)}`;
  // Footnote: third-party campaign detail only exists from the day each platform feed was switched on.
  const starts = Object.entries(meta.feedStart || {}).sort((a, b) => a[1].localeCompare(b[1]));
  const feedNote = starts.length && state.dFrom <= starts.at(-1)[1]
    ? `<p class="sub" style="margin:12px 0 0">Note: ad-platform campaign detail begins when each feed was switched on (${starts.map(([p, d]) => `${PLATFORM_NAME[p] || p} ${niceDay(d)}`).join(', ')}) and cannot be backfilled. Before those dates, spend for those platforms comes from the ledger only and shows as "Other GL spend" with no campaign names, so for earlier periods campaign-level CPL, CPA and MCOB read lower than they really were. Level 1 and channel figures are unaffected.</p>` : '';
  const dayNote = wholeMonths && state.grain === 'month' ? '' : `<p class="sub" style="margin:8px 0 0">Note: ad-platform spend is shown on the day it ran, and CRM outcomes on the day their lead was created. Ledger-only spend has no meaningful day, so each month's amount is spread evenly across that month's days; part-month and weekly figures for it are estimates.</p>`;
  // Any heading sorts the table: channels, the Level 1s inside each channel and the campaigns inside each Level 1 all follow it.
  const byBrand = state.perfBy === 'brand';
  const PS = state.perfSort, pcols = [['name', byBrand ? 'Brand / Market location / Channel' : 'Channel / Level 1 / Campaign'], ['actual', 'Spend'], ['leads', 'Leads'], ['appts', 'Appts'], ['sales', 'Sales'], ['bookings', 'Bookings $'], ['mcob', 'MCOB'], ['cpl', 'CPL'], ['cpa', 'CPA'], ['close', 'Close %']];
  const head = '<tr>' + pcols.map(([k, n]) => `<th class="sortable" data-psort="${k}" title="${k === 'mcob' ? 'Marketing cost of bookings: spend as a share of bookings. ' : ''}Sort by ${n}">${n}${sortMark(PS, k)}</th>`).join('') + '<th class="l">Flag</th></tr>';
  const pget = { name: (x) => x.name.toLowerCase(), actual: (x) => x.t.actual, leads: (x) => x.t.leads, appts: (x) => x.t.appts, sales: (x) => x.t.sales, bookings: (x) => x.t.bookings,
    cpl: (x) => (x.t.actual > 0 && x.t.leads > 0 ? x.t.actual / x.t.leads : null), cpa: (x) => (x.t.actual > 0 && x.t.appts > 0 ? x.t.actual / x.t.appts : null), close: (x) => (x.t.appts > 0.5 ? x.t.sales / x.t.appts : null),
    mcob: (x) => mcOf(x.t) };
  const ptsF = (x) => (x * 100).toFixed(1) + ' pts';
  // Over budget on spend, or a higher MCOB, is unfavourable. Spend against last year is neither good nor bad on its own.
  const line = (cls, key, label, t, flag = '', c = null) => `<tr class="${cls}" ${key ? `data-key="${key}"` : ''}><td>${label}</td>
    ${vcell(money(t.actual), t.actual, c?.actual, compact, vs === 'py' ? 'flat' : 'down', money)}${vcell(int(t.leads), t.leads, c?.leads, int, 'up', int)}${vcell(int(t.appts), t.appts, c?.appts, int, 'up', int)}${vcell(int(t.sales), t.sales, c?.sales, int, 'up', int)}${vcell(money(t.bookings), t.bookings, c?.bookings, compact, 'up', money)}
    ${vcell(t.actual > 0 ? ratio(t.actual, t.bookings, pct) : '—', mcOf(t), mcOf(c), ptsF, 'down', pct)}<td>${cost(t.actual, t.leads)}</td><td>${cost(t.actual, t.appts)}</td><td>${ratio(t.sales, t.appts, pct)}</td><td class="l">${flag}</td></tr>`;
  let body = '';
  const chRows = sortRows(meta.channels.map((c, ci) => { const inCh = rows.filter((r) => r.c.channel.id === c.id); return { c, ci, inCh, name: c.name, t: inCh.reduce((t, r) => add(t, r.t), zero()) }; }).filter((x) => x.inCh.length), PS, pget);
  chRows.forEach(({ c, ci, inCh, t: chT }) => {
    const chOpen = !state.open.has('c' + c.id); // channels start expanded
    body += line('ch', 'c' + c.id, `${chOpen ? '▾' : '▸'} <i class="dot" style="background:${COLORS[ci]}"></i>${esc(c.name)}`, chT, '', cmpCh(c.id));
    if (!chOpen) return;
    const l1Rows = sortRows(meta.level1.filter((x) => x.channel_id === c.id).map((l) => { const inL = inCh.filter((r) => r.c.level1.id === l.id); return { l, inL, name: l.name, t: inL.reduce((t, r) => add(t, r.t), zero()) }; }).filter((x) => x.inL.length), PS, pget);
    for (const { l, inL, t: lT } of l1Rows) {
      const lOpen = state.open.has('l' + l.id), nWeak = inL.filter(weak).length;
      body += line('l1', 'l' + l.id, `${lOpen ? '▾' : '▸'} ${esc(l.name)} <span class="muted">(${inL.length})</span>`, lT, nWeak && !lOpen ? `<span class="chip warn">⚠ ${nWeak} low return</span>` : '', cmpL1(l));
      if (lOpen) for (const r of sortRows(inL.sort((a, b) => b.t.actual - a.t.actual), PS, { ...pget, name: (x) => x.c.name.toLowerCase() })) {
        // A campaign fed by linked ad-platform campaigns opens to show them: the lowest level of third-party detail.
        const srcKey = r.c.sources ? 's' + r.c.id : '', srcOpen = srcKey && state.open.has(srcKey);
        body += line('cp', srcKey, (srcKey ? (srcOpen ? '▾ ' : '▸ ') : '') + esc(r.c.name) + (state.brand ? '' : ` <span class="muted">· ${brandCode(r.c.brand_id)}</span>`) + (r.c.sources ? ` <span class="chip">${r.c.sources} spend source${r.c.sources > 1 ? 's' : ''}</span>` : ''), r.t, weak(r) ? '<span class="chip warn">⚠ Low return</span> <a href="#projections">Reallocate</a>' : '', vs === 'py' ? pyT.get(r.c.id) : null);
        if (srcOpen) {
          const srcs = r.c.sourceList.map((s) => ({ s, spend: s.t.actual })).sort((a, b) => b.spend - a.spend), linked = srcs.reduce((a, x) => a + x.spend, 0);
          for (const x of srcs) body += `<tr class="src"><td>${esc(x.s.name)} <span class="chip">${PLATFORM_NAME[x.s.source] || esc(x.s.source)}</span></td><td>${money(x.spend)}</td><td colspan="9" class="l muted">${x.spend ? `${pct(linked ? x.spend / linked : 0)} of this campaign's platform spend` : 'No spend in this period'} · ${esc(x.s.level1.name)}</td></tr>`;
          if (Math.abs(r.t.actual - linked) > 1) body += `<tr class="src"><td class="muted">Spend recorded on the CRM campaign itself</td><td>${money(r.t.actual - linked)}</td><td colspan="9"></td></tr>`;
        }
      }
    }
  });
  if (un.leads) body += line('l1', '', 'Not mapped to a campaign', un, '<a href="#mappings">Map names</a>', vs === 'py' && ins.pyRange ? pyUn : null);
  body += line('total', '', 'Total', add({ ...tot }, un), '', cmpCh());
  // The same table turned round: brands, their market locations, and the channels in each.
  const tree = (() => {
    if (!byBrand || !ins.cmp) return null;
    const C = ins.cmp, N = placeNames(), leaves = new Map(), leaf = (lo, ch) => { const k = `${lo}|${ch}`; return leaves.get(k) || leaves.set(k, { lo, ch, t: zero(), py: zero(), b: null, p: null }).get(k); };
    const put = (t, r) => { t.actual += r.spend; t.leads += r.leads; t.appts += r.appts; t.sales += r.sales; t.bookings += r.bookings; };
    for (const r of C.rows) put(leaf(r.lo, r.ch).t, r);
    for (const r of C.py || []) put(leaf(r.lo, r.ch).py, r);
    for (const p of C.plan) Object.assign(leaf(p.lo, p.ch), { b: p.budget, p: p.plan });
    const sumT = (ls, f) => ls.reduce((t, x) => add(t, f(x)), zero());
    const cmpOf = (ls) => (vs === 'py' ? (C.py ? sumT(ls, (x) => x.py) : null) : three((k) => ls.reduce((a, x) => a + ((vs === 'plan' ? x.p : x.b)?.[k] || 0), 0)));
    const nodes = (ls, f, name, kids) => sortRows(groupBy(ls, f).map(([id, xs]) => ({ id, name: name(id), t: sumT(xs, (x) => x.t), cmp: cmpOf(xs), kids: kids ? kids(xs) : null }))
      .filter((n) => Math.abs(n.t.actual) > 0.005 || n.t.leads || n.t.appts || n.t.sales || Math.abs(n.t.bookings) > 0.005).sort((a, b) => b.t.actual - a.t.actual), PS, pget);
    const all = [...leaves.values()];
    return { total: { t: sumT(all, (x) => x.t), cmp: cmpOf(all) },
      brands: nodes(all, (x) => N.brandOf.get(x.lo), brandName, (xs) => nodes(xs, (x) => x.lo, (id) => N.loc.get(id) || 'No market location', (ys) => nodes(ys, (x) => x.ch, (id) => N.ch.get(id) || 'Not mapped to a campaign'))) };
  })();
  if (tree) {
    body = '';
    for (const B of tree.brands) {
      const open = tree.brands.length === 1 ? !state.open.has('B' + B.id) : state.open.has('B' + B.id);
      body += line('ch', 'B' + B.id, `${open ? '▾' : '▸'} ${esc(B.name)} <span class="muted">(${B.kids.length})</span>`, B.t, '', B.cmp);
      if (open) for (const L of B.kids) {
        const lOpen = state.open.has('M' + L.id);
        body += line('l1', 'M' + L.id, `${lOpen ? '▾' : '▸'} ${esc(L.name)}`, L.t, '', L.cmp);
        if (lOpen) for (const X of L.kids) body += line('cp', '', `<i class="dot" style="background:${COLORS[meta.channels.findIndex((c) => c.id === X.id)] || COLORS[8]}"></i>${esc(X.name)}`, X.t, '', X.cmp);
      }
    }
    body += line('total', '', 'Total', tree.total.t, '', tree.total.cmp);
  }

  // The export carries every channel, Level 1 and campaign row, whatever is expanded on screen, as plain numbers.
  const exportTable = () => {
    const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : ''), div = (a, b) => (b > 0.5 ? a / b : NaN);
    // each of the six compared figures is followed by what it is compared with, the variance and the variance %
    const M6 = [[`Spend (${state.cur})`, (x) => x.actual], ['Leads', (x) => x.leads], ['Appointments', (x) => x.appts], ['Sales', (x) => x.sales], [`Bookings (${state.cur})`, (x) => x.bookings], ['MCOB %', (x) => { const m = mcOf(x); return m == null ? null : m * 100; }]];
    const out = [['Row', 'Channel', 'Level 1', 'Campaign', 'Brand', ...M6.flatMap(([n]) => [n, `${n}: ${vsName}`, `${n}: variance`, `${n}: variance %`]), 'CPL', 'CPA', 'Closing rate %']];
    const figs = (t, cmp) => [...M6.flatMap(([, f]) => { const a = f(t), b = cmp ? f(cmp) : null, ok = a != null && b != null && Math.abs(b) > 1e-9; return [r2(a), ok ? r2(b) : '', ok ? r2(a - b) : '', ok ? r2((a / Math.abs(b) - Math.sign(b)) * 100) : '']; }),
      r2(t.actual > 0 ? div(t.actual, t.leads) : NaN), r2(t.actual > 0 ? div(t.actual, t.appts) : NaN), r2(div(t.sales, t.appts) * 100)];
    const put = (kind, chName, l1Name, camp, brand, t, cmp) => out.push([kind, chName, l1Name, camp, brand, ...figs(t, cmp)]);
    if (tree) {
      out[0].splice(0, 5, 'Row', 'Brand', 'Market location', 'Channel');
      for (const B of tree.brands) { out.push(['Brand', B.name, '', '', ...figs(B.t, B.cmp)]); for (const L of B.kids) { out.push(['Market location', B.name, L.name, '', ...figs(L.t, L.cmp)]); for (const X of L.kids) out.push(['Channel', B.name, L.name, X.name, ...figs(X.t, X.cmp)]); } }
      out.push(['Total', '', '', '', ...figs(tree.total.t, tree.total.cmp)]);
    } else {
    for (const c of meta.channels) {
      const inCh = rows.filter((r) => r.c.channel.id === c.id); if (!inCh.length) continue;
      put('Channel', c.name, '', '', '', inCh.reduce((t, r) => add(t, r.t), zero()), cmpCh(c.id));
      for (const l of meta.level1.filter((x) => x.channel_id === c.id)) {
        const inL = inCh.filter((r) => r.c.level1.id === l.id); if (!inL.length) continue;
        put('Level 1', c.name, l.name, '', '', inL.reduce((t, r) => add(t, r.t), zero()), cmpL1(l));
        for (const r of inL.sort((a, b) => b.t.actual - a.t.actual)) put('Campaign', c.name, l.name, r.c.name, meta.brands.find((b) => b.id === r.c.brand_id)?.name || '', r.t, vs === 'py' ? pyT.get(r.c.id) : null);
      }
    }
    if (un.leads) put('Not mapped to a campaign', '', '', '', '', un, vs === 'py' && ins.pyRange ? pyUn : null);
    put('Total', '', '', '', '', add({ ...tot }, un), cmpCh());
    }
    const cell =(v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + out.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `maestro-performance-${tree ? 'by-brand-' : ''}${state.dFrom}-to-${state.dTo}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const through = meta.dataThrough, months = meta.months.filter((m) => m <= through.slice(0, 7));
  const monthOpts = (sel) => months.map((m) => `<option ${m === sel ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('');
  const off = meta.mode === 'real' ? meta.brands.filter((b) => !b.in_ledger && (!state.brand || String(b.id) === state.brand) && rows.some((r) => r.c.brand_id === b.id && r.t.actual)) : [];
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><h1>Marketing <span class="hl">Dashboard</span></h1><p class="sub" style="margin:0">Return on marketing spend, on a lead-cohort basis: appointments, sales and bookings count in the period their lead was created, under the lead-created campaign. Spend follows the campaign's connected source.</p></div>
      <div class="row">
        <label>Period by <div class="seg"><button data-mode="months" class="${state.dateMode === 'months' ? 'on' : ''}">Month</button><button data-mode="dates" class="${state.dateMode === 'dates' ? 'on' : ''}">Dates</button></div></label>
        ${state.dateMode === 'months'
          ? `<label>From <select id="from-m">${monthOpts(state.dFrom.slice(0, 7))}</select></label><label>To <select id="to-m">${monthOpts(state.dTo.slice(0, 7))}</select></label>`
          : `<label>From <input type="date" id="from-d" value="${state.dFrom}" min="${meta.months[0]}-01" max="${through}"></label><label>To <input type="date" id="to-d" value="${state.dTo}" min="${meta.months[0]}-01" max="${through}"></label>`}
        ${state.prevRange ? '<button id="full-range">Back to full period</button>' : ''}
      </div>
    </div>
    ${un.leads ? `<div class="banner">${int(un.leads)} leads and ${money(un.bookings)} of bookings in this period sit under CRM campaign names that are not mapped yet. <a href="#mappings">Review mappings</a></div>` : ''}
    ${feedSpend ? `<div class="banner" style="background:var(--wash);border-color:#cfe0f5">${compact(feedLinked)} of ${compact(feedSpend)} ad-platform spend (${pct(feedLinked / feedSpend)}) is linked to a CRM campaign, so those campaigns show their own CPL, CPA and MCOB. The rest meets its outcomes at Level 1 only. <a href="#mappings" id="go-links">Review spend links</a></div>` : ''}
    ${off.length ? `<div class="banner">${off.map((b) => esc(b.name)).join(', ')} ${off.length > 1 ? 'are' : 'is'} not in any loaded ledger. ${off.length > 1 ? 'Their' : 'Its'} spend here is ad-platform feeds only, so anything bought outside those platforms is missing.</div>` : ''}
    <div class="tiles k5">${tiles.map(([m, val, d]) => `<div class="tile kpi"><div class="kpi-top"><span class="k">${KPIS[m].name}<span class="help" title="${esc(KPIS[m].help)}">?</span></span><button class="zoom" data-zoom="${m}" title="Break ${KPIS[m].name} down by brand, market location, service offering and customer type"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Zoom</button></div><div class="v">${val}</div><div class="d">${d}</div>${py[m]}${spark(m)}</div>`).join('')}</div>
    ${cohortNote}
    ${ins.py ? `<p class="sub" style="margin:-6px 0 14px">VS. PY compares with ${niceDay(ins.pyFrom)} to ${niceDay(ins.pyTo)}${meta.pyCutoff ? `, counting only the appointments booked and sales closed by ${niceDay(meta.pyCutoff)} so both years are at the same stage` : ''}. Brands that joined part-way through that period have only part of it to compare against, and spend then came from the ledger alone.</p>` : ''}
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><h2>${state.chartMode === 'budget' ? `${CHART_MEASURES[state.measure]} by channel vs budget, by month · ${state.year}` : state.chartMode === 'py' ? `${CHART_MEASURES[state.measure]} by channel vs prior year, by ${state.grain}` : `${CHART_MEASURES[state.measure]} by channel, by ${state.grain}`}</h2><p class="sub" style="margin:0">${state.chartMode === 'budget' ? `All of ${state.year}` : rangeText}. ${state.chartMode === 'budget' ? 'One chart per channel: actuals in the channel\'s colour, the budget as loaded as the dashed line. The figures above each chart are for the closed months. Each chart has its own scale. Double-click a chart' : state.chartMode === 'py' ? 'One chart per channel: this year in the channel\'s colour, the same period last year as the dashed line. Each chart has its own scale. Double-click a chart' : RATIO_OF[state.measure] ? 'A ratio cannot be stacked, so each channel is a line and the heavy line is all channels together. Double-click a line' : state.grain === 'day' ? 'Days are drawn as a line per channel. Click a day to focus on it; double-click a line' : 'Click a bar to zoom into it; double-click a colour'}, or a channel in the legend, to open its Level 1 breakdown. A single click on a legend entry hides or shows it.</p></div>
      <div class="seg" aria-label="Chart type"><button data-cmode="channel" class="${state.chartMode === 'channel' ? 'on' : ''}">By channel</button><button data-cmode="py" class="${state.chartMode === 'py' ? 'on' : ''}" title="Each channel against the same period last year">Channel vs prior year</button><button data-cmode="budget" class="${state.chartMode === 'budget' ? 'on' : ''}" title="Each channel against its budget, month by month">Channel vs budget</button></div>
      </div>
      <div class="row chart-ctl"><div class="row"><span class="ctl-l">Stage</span><div class="seg pills" aria-label="Measure">${Object.entries(MEASURES).map(([k, n]) => `<button data-measure="${k}" class="${k === state.measure ? 'on' : ''}">${n}</button>`).join('')}</div>
        <span class="ctl-l" style="margin-left:10px">Ratio</span><div class="seg pills" aria-label="Ratio">${Object.entries(RATIO_NAMES).map(([k, n]) => `<button data-measure="${k}" class="${k === state.measure ? 'on' : ''}" title="${esc(KPIS[k].name)}">${n}</button>`).join('')}</div></div>
      <div class="row" ${state.chartMode === 'budget' ? 'style="visibility:hidden"' : ''}><span class="ctl-l">View by</span><div class="seg upper" aria-label="Chart interval">${Object.entries(GRAINS).map(([k, n]) => `<button data-grain="${k}" class="${k === state.grain ? 'on' : ''}">${n}</button>`).join('')}</div></div></div>
      <div class="legend">${meta.channels.map((c, i) => `<button class="lg${state.hiddenCh.has(c.id) ? ' off' : ''}" data-lg="${c.id}" aria-pressed="${!state.hiddenCh.has(c.id)}" title="Click to hide or show ${esc(c.name)}; double-click to break it down by Level 1"><i style="background:${COLORS[i]}"></i>${esc(c.name)}</button>`).join('')}${state.hiddenCh.size ? '<button class="lg" id="lg-all">Show all</button>' : ''}${state.chartMode === 'budget' ? '<span class="lg-py"><i></i>Budget</span>' : ins.pySeries && (state.grain !== 'day' || state.chartMode === 'py') ? '<span class="lg-py"><i></i>Same period last year</span>' : ''}</div>
      <div class="chart" id="chart"></div>${dayNote}
    </div>
    ${reconCard()}
    <div class="card"><div class="row" style="justify-content:space-between"><h2>${byBrand ? 'Brand and market location performance' : 'Channel and Level 1 performance'}</h2>
      <div class="row"><span class="ctl-l">Rows by</span><div class="seg upper"><button data-perfby="channel" class="${byBrand ? '' : 'on'}">Channel</button><button data-perfby="brand" class="${byBrand ? 'on' : ''}" title="Brands side by side, opening to market locations and their channels">Brand</button></div><span class="ctl-l" style="margin-left:10px">Variance vs</span><div class="seg upper">${[['budget', 'Budget'], ['plan', 'Projection'], ['py', 'Prior year']].map(([k, n]) => `<button data-vs="${k}" class="${vs === k ? 'on' : ''}">${n}</button>`).join('')}</div><button id="perf-export" title="Every channel, Level 1 and campaign row for this period, as a CSV file that opens in Excel">Export CSV</button></div></div>
      <p class="sub">${rangeText}. The small line under a figure is its variance to ${vs === 'py' ? `the same period last year (${niceDay(ins.pyFrom)} to ${niceDay(ins.pyTo)})` : `${vsName.toLowerCase()}`}, as an amount and a percentage; hover over it for the ${vsName.toLowerCase()} figure. ${vs === 'py' ? (ins.pyRange ? 'It goes down to campaign level.' : 'There is no prior-year data for this period.') : vs === 'plan' ? 'The projection is the current plan for these dates: hand-entered projections where they exist, otherwise the budget. It covers Spend, Appointments and Bookings $ (so MCOB too), by channel; Level 1 projections follow their channel.' : 'The budget as loaded covers Spend, Appointments and Bookings $ (so MCOB too), by channel and Level 1. There is no Leads or Sales budget.'} ${byBrand ? 'Each brand opens to its market locations, and each location to its channels; budgets and projections are held by market location and channel, so here they go all the way down. Spend that names no market location sits on the brand\'s main location. Select a row to expand, or a column heading to sort by it.' : `Level 1 spend for closed months equals the ledger: platform campaigns sit underneath at their own amounts, with "Other GL spend" and "Platform spend not yet in GL" lines making up the difference. Select a row to expand, or a column heading to sort by it. A campaign is flagged when its MCOB is more than double the blended ${blended ? pct(1 / blended) : '—'}.`}</p>
      <div class="scroll"><table>${head}${body}</table></div>${feedNote}</div>`;

  const chIndex = new Map(meta.channels.map((c, i) => [c.id, i]));
  const series = pivot(ins.series, state.measure, (id) => ch[id]?.name || 'Other', (id) => COLORS[chIndex.get(id) ?? 8]).sort((a, b) => chIndex.get(a.id) - chIndex.get(b.id)).filter((s) => !state.hiddenCh.has(s.id));
  const g = state.grain, reload = () => insights(el);
  const setRange = (a, b, keepPrev) => { if (!keepPrev) state.prevRange = null; state.dFrom = a; state.dTo = b > through ? through : b; if (state.dFrom > state.dTo) state.dFrom = state.dTo; reload(); };
  // Prior-year totals for the same intervals, drawn as a dashed line. Days are lines per channel, so no total is overlaid there.
  const isRatio = !!RATIO_OF[state.measure], visible = (id) => !state.hiddenCh.has(id);
  const pyLine = ins.pySeries && g !== 'day' ? (() => { const vals = seriesTotal(ins.pySeries, state.measure, visible); return ins.series.buckets.map((_, i) => (i < vals.length ? vals[i] : null)); })() : null;
  // A ratio is drawn as a line per channel, with all channels together as the heavy line.
  if (isRatio) series.push({ id: 'all', name: 'All channels', color: 'var(--ink)', bold: true, values: seriesTotal(ins.series, state.measure, visible) });
  stackedChart($('#chart'), {
    buckets: ins.series.buckets, series, fmt: mfmt(state.measure), noTotal: isRatio,
    line: g === 'day' || isRatio, compare: pyLine, compareName: isRatio ? 'All channels, same period last year' : 'Same period last year',
    label: bucketLabel[g], title: bucketTitle[g], hint: g === 'day' ? 'Click to focus this day · double-click a colour to break it down' : 'Click to zoom in · double-click a colour to break it down',
    // Zooming remembers where you came from, and steps the interval down so there is something to see.
    onBucket: (k) => { state.prevRange ||= { from: state.dFrom, to: state.dTo, grain: state.grain }; const [a, b] = bucketSpan[g](k); if (g !== 'day') state.grain = 'day'; setRange(a < meta.months[0] + '-01' ? meta.months[0] + '-01' : a, b, true); },
    onSeries: (id) => id !== 'all' && openDrill([{ group: 'level1', id, name: ch[id]?.name }]),
  });
  // The budget view replaces the channel chart: the whole of the selected year, month by month.
  if (state.chartMode === 'budget') budgetCharts($('#chart'));
  if (state.chartMode === 'py') pyCharts($('#chart'), el);
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
  $('#perf-export', el).onclick = exportTable;
  $$('[data-perfby]', el).forEach((b) => (b.onclick = () => { state.perfBy = b.dataset.perfby; drawInsights(el); }));
  $$('[data-psort]', el).forEach((th) => (th.onclick = () => { state.perfSort = nextSort(state.perfSort, th.dataset.psort, true); drawInsights(el); }));
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
    const DM = RATIO_OF[state.measure] ? 'spend' : state.measure; // the breakdown stacks, so a ratio falls back to spend
    const all = pivot(data, DM, nameOf, () => '').sort((a, b) => b.total[DM] - a.total[DM]);
    const top = all.slice(0, 8).map((s, i) => ({ ...s, color: COLORS[i] })), rest = all.slice(8);
    const chart = rest.length ? [...top, { id: 'other', name: `Other (${rest.length})`, color: COLORS[8], values: data.buckets.map((_, i) => rest.reduce((a, s) => a + s.values[i], 0)) }] : top;
    const colour = new Map(top.map((s) => [s.id, s.color])), fmt = mfmt(DM);
    const T = all.reduce((t, s) => { for (const k in t) t[k] += s.total[k]; return t; }, { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 });
    const row = (s, cls = '') => `<tr class="${cls}" ${cls || byCampaign ? '' : `data-drill="${s.id}" title="Double-click to see its campaigns"`}><td><i class="dot" style="background:${colour.get(s.id) || COLORS[8]}"></i>${esc(s.name)}</td><td>${money(s.total.spend)}</td><td>${int(s.total.leads)}</td><td>${int(s.total.appts)}</td><td>${int(s.total.sales)}</td><td>${money(s.total.bookings)}</td><td>${cost(s.total.spend, s.total.leads)}</td><td>${cost(s.total.spend, s.total.appts)}</td><td>${ratio(s.total.bookings, s.total.spend, (x) => x.toFixed(1) + 'x')}</td></tr>`;
    dlg.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><p class="sub" style="margin:0">${path.map((p, i) => (i < path.length - 1 ? `<button class="link" data-crumb="${i}">${esc(p.name)}</button> › ` : `<b>${esc(p.name)}</b>`)).join('')}</p>
          <h2 style="margin-top:4px">${MEASURES[DM]} by ${byCampaign ? 'campaign' : 'Level 1'}, by ${state.grain}</h2>
          <p class="sub" style="margin:0">${niceDay(state.dFrom)} to ${niceDay(state.dTo)}. ${byCampaign ? 'This is the lowest level of detail. Linked ad-platform spend sits on its CRM campaign.' : 'Double-click a colour, a legend entry or a table row to see its campaigns.'}</p></div>
        <div class="row"><div class="seg">${Object.entries(MEASURES).map(([k, n]) => `<button data-dmeasure="${k}" class="${k === DM ? 'on' : ''}">${n}</button>`).join('')}</div><button id="d-close" aria-label="Close">Close ✕</button></div>
      </div>
      <div class="legend">${chart.map((s) => `<button class="lg" ${s.id === 'other' || byCampaign ? 'disabled' : `data-drill="${s.id}"`}><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join('')}</div>
      <div class="chart" id="d-chart"></div>
      <div class="scroll" style="max-height:38vh;overflow-y:auto;margin-top:12px"><table><tr><th>${byCampaign ? 'Campaign' : 'Level 1'}</th><th>Spend</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th>CPL</th><th>CPA</th><th>ROAS</th></tr>
        ${all.map((s) => row(s)).join('') || '<tr><td class="l muted" colspan="9">Nothing in this period.</td></tr>'}${all.length > 1 ? row({ id: 't', name: 'Total', total: T }, 'total') : ''}</table></div>`;
    stackedChart($('#d-chart', dlg), { buckets: data.buckets, series: chart, fmt, line: state.grain === 'day', label: bucketLabel[state.grain], title: bucketTitle[state.grain], hint: byCampaign ? '' : 'Double-click a colour to see its campaigns',
      onSeries: byCampaign ? null : (id) => id !== 'other' && openDrill([...path, { group: 'campaign', id, name: l1[id] }]) });
    $('#d-close', dlg).onclick = () => dlg.close();
    $$('[data-dmeasure]', dlg).forEach((b) => (b.onclick = () => { state.measure = b.dataset.dmeasure; draw(); if (location.hash.slice(1) === 'dashboard' || !location.hash) drawInsights($('#view')); }));
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
  appts: { name: 'Appointments', help: 'Leads created in the period that are qualified and went on to book an appointment. Counted on the lead date (lead-cohort basis), whenever the appointment was booked.', fmt: int, of: (r) => r.appts, records: true, additive: true, crm: true },
  sales: { name: 'Sales', help: 'Leads created in the period that went on to be sold or completed. Counted on the lead date (lead-cohort basis), whenever the sale closed. Additional projects on the same sale are not counted. Recent periods keep rising as their leads close.', fmt: int, of: (r) => r.sales, records: true, additive: true, crm: true },
  bookings: { name: 'Bookings $', help: 'Final contract value of every sold or completed project from leads created in the period, including additional projects. Counted on the lead date (lead-cohort basis), whenever the sale closed. Recent periods keep rising as their leads close.', fmt: (v) => money(v), of: (r) => r.bookings, records: true, additive: true, crm: true },
  mcob: { name: 'MCOB', help: 'Marketing cost of bookings: spend in the period as a share of the Bookings $ from leads created in it. Lower is better. Recent periods read high until their leads have closed. ROAS is the same relationship the other way round.', fmt: (v) => (v == null ? '—' : pct(v)), of: (r) => ratioOf(r, 'mcob'), records: false, additive: false, crm: false, lowGood: true },
  cpl: { name: 'Cost per lead', help: 'Spend divided by new leads created in the period. Lower is better.', fmt: (v) => (v == null ? '—' : money(v)), of: (r) => ratioOf(r, 'cpl'), records: false, additive: false, crm: false, lowGood: true },
  cpa: { name: 'Cost per appointment', help: 'Spend divided by the appointments from leads created in the period. Lower is better.', fmt: (v) => (v == null ? '—' : money(v)), of: (r) => ratioOf(r, 'cpa'), records: false, additive: false, crm: false, lowGood: true },
  close: { name: 'Closing rate', help: 'Sales as a share of appointments, both from the leads created in the period. Recent periods read low until their leads have closed.', fmt: (v) => (v == null ? '—' : pct(v)), of: (r) => ratioOf(r, 'close'), records: false, additive: false, crm: true },
  conv: { name: 'Conversion rate', help: 'The share of leads created in the period that went on to book an appointment.', fmt: (v) => (v == null ? '—' : pct(v)), of: (r) => ratioOf(r, 'conv'), records: false, additive: false, crm: true },
};
// The ratio cards: what is divided by what.
const RATIO_OF = { mcob: ['spend', 'bookings'], cpl: ['spend', 'leads'], cpa: ['spend', 'appts'], close: ['sales', 'appts'], conv: ['appts', 'leads'] };
const ratioOf = (r, m) => (r[RATIO_OF[m][0]] != null && r[RATIO_OF[m][1]] > 0.5 ? r[RATIO_OF[m][0]] / r[RATIO_OF[m][1]] : null);
const ZOOM_FILTERS = { brand: 'Brand', location: 'Market location', service: 'Service offering', ctype: 'Customer type' };
let zoom = null;
function openZoom(measure) {
  zoom = { measure, tab: KPIS[measure].crm ? 'overview' : 'brand', f: {}, view: 'breakdown', open: new Set(), cache: {}, sortO: { k: 'v', dir: -1 }, sortB: { k: 'v', dir: -1 } };
  drawZoom();
}
// The Zoom window, laid out like the BI portal's: an Overview with service offering and customer type side by side,
// and a "By Brand & Market" tab where a brand opens to its market locations. Every figure carries its change on last year.
async function drawZoom() {
  let dlg = $('#drill');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'drill'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
  if (!dlg.open) { dlg.innerHTML = '<p class="sub" style="margin:0">Loading…</p>'; dlg.showModal(); }
  const k = KPIS[zoom.measure], f = zoom.f;
  const fqOf = (skip) => Object.entries(f).filter(([d]) => d !== skip).map(([d, v]) => `&f_${d}=${encodeURIComponent(v.key)}`).join('');
  const hasPy = yearBack(state.dFrom) >= meta.months[0] + '-01', pyRange = `${scope()}&from=${yearBack(state.dFrom)}&to=${yearBack(state.dTo)}&asof=1`;
  const get = (dim, py, skip) => { const u = `/api/zoom?${py ? pyRange : rangeQuery()}&dim=${dim}${fqOf(skip)}`; return (zoom.cache[u] ||= api(u)); };
  const brandName = (id) => meta.brands.find((b) => b.id === id)?.name, locName = (id) => meta.locations.find((l) => l.id === id)?.name;
  const nBrands = meta.brands.filter((b) => (!state.region || b.region === state.region) && (!state.division || b.division === state.division)).length;
  const scopeText = [state.brand ? brandName(Number(state.brand)) : `All ${nBrands} brands`, !state.brand && (state.region || state.division), state.location && locName(Number(state.location))].filter(Boolean).map(esc).join(' · ');
  const chips = Object.entries(f).map(([d, v]) => `<button class="chip fchip" data-unf="${d}" title="Remove this filter">${ZOOM_FILTERS[d]}: ${esc(v.label)} ✕</button>`).join(' ');
  const recUrl = `/api/records?${rangeQuery()}&measure=${zoom.measure}${fqOf()}`;
  const head = `
    <div class="zhead">
      <div><h2 class="ztitle">${k.name}</h2><p class="zmeta">${niceDay(state.dFrom)} – ${niceDay(state.dTo)} · ${scopeText}</p><p class="zdef">${esc(k.help)}</p></div>
      <div class="row" style="flex-wrap:nowrap">${k.records ? `${zoom.view === 'records' ? '' : `<button id="z-rec">View ${zoom.measure === 'spend' ? 'ledger lines' : 'records'}</button>`}<a class="btn" href="${recUrl}&format=csv&cur=${state.cur}" download>Export CSV</a>` : ''}<button id="d-close" class="zx" aria-label="Close">✕</button></div>
    </div>
    ${chips ? `<p style="margin:12px 0 0"><span class="zcap" style="margin-right:8px">Filtered to</span>${chips}</p>` : ''}`;
  const wire = () => {
    $('#d-close', dlg).onclick = () => dlg.close();
    if ($('#z-rec', dlg)) $('#z-rec', dlg).onclick = () => { zoom.view = 'records'; drawZoom(); };
    $$('[data-unf]', dlg).forEach((b) => (b.onclick = () => { delete zoom.f[b.dataset.unf]; drawZoom(); }));
    $$('[data-ztab]', dlg).forEach((b) => (b.onclick = () => { zoom.tab = b.dataset.ztab; zoom.view = 'breakdown'; drawZoom(); }));
    $$('[data-zsort]', dlg).forEach((th) => (th.onclick = () => { const [w, key] = th.dataset.zsort.split(':'); zoom[w] = nextSort(zoom[w], key); drawZoom(); }));
  };
  const fail = (e) => { dlg.innerHTML = head + `<p>${esc(e.message)}</p>`; wire(); };

  if (zoom.view === 'records') {
    let d; try { d = await api(recUrl); } catch (e) { return fail(e); }
    const isMoney = (c) => /Amount|Contract/.test(c);
    dlg.innerHTML = head + `
      <p class="sub" style="margin:14px 0 0"><button class="link" id="z-back">‹ Back to the breakdown</button> · ${d.count.toLocaleString()} ${zoom.measure === 'spend' ? 'ledger lines' : 'records'}${d.count > d.shown ? `, showing the first ${d.shown.toLocaleString()}` : ''} · total ${money(d.total)}</p>
      ${zoom.measure === 'spend' ? '<p class="sub" style="margin:6px 0 0">These are the ledger lines for the months in the period, which is the official spend. Ad-platform campaign detail is in the chart drill-down. Brands or months with no ledger loaded have no lines here.</p>' : ''}
      <div class="scroll" style="max-height:56vh;overflow-y:auto;margin-top:10px"><table><tr>${d.cols.map((c) => `<th class="${isMoney(c) ? '' : 'l'}">${esc(c)}</th>`).join('')}</tr>
        ${d.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${isMoney(d.cols[i]) ? '' : /description/i.test(d.cols[i]) ? 'l wrap' : 'l'}" ${/description/i.test(d.cols[i]) ? 'style="min-width:260px"' : ''}>${v == null || v === '' ? '—' : isMoney(d.cols[i]) ? money(v) : esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td class="l muted" colspan="${d.cols.length}">No records for this selection.</td></tr>`}</table></div>`;
    wire(); $('#z-back', dlg).onclick = () => { zoom.view = 'breakdown'; drawZoom(); };
    return;
  }

  // ---- shared pieces
  const FIELDS = ['spend', 'leads', 'appts', 'sales', 'bookings'];
  const live = (r) => FIELDS.some((x) => r[x]);
  const sumOf = (rows, noSpend) => { const t = rows.reduce((a, r) => { for (const x of FIELDS) a[x] += r[x] || 0; return a; }, { spend: 0, leads: 0, appts: 0, sales: 0, bookings: 0 }); if (noSpend) t.spend = null; return t; };
  const vsPy = (now, before) => {
    if (!hasPy || now == null || before == null || !(Math.abs(before) > 1e-9)) return '<span class="muted">—</span>';
    const d = now / before - 1, up = d >= 0;
    return `<span class="zpy ${zoom.measure === 'spend' ? 'flat' : up !== !!k.lowGood ? 'up' : 'down'}">${up ? '▲ +' : '▼ −'}${(Math.abs(d) * 100).toFixed(1)}%</span>`;
  };
  const val = (v) => (v == null ? '—' : k.fmt(v));
  const zth = (which, key, label, attrs = '') => `<th class="sortable" data-zsort="${which}:${key}" ${attrs}>${label}${sortMark(zoom[which], key)}</th>`;
  const banner = (label, now, before) => `<div class="zbanner"><span>${label}</span><span><b>${val(now)}</b>${hasPy ? `${vsPy(now, before)} <small>vs PY</small>` : ''}</span></div>`;
  const tabs = (overviewOff) => `<div class="ztabs" role="tablist"><button data-ztab="overview" class="${zoom.tab === 'overview' ? 'on' : ''}" ${overviewOff ? `disabled title="${esc(overviewOff)}"` : ''}>Overview</button><button data-ztab="brand" class="${zoom.tab === 'brand' ? 'on' : ''}">By Brand &amp; Market</button></div>`;
  const noOverview = !k.crm ? 'Service offering and customer type are recorded on CRM records only, so they are not available for spend-based measures' : zoom.noRecords ? 'Needs CRM records, which the demo data does not have' : '';

  // ---- Overview: service offering and customer type side by side
  if (zoom.tab === 'overview' && !noOverview) {
    let D; try { D = await Promise.all([get('service', false, 'service'), get('ctype', false, 'ctype'), hasPy ? get('service', true, 'service') : null, hasPy ? get('ctype', true, 'ctype') : null]); } catch (e) { return fail(e); }
    if (!D[0].hasRecords) { zoom.noRecords = true; zoom.tab = 'brand'; return drawZoom(); }
    const panel = (dim, title, d, p) => {
      const before = new Map((p?.rows || []).map((r) => [r.key ?? '', k.of(r)]));
      const rows = sortRows(d.rows.filter(live).map((r) => ({ ...r, key: r.key ?? '', v: k.of(r) })).filter((r) => r.v), zoom.sortO, { name: (r) => (r.key || '~').toLowerCase(), v: (r) => r.v, py: (r) => changeOn(r.v, before.get(r.key)) });
      const sel = f[dim]?.key, picked = sel != null ? rows.filter((r) => r.key === sel) : rows;
      const total = k.of(sumOf(picked, true)), totalPy = p ? k.of(sumOf(sel != null ? p.rows.filter((r) => (r.key ?? '') === sel) : p.rows, true)) : null;
      return `<div><p class="zcap">By ${title}</p>${banner(sel != null ? esc(f[dim].label) : 'Total', total, totalPy)}
        <div class="scroll" style="max-height:48vh;overflow-y:auto;margin-top:6px"><table class="ztable"><tr>${zth('sortO', 'name', 'Name')}${zth('sortO', 'v', 'Actual')}${hasPy ? zth('sortO', 'py', 'vs PY') : ''}</tr>
        ${rows.map((r) => `<tr class="${r.key ? 'zrow' : ''} ${sel == null ? '' : r.key === sel ? 'sel' : 'dim'}" ${r.key ? `data-zpick="${dim}" data-key="${esc(r.key)}" title="${r.key === sel ? 'Remove this filter' : `Filter everything to ${esc(r.key)}`}"` : ''}><td>${esc(r.key || '(Unspecified)')}</td><td>${val(r.v)}</td>${hasPy ? `<td>${vsPy(r.v, before.get(r.key))}</td>` : ''}</tr>`).join('') || '<tr><td class="muted" colspan="3">Nothing in this period.</td></tr>'}</table></div></div>`;
    };
    dlg.innerHTML = head + tabs() + `<div class="zgrid">${panel('service', 'service offering', D[0], D[2])}${panel('ctype', 'customer type', D[1], D[3])}</div>
      <p class="sub" style="margin:14px 0 0">Select a row to filter the whole window to it; select it again to clear. Select a column heading to sort. Service offering and customer type come from CRM records, so spend, CPA and MCOB are not available at this level.</p>`;
    wire();
    $$('[data-zpick]', dlg).forEach((tr) => (tr.onclick = () => { const d = tr.dataset.zpick, key = tr.dataset.key; if (f[d]?.key === key) delete f[d]; else f[d] = { key, label: key }; drawZoom(); }));
    return;
  }

  // ---- By Brand & Market: a brand opens to its market locations
  zoom.tab = 'brand';
  let B; try { B = await Promise.all([get('brand'), get('location'), hasPy ? get('brand', true) : null, hasPy ? get('location', true) : null]); } catch (e) { return fail(e); }
  const withSpend = B[0].hasSpend, blocked = !k.crm && !withSpend;
  const prep = (d) => d.rows.filter(live).map((r) => ({ ...r, v: k.of(r) })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
  const brands = prep(B[0]), locs = prep(B[1]), locBrand = new Map(meta.locations.map((l) => [l.id, l.brand_id]));
  const pyB = new Map((B[2]?.rows || []).map((r) => [r.key, k.of(r)])), pyL = new Map((B[3]?.rows || []).map((r) => [r.key, k.of(r)]));
  const zget = (py, nameOf) => ({ name: (r) => (nameOf(r.key) || '~').toLowerCase(), v: (r) => r.v, py: (r) => changeOn(r.v, py.get(r.key)), cpa: (r) => (r.spend > 0 && r.appts > 0 ? r.spend / r.appts : null), close: (r) => (r.appts > 0.5 ? r.sales / r.appts : null), mcob: (r) => (r.spend != null && r.bookings > 0.5 ? r.spend / r.bookings : null) });
  sortRows(brands, zoom.sortB, zget(pyB, brandName)); sortRows(locs, zoom.sortB, zget(pyL, locName));
  const T = sumOf(brands, !withSpend), totalV = k.of(T), totalPy = B[2] ? k.of(sumOf(B[2].rows, !withSpend)) : null;
  const one = brands.length === 1, canFilter = k.crm && B[0].hasRecords;
  const tds = (r, before) => `<td><b>${val(r.v)}</b></td>${hasPy ? `<td>${vsPy(r.v, before)}</td>` : ''}
    ${k.additive ? `<td class="l"><span class="bar"><i style="width:${totalV ? Math.max(1, Math.min(100, (Math.abs(r.v) / Math.abs(totalV)) * 100)) : 0}%"></i></span> <span class="muted">${totalV ? pct(r.v / totalV) : ''}</span></td>` : ''}
    ${withSpend ? `<td>${cost(r.spend, r.appts)}</td>` : ''}<td>${ratio(r.sales, r.appts, pct)}</td>${withSpend ? `<td>${ratio(r.spend, r.bookings, pct)}</td>` : ''}
    <td class="l">${canFilter ? `<button class="link" data-zf="${r.dim}:${r.key}" title="Service offering and customer type for ${esc(r.label)}">Overview ›</button>` : ''}</td>`;
  const body = brands.map((b) => {
    const open = one || zoom.open.has(b.key), mine = locs.filter((l) => locBrand.get(l.key) === b.key);
    return `<tr class="zrow" data-zopen="${b.key}"><td>${open ? '▾' : '▸'} ${esc(brandName(b.key) || 'Other')} <span class="muted">(${mine.length})</span></td>${tds({ ...b, dim: 'brand', label: brandName(b.key) }, pyB.get(b.key))}</tr>` +
      (open ? mine.map((l) => `<tr class="sub"><td>${esc(locName(l.key) || 'Other')}</td>${tds({ ...l, dim: 'location', label: locName(l.key) }, pyL.get(l.key))}</tr>`).join('') : '');
  }).join('');
  const nCols = 4 + (hasPy ? 1 : 0) + (k.additive ? 1 : 0) + (withSpend ? 2 : 0);
  dlg.innerHTML = head + tabs(noOverview) + (blocked ? '<p>This measure needs spend, which is not recorded by service offering or customer type. Remove that filter to see it.</p>' : `
    ${banner(`${brands.length === 1 ? esc(brandName(brands[0].key) || '') : `${brands.length} brands`} · total`, totalV, totalPy)}
    <div class="scroll" style="max-height:50vh;overflow-y:auto;margin-top:6px"><table class="ztable"><tr>${zth('sortB', 'name', 'Brand / market location')}${zth('sortB', 'v', 'Actual')}${hasPy ? zth('sortB', 'py', 'vs PY') : ''}${k.additive ? '<th class="l" style="width:18%">Share of total</th>' : ''}
      ${withSpend ? zth('sortB', 'cpa', 'CPA', 'title="Spend per appointment"') : ''}${zth('sortB', 'close', 'Closing rate', 'title="Sales as a share of appointments"')}${withSpend ? zth('sortB', 'mcob', 'MCOB', 'title="Marketing cost of bookings: spend as a share of bookings"') : ''}<th></th></tr>
      ${body || `<tr><td class="muted" colspan="${nCols}">Nothing in this period for this selection.</td></tr>`}</table></div>
    <p class="sub" style="margin:14px 0 0">Select a brand to open its market locations, or a column heading to sort by it.${canFilter ? ' "Overview ›" shows that brand or location by service offering and customer type.' : ''}${withSpend ? '' : ' Spend is not recorded by service offering or customer type, so CPA and MCOB are hidden while that filter is on.'}</p>`);
  wire();
  $$('[data-zopen]', dlg).forEach((tr) => (tr.onclick = () => { const id = Number(tr.dataset.zopen); zoom.open.has(id) ? zoom.open.delete(id) : zoom.open.add(id); drawZoom(); }));
  $$('[data-zf]', dlg).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const [d, id] = b.dataset.zf.split(':'), key = Number(id); if (d === 'location') delete f.brand; else delete f.location; f[d] = { key, label: (d === 'brand' ? brandName(key) : locName(key)) || '' }; zoom.tab = 'overview'; drawZoom(); }));
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
      <div><h1>Maestro <span class="hl">Budget Manager</span> · ${state.year}</h1><p class="sub" style="margin:0">Each open month starts at budget and is adjusted from there, by channel. The channel figure is then shared across the brand's CRM campaigns automatically, or you can set a campaign by hand.</p></div>
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
// Opens over the Budget Manager screen for the market location in view. The budget is never touched.
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

// ---- channel vs budget chart --------------------------------------------------
// One small chart per channel for the whole selected year, by month: actuals in the channel's colour and the budget as
// the dashed line. The budget is the budget as loaded and never changes. It exists for Spend, Appointments and
// Bookings $, so CPA and MCOB (which are made of those) have a budget too; the other stages and ratios do not.
function budgetCharts(host) {
  host._ro?.disconnect();
  const m = state.measure, rt = RATIO_OF[m], P = ins.plan, parts = rt || [m], fmt = mfmt(m);
  if (!P || !parts.every((k) => PROJ[k])) { host.innerHTML = '<p class="sub" style="padding:28px 0;margin:0">A budget is loaded for Spend, Appointments and Bookings $, which also gives CPA and MCOB. Pick one of those to compare with budget.</p>'; return; }
  const months = P.months, lastData = meta.dataThrough.slice(0, 7), shown = (id) => !state.hiddenCh.has(id), colorOf = new Map(meta.channels.map((c, i) => [c.id, COLORS[i]]));
  // a figure for one month, or for the closed months together, from the channels in a panel
  const fig = (chans, f, pick) => { const s = (k) => chans.reduce((a, c) => a + c.m[k][f].reduce((x, v, i) => x + (pick(i) ? v || 0 : 0), 0), 0); return rt ? (s(rt[1]) > 0.5 ? s(rt[0]) / s(rt[1]) : null) : s(m); };
  const panels = [{ id: 'all', name: 'All channels', color: 'var(--ink)', chans: P.channels.filter((c) => shown(c.id)) }, ...P.channels.filter((c) => shown(c.id)).map((c) => ({ id: c.id, name: c.name, color: colorOf.get(c.id) || COLORS[8], chans: [c] }))]
    .map((p) => ({ ...p, now: fig(p.chans, 'actual', (i) => closed(months[i])), plan: fig(p.chans, 'budget', (i) => closed(months[i])),
      values: months.map((mo, i) => (mo <= lastData ? fig(p.chans, 'actual', (j) => j === i) : null)), budget: months.map((_, i) => fig(p.chans, 'budget', (j) => j === i)) }))
    .filter((p) => p.now || p.plan || p.budget.some(Boolean));
  const chip = (p) => {
    if (p.now == null || !(Math.abs(p.plan || 0) > 1e-9)) return '<span class="muted">no budget</span>';
    const d = p.now / p.plan - 1, up = d >= 0, lowGood = m === 'spend' || !!KPIS[m]?.lowGood; // over budget on spend or cost is unfavourable
    return `<span class="zpy ${up !== lowGood ? 'up' : 'down'}">${up ? '▲ +' : '▼ −'}${(Math.abs(d) * 100).toFixed(1)}%</span>`;
  };
  const closedM = months.filter(closed), span = closedM.length ? `${mlabel(closedM[0])}–${mlabel(closedM.at(-1))}` : '';
  host.innerHTML = `<div class="pygrid">${panels.map((p, i) => `<div class="pyp"><div class="pyp-h"><span><i class="dot" style="background:${p.color}"></i><b>${esc(p.name)}</b></span>
    <span title="Closed months, ${span}">${p.now == null ? '—' : fmt(p.now)} <span class="muted">vs ${p.plan == null ? '—' : fmt(p.plan)}</span> ${chip(p)}</span></div><div class="chart" data-pyc="${i}"></div></div>`).join('') || '<p class="sub" style="padding:28px 0;margin:0">Nothing to show for this selection.</p>'}</div>`;
  panels.forEach((p, i) => stackedChart($(`[data-pyc="${i}"]`, host), {
    buckets: months, series: [{ id: p.id, name: 'Actual', color: p.color, values: p.values }], fmt, line: !!rt, noTotal: true, small: true,
    compare: p.budget.map((v) => v || null), compareName: 'Budget', label: bucketLabel.month, title: bucketTitle.month, hint: p.id === 'all' ? '' : 'Double-click to break it down by Level 1',
    onSeries: p.id === 'all' ? null : () => openDrill([{ group: 'level1', id: p.id, name: p.name }]),
  }));
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
    <h1>Maestro <span class="hl">Campaign Management</span></h1><p class="sub">New campaigns start here. A campaign is created in the CRM only after it is approved, so the name is the same everywhere. ${waiting ? `<b>${waiting} waiting for approval.</b>` : ''}</p>
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

const VIEWS = { dashboard: insights, insights: attentionView, projections, campaigns, mappings, import: imports };
async function render() {
  const name = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  drawTimeFrame();
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
