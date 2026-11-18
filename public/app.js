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
const PLATFORM_NAME = { google_ads: 'Google Ads', bing_ads: 'Bing Ads', meta_ads: 'Meta', active_prospect: 'Active Prospect' };
const ROLES = { marketer: 'Marketing manager (demo)', approver: 'Approver (demo)', finance: 'Finance (demo)' };

const saved = (() => { try { return localStorage.getItem('maestro-currency'); } catch { return null; } })();
const state = { grain: 'month', dateMode: 'months', dFrom: '', dTo: '', rangeYear: '', prevRange: null, division: '', region: '', hiddenCh: new Set(), year: '', cur: saved === 'CAD' ? 'CAD' : 'USD', brand: '', location: '', role: 'marketer', measure: 'spend', from: null, to: null, open: new Set(), mapTab: 'names', glMonth: null };
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
const GRAINS = { month: 'Months', week: 'Weeks', day: 'Days' };
// How a bucket key reads on the axis and in a tooltip, and the dates it covers.
const bucketLabel = { month: (k) => mlabel(k), week: (k) => niceDay(k, false), day: (k) => niceDay(k, false) };
const bucketTitle = { month: (k) => `${mlabel(k)} ${k.slice(0, 4)}`, week: (k) => `Week of ${niceDay(k)}`, day: (k) => toDate(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) };
const bucketSpan = { month: (k) => [monthStart(k), monthEnd(k)], week: (k) => [k, addDays(k, 6)], day: (k) => [k, k] };

// ---- chart -----------------------------------------------------------------
// Stacked bars drawn at the real pixel width of their container and redrawn when that changes.
// A click on a bar and a double-click on a colour are told apart by a short delay.
function stackedChart(host, opts) {
  const { buckets, series, markers, fmt, label, title, onBucket, onSeries, hint } = opts;
  const W = Math.max(300, Math.round(host.clientWidth || 960)), H = Math.round(Math.min(400, Math.max(210, W * 0.3)));
  const L = W < 520 ? 44 : 56, R = 12, T = 12, B = 30, pw = W - L - R, ph = H - T - B;
  const totals = buckets.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i]), 0));
  const max = Math.max(1, ...totals, ...(markers || []));
  const step = (() => { const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  const top = Math.ceil(max / step) * step, y = (v) => T + ph - (v / top) * ph, bw = pw / Math.max(1, buckets.length), w = Math.max(1, Math.min(72, bw * (bw < 6 ? 0.85 : 0.62)));
  const every = Math.max(1, Math.ceil(46 / bw)), gap = w >= 6 ? 2 : 0, stacks = [];
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? 'var(--grid)' : 'var(--axis)'}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  svg += `<rect class="hov" x="0" y="${T}" width="${bw}" height="${ph}" fill="var(--ink)" opacity="0" pointer-events="none"/>`;
  buckets.forEach((b, i) => {
    const x = L + bw * i + (bw - w) / 2, live = series.filter((s) => s.values[i] > 0), segs = [];
    let base = 0;
    live.forEach((s, k) => {
      const v = s.values[i], h = Math.max(0, y(base) - y(base + v) - (k < live.length - 1 ? gap : 0)), r = k === live.length - 1 ? Math.min(4, h, w / 2) : 0, yt = y(base) - h;
      svg += `<path d="M${x},${yt + h}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yt + h}Z" fill="${s.color}"/>`;
      segs.push({ id: s.id, y0: yt, y1: yt + h + gap });
      base += v;
    });
    stacks.push(segs);
    if (markers && markers[i] > 0) svg += `<line x1="${x - 5}" x2="${x + w + 5}" y1="${y(markers[i])}" y2="${y(markers[i])}" stroke="var(--ink)" stroke-width="2"/>`;
    if (i % every === 0) svg += `<text x="${L + bw * i + bw / 2}" y="${H - 10}" text-anchor="middle">${bw < 34 && every === 1 ? label(b)[0] : label(b)}</text>`;
    svg += `<rect data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}" fill="transparent" style="cursor:${onBucket || onSeries ? 'pointer' : 'default'}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bars over time">${svg}</svg><div class="tip"></div>`;
  const tip = $('.tip', host), hov = $('.hov', host), svgEl = $('svg', host);
  const segAt = (e) => { const i = e.target.dataset?.i; if (i == null) return null; const py = (e.clientY - svgEl.getBoundingClientRect().top) * (H / svgEl.getBoundingClientRect().height); return stacks[i].find((s) => py >= s.y0 && py <= s.y1) || null; };
  let timer;
  host.onclick = (e) => { const i = e.target.dataset?.i; if (i == null || !onBucket) return; clearTimeout(timer); timer = setTimeout(() => onBucket(buckets[i]), 260); };
  host.ondblclick = (e) => { clearTimeout(timer); const s = segAt(e); if (s && onSeries) onSeries(s.id); };
  host.onmousemove = (e) => {
    const i = e.target.dataset?.i; if (i == null) { hov.setAttribute('opacity', 0); return (tip.style.display = 'none'); }
    hov.setAttribute('x', L + bw * i); hov.setAttribute('opacity', 0.06);
    const at = segAt(e);
    tip.innerHTML = `<b>${title(buckets[i])}</b>` +
      series.filter((s) => s.values[i]).map((s) => `<div ${at?.id === s.id ? 'style="font-weight:650"' : ''}><span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span><span>${fmt(s.values[i])}</span></div>`).join('') +
      `<div><span><b style="display:inline">Total</b></span><span><b style="display:inline">${fmt(totals[i])}</b></span></div>` +
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
const MEASURES = { spend: 'Spend', leads: 'Leads', appts: 'Appointments', bookings: 'Bookings $' };
const rangeQuery = () => scope() + `&from=${state.dFrom}&to=${state.dTo}`;
let ins = null; // what the Insights screen last loaded
async function insights(el) {
  const closedMonths = yearMonths().filter(closed);
  if (!closedMonths.length) { el.innerHTML = `<h1>Insights · ${state.year}</h1><div class="card">No months of ${state.year} are closed yet, so there are no actuals or outcomes to analyse. Insights fills in as actuals arrive; budgets and forecasts for ${state.year} are on the Projections screen. <button class="primary" id="back-year" style="margin-left:8px">Show ${meta.closedThrough.slice(0, 4)}</button></div>`; $('#back-year').onclick = () => { state.year = meta.closedThrough.slice(0, 4); $('#f-year').value = state.year; render(); }; return; }
  if (state.rangeYear !== state.year || !state.dFrom) { state.rangeYear = state.year; state.dFrom = monthStart(closedMonths[0]); state.dTo = monthEnd(closedMonths.at(-1)); state.prevRange = null; }
  const [f, range, series] = await Promise.all([api('/api/facts?' + scope()), api('/api/range?' + rangeQuery()), api(`/api/series?${rangeQuery()}&grain=${state.grain}&group=channel`)]);
  facts = f; ins = { range, series };
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
  const blended = tot.actual ? tot.bookings / tot.actual : 0;
  const weak = (r) => !r.c.source.startsWith('gl_') && r.t.leads > 0 && r.t.actual > tot.actual * 0.01 && r.t.bookings / r.t.actual < blended * 0.5;
  const v = tot.budget ? tot.actual / tot.budget - 1 : 0;
  const tiles = [
    ['Spend', compact(tot.actual), tot.budget ? `<span class="${v > 0 ? 'down' : 'up'}">${v > 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span> vs budget ${compact(tot.budget)}` : 'No budget loaded yet'],
    ['Leads', int(tot.leads + un.leads), `CPL ${cost(tot.actual, tot.leads + un.leads)}`],
    ['Appointments', int(tot.appts + un.appts), `CPA ${cost(tot.actual, tot.appts + un.appts)}`],
    ['Sales', int(tot.sales + un.sales), `Closing rate ${ratio(tot.sales + un.sales, tot.appts + un.appts, pct)}`],
    ['Bookings $', compact(tot.bookings + un.bookings), `Conversion ${ratio(tot.appts + un.appts, tot.leads + un.leads, pct)} lead → appt`],
    ['ROAS', ratio(tot.bookings + un.bookings, tot.actual, (x) => x.toFixed(1) + 'x'), `MCOB ${ratio(tot.actual, tot.bookings + un.bookings, pct)}`],
  ];
  const wholeMonths = state.dFrom.endsWith('-01') && state.dTo === monthEnd(state.dTo.slice(0, 7));
  const rangeText = wholeMonths ? (state.dFrom.slice(0, 7) === state.dTo.slice(0, 7) ? bucketTitle.month(state.dFrom.slice(0, 7)) : `${bucketTitle.month(state.dFrom.slice(0, 7))} to ${bucketTitle.month(state.dTo.slice(0, 7))}`) : `${niceDay(state.dFrom)} to ${niceDay(state.dTo)}`;
  // Footnote: third-party campaign detail only exists from the day each platform feed was switched on.
  const starts = Object.entries(meta.feedStart || {}).sort((a, b) => a[1].localeCompare(b[1]));
  const feedNote = starts.length && state.dFrom <= starts.at(-1)[1]
    ? `<p class="sub" style="margin:12px 0 0">Note: ad-platform campaign detail begins when each feed was switched on (${starts.map(([p, d]) => `${PLATFORM_NAME[p] || p} ${niceDay(d)}`).join(', ')}) and cannot be backfilled. Before those dates, spend for those platforms comes from the ledger only and shows as "Other GL spend" with no campaign names, so for earlier periods campaign-level CPL and CPA read lower, and ROAS higher, than they really were. Level 1 and channel figures are unaffected.</p>` : '';
  const dayNote = wholeMonths && state.grain === 'month' ? '' : `<p class="sub" style="margin:8px 0 0">Note: ad-platform spend and CRM outcomes are shown on the day they happened. Ledger-only spend has no meaningful day, so each month's amount is spread evenly across that month's days; part-month and weekly figures for it are estimates.</p>`;
  const head = '<tr><th>Channel / Level 1 / Campaign</th><th>Spend</th><th>Budget</th><th>Var</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th>CPL</th><th>CPA</th><th>Close %</th><th>ROAS</th><th class="l">Flag</th></tr>';
  const line = (cls, key, label, t, flag = '') => `<tr class="${cls}" ${key ? `data-key="${key}"` : ''}><td>${label}</td><td>${money(t.actual)}</td><td>${t.budget ? money(t.budget) : '—'}</td>
    <td class="${t.budget && t.actual > t.budget ? 'down' : ''}">${ratio(t.actual - t.budget, t.budget, (x) => (x > 0 ? '+' : '') + pct(x))}</td><td>${int(t.leads)}</td><td>${int(t.appts)}</td><td>${int(t.sales)}</td><td>${money(t.bookings)}</td>
    <td>${cost(t.actual, t.leads)}</td><td>${cost(t.actual, t.appts)}</td><td>${ratio(t.sales, t.appts, pct)}</td><td>${ratio(t.bookings, t.actual, (x) => x.toFixed(1) + 'x')}</td><td class="l">${flag}</td></tr>`;
  let body = '';
  meta.channels.forEach((c, ci) => {
    const inCh = rows.filter((r) => r.c.channel.id === c.id); if (!inCh.length) return;
    const chOpen = !state.open.has('c' + c.id); // channels start expanded
    body += line('ch', 'c' + c.id, `${chOpen ? '▾' : '▸'} <i class="dot" style="background:${COLORS[ci]}"></i>${esc(c.name)}`, Object.assign(inCh.reduce((t, r) => add(t, r.t), zero()), { budget: budgetOf(c.id) }));
    if (!chOpen) return;
    for (const l of meta.level1.filter((x) => x.channel_id === c.id)) {
      const inL = inCh.filter((r) => r.c.level1.id === l.id); if (!inL.length) continue;
      const lOpen = state.open.has('l' + l.id), nWeak = inL.filter(weak).length;
      body += line('l1', 'l' + l.id, `${lOpen ? '▾' : '▸'} ${esc(l.name)} <span class="muted">(${inL.length})</span>`, inL.reduce((t, r) => add(t, r.t), zero()), nWeak && !lOpen ? `<span class="chip warn">⚠ ${nWeak} low return</span>` : '');
      if (lOpen) for (const r of inL.sort((a, b) => b.t.actual - a.t.actual)) {
        // A campaign fed by linked ad-platform campaigns opens to show them: the lowest level of third-party detail.
        const srcKey = r.c.sources ? 's' + r.c.id : '', srcOpen = srcKey && state.open.has(srcKey);
        body += line('cp', srcKey, (srcKey ? (srcOpen ? '▾ ' : '▸ ') : '') + esc(r.c.name) + (state.brand ? '' : ` <span class="muted">· ${brandCode(r.c.brand_id)}</span>`) + (r.c.sources ? ` <span class="chip">${r.c.sources} spend source${r.c.sources > 1 ? 's' : ''}</span>` : ''), r.t, weak(r) ? '<span class="chip warn">⚠ Low return</span> <a href="#projections">Reallocate</a>' : '');
        if (srcOpen) {
          const srcs = r.c.sourceList.map((s) => ({ s, spend: s.t.actual })).sort((a, b) => b.spend - a.spend), linked = srcs.reduce((a, x) => a + x.spend, 0);
          for (const x of srcs) body += `<tr class="src"><td>${esc(x.s.name)} <span class="chip">${PLATFORM_NAME[x.s.source] || esc(x.s.source)}</span></td><td>${money(x.spend)}</td><td colspan="11" class="l muted">${x.spend ? `${pct(linked ? x.spend / linked : 0)} of this campaign's platform spend` : 'No spend in this period'} · ${esc(x.s.level1.name)}</td></tr>`;
          if (Math.abs(r.t.actual - linked) > 1) body += `<tr class="src"><td class="muted">Spend recorded on the CRM campaign itself</td><td>${money(r.t.actual - linked)}</td><td colspan="11"></td></tr>`;
        }
      }
    }
  });
  if (un.leads) body += line('l1', '', 'Not mapped to a campaign', un, '<a href="#mappings">Map names</a>');
  body += line('total', '', 'Total', Object.assign(add({ ...tot }, un), { budget: tot.budget }));

  const through = meta.dataThrough, months = meta.months.filter((m) => m <= through.slice(0, 7));
  const monthOpts = (sel) => months.map((m) => `<option ${m === sel ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('');
  const off = meta.mode === 'real' ? meta.brands.filter((b) => !b.in_ledger && (!state.brand || String(b.id) === state.brand) && rows.some((r) => r.c.brand_id === b.id && r.t.actual)) : [];
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><h1>Insights</h1><p class="sub" style="margin:0">Return on marketing spend. Outcomes follow the CRM lead-created campaign; spend follows the campaign's connected source.</p></div>
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
    <div class="tiles">${tiles.map(([k, val, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${val}</div><div class="d">${d}</div></div>`).join('')}</div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><h2>${MEASURES[state.measure]} by channel, by ${state.grain}</h2><p class="sub" style="margin:0">${rangeText}. Click a bar to zoom into it; double-click a colour, or a channel in the legend, to open its Level 1 breakdown. A single click on a legend entry hides or shows it.</p></div>
      <div class="row"><div class="seg" aria-label="Chart interval">${Object.entries(GRAINS).map(([k, n]) => `<button data-grain="${k}" class="${k === state.grain ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="seg" aria-label="Measure">${Object.entries(MEASURES).map(([k, n]) => `<button data-measure="${k}" class="${k === state.measure ? 'on' : ''}">${n}</button>`).join('')}</div></div></div>
      <div class="legend">${meta.channels.map((c, i) => `<button class="lg${state.hiddenCh.has(c.id) ? ' off' : ''}" data-lg="${c.id}" aria-pressed="${!state.hiddenCh.has(c.id)}" title="Click to hide or show ${esc(c.name)}; double-click to break it down by Level 1"><i style="background:${COLORS[i]}"></i>${esc(c.name)}</button>`).join('')}${state.hiddenCh.size ? '<button class="lg" id="lg-all">Show all</button>' : ''}</div>
      <div class="chart" id="chart"></div>${dayNote}
    </div>
    <div class="card"><h2>Channel and Level 1 performance</h2><p class="sub">${rangeText}. Level 1 spend for closed months equals the ledger: platform campaigns sit underneath at their own amounts, with "Other GL spend" and "Platform spend not yet in GL" lines making up the difference. Select a row to expand. A campaign is flagged when its ROAS is under half the blended ${blended.toFixed(1)}x.</p>
      <div class="scroll"><table>${head}${body}</table></div>${feedNote}</div>`;

  const chIndex = new Map(meta.channels.map((c, i) => [c.id, i]));
  const series = pivot(ins.series, state.measure, (id) => ch[id]?.name || 'Other', (id) => COLORS[chIndex.get(id) ?? 8]).sort((a, b) => chIndex.get(a.id) - chIndex.get(b.id)).filter((s) => !state.hiddenCh.has(s.id));
  const g = state.grain, reload = () => insights(el);
  const setRange = (a, b, keepPrev) => { if (!keepPrev) state.prevRange = null; state.dFrom = a; state.dTo = b > through ? through : b; if (state.dFrom > state.dTo) state.dFrom = state.dTo; reload(); };
  stackedChart($('#chart'), {
    buckets: ins.series.buckets, series, fmt: state.measure === 'spend' || state.measure === 'bookings' ? compact : int,
    label: bucketLabel[g], title: bucketTitle[g], hint: g === 'day' ? 'Click to focus this day · double-click a colour to break it down' : 'Click to zoom in · double-click a colour to break it down',
    // Zooming remembers where you came from, and steps the interval down so there is something to see.
    onBucket: (k) => { state.prevRange ||= { from: state.dFrom, to: state.dTo, grain: state.grain }; const [a, b] = bucketSpan[g](k); if (g !== 'day') state.grain = 'day'; setRange(a < meta.months[0] + '-01' ? meta.months[0] + '-01' : a, b, true); },
    onSeries: (id) => openDrill([{ group: 'level1', id, name: ch[id]?.name }]),
  });
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
    stackedChart($('#d-chart', dlg), { buckets: data.buckets, series: chart, fmt, label: bucketLabel[state.grain], title: bucketTitle[state.grain], hint: byCampaign ? '' : 'Double-click a colour to see its campaigns',
      onSeries: byCampaign ? null : (id) => id !== 'other' && openDrill([...path, { group: 'campaign', id, name: l1[id] }]) });
    $('#d-close', dlg).onclick = () => dlg.close();
    $$('[data-dmeasure]', dlg).forEach((b) => (b.onclick = () => { state.measure = b.dataset.dmeasure; draw(); if (location.hash.slice(1) === 'insights' || !location.hash) drawInsights($('#view')); }));
    $$('[data-crumb]', dlg).forEach((b) => (b.onclick = () => openDrill(path.slice(0, Number(b.dataset.crumb) + 1))));
    $$('[data-drill]', dlg).forEach((b) => (b.ondblclick = () => openDrill([...path, { group: 'campaign', id: Number(b.dataset.drill), name: l1[b.dataset.drill] }])));
  };
  draw();
}

// ---- Projections -----------------------------------------------------------
async function projections(el) {
  facts = await api('/api/facts?' + scope());
  const { camps } = buildModel(facts);
  const months = yearMonths(), openMonths = months.filter((m) => !closed(m)), closedMonths = months.filter(closed), last3 = meta.months.filter(closed).slice(-3);
  const rows = camps.filter((c) => months.some((m) => c.m[m] && (c.m[m].actual || c.m[m].projected)));
  const val = (c, m) => (c.m[m] ? (closed(m) ? c.m[m].actual : c.m[m].projected) : 0);
  const outlook = (c) => months.reduce((a, m) => a + val(c, m), 0);
  const trail = (c) => sum(c, last3);

  // Channel level: actuals for closed months; for open months the re-forecast if one was entered,
  // otherwise the budget, otherwise what the campaigns underneath add up to.
  const plan = new Map(facts.plan.map((p) => [`${p.brand_id}|${p.channel_id}|${p.month}`, p]));
  const brandIds = [...new Set([...rows.map((c) => c.brand_id), ...facts.plan.map((p) => p.brand_id)])];
  const chRows = meta.channels.map((ch) => {
    const inCh = rows.filter((c) => c.channel.id === ch.id);
    const cells = months.map((m) => {
      const x = { m, budget: 0, detail: 0, forecast: 0, set: false };
      for (const b of brandIds) {
        const p = plan.get(`${b}|${ch.id}|${m}`), detail = inCh.reduce((t, c) => t + (c.brand_id === b ? val(c, m) : 0), 0);
        x.budget += p?.budget || 0; x.detail += detail;
        if (p?.n) x.set = true;
        x.forecast += closed(m) ? detail : p?.n ? p.eff : p?.budget || detail;
      }
      return x;
    });
    return { ch, cells };
  }).filter((r) => r.cells.some((x) => x.budget || x.detail || x.forecast));
  const T = { budget: 0, ytd: 0, ytdBudget: 0, open: 0, openBudget: 0, detail: 0 };
  for (const r of chRows) for (const x of r.cells) { T.budget += x.budget; if (closed(x.m)) { T.ytd += x.detail; T.ytdBudget += x.budget; } else { T.open += x.forecast; T.openBudget += x.budget; T.detail += x.detail; } }
  const out = T.ytd + T.open, d = out - T.budget, canEdit = !!state.brand, hasBudget = T.budget > 0;
  const chBody = chRows.map((r, i) => {
    const b = r.cells.reduce((t, x) => t + x.budget, 0), o = r.cells.reduce((t, x) => t + x.forecast, 0);
    const od = r.cells.filter((x) => !closed(x.m)), det = od.reduce((t, x) => t + x.detail, 0), fc = od.reduce((t, x) => t + x.forecast, 0);
    return `<tr><td class="l"><i class="dot" style="background:${COLORS[meta.channels.indexOf(r.ch)]}"></i>${esc(r.ch.name)}</td>` + r.cells.map((x) => {
      const tip = `Budget ${money(x.budget)} · campaigns ${money(x.detail)}`;
      return closed(x.m) || !canEdit ? `<td class="${closed(x.m) ? 'closed' : ''}" title="${tip}">${x.forecast ? int(x.forecast) : '—'}</td>`
        : `<td class="cell"><input type="number" min="0" step="100" class="${x.set ? 'set' : ''}" value="${Math.round(x.forecast)}" data-ch="${r.ch.id}" data-m="${x.m}" data-was="${Math.round(x.forecast)}" title="${tip}${x.set ? ' · re-forecast (clear the cell to go back to budget)' : ''}" aria-label="${esc(r.ch.name)} forecast ${mlabel(x.m)}"></td>`;
    }).join('') + `<td>${b ? money(b) : '—'}</td><td>${money(o)}</td><td class="${b && o > b ? 'down' : ''}">${b ? money(o - b) : '—'}</td><td>${money(det)}</td><td class="${Math.abs(fc - det) > 1 ? '' : 'muted'}">${money(fc - det)}</td></tr>`;
  }).join('');

  // Campaign level. Across all brands the grid would run to hundreds of rows, so it rolls up to Level 1 and becomes read-only.
  const label = (c) => c.name + (state.brand || c.rollup ? '' : ` · ${brandCode(c.brand_id)}`);
  const wide = !state.brand && rows.length > 150;
  const shown = !wide ? rows : meta.level1.map((l) => {
    const inL = rows.filter((c) => c.level1.id === l.id), m = {};
    for (const mo of months) m[mo] = inL.reduce((t, c) => (c.m[mo] ? add(t, c.m[mo]) : t), sum({}, []));
    return inL.length ? { id: 'l' + l.id, name: l.name, rollup: true, level1: l, channel: inL[0].channel, m } : null;
  }).filter(Boolean);
  let body = '';
  for (const l of meta.level1) {
    const inL = shown.filter((c) => c.level1.id === l.id); if (!inL.length) continue;
    if (!wide) body += `<tr class="group"><td colspan="${months.length + 3}">${esc(l.name)} <span class="muted">· ${esc(inL[0].channel.name)}</span></td></tr>`;
    for (const c of inL) {
      const t = c.rollup ? inL.length && rows.filter((x) => x.level1.id === l.id).reduce((s, x) => add(s, trail(x)), sum({}, [])) : trail(c);
      body += `<tr><td class="l">${esc(label(c))}</td>` + months.map((m) => {
        const x = c.m[m] || { actual: 0, projected: 0 }, v = closed(m) ? x.actual : x.projected;
        return closed(m) || wide ? `<td class="${closed(m) ? 'closed' : ''}">${v ? int(v) : '—'}</td>`
          : `<td class="cell"><input type="number" min="0" step="10" value="${Math.round(x.projected)}" data-c="${c.id}" data-m="${m}" data-was="${Math.round(x.projected)}" aria-label="${esc(c.name)} projected ${mlabel(m)}"></td>`;
      }).join('') + `<td>${money(outlook(c))}</td><td>${ratio(t.actual, t.appts, money)}</td></tr>`;
    }
  }
  state.glMonth = closedMonths.includes(state.glMonth) ? state.glMonth : closedMonths.at(-1);
  const glRows = !state.glMonth ? [] : meta.level1.map((l) => ({ l, gl: facts.gl.filter((g) => g.level1_id === l.id && g.month === state.glMonth).reduce((a, g) => a + g.amount, 0),
    src: rows.filter((c) => c.level1.id === l.id && !c.source.startsWith('gl_')).reduce((a, c) => a + (c.m[state.glMonth]?.actual || 0), 0) })).filter((r) => r.gl || r.src);
  const glT = glRows.reduce((t, r) => ({ gl: t.gl + r.gl, src: t.src + r.src }), { gl: 0, src: 0 });
  const note = (x, gl) => (Math.abs(x) < Math.max(50, gl * 0.02) ? 'Tied out' : x > 0 ? 'In GL, not tied to a campaign: allocate' : 'Sourced, not in GL yet: accrual candidate');
  const th = months.map((m) => `<th>${mlabel(m)}${closed(m) ? '' : '*'}</th>`).join('');

  el.innerHTML = `
    <h1>Projections · ${state.year}</h1><p class="sub">Budget is set once a year by channel and does not move. The channel forecast is the official outlook and is re-forecast monthly; campaign projections are the detail underneath, refreshed quarterly.</p>
    <div class="tiles">
      <div class="tile"><div class="k">Annual budget</div><div class="v">${hasBudget ? compact(T.budget) : '—'}</div><div class="d">${hasBudget ? 'Set once, does not move' : 'No budget loaded for ' + state.year}</div></div>
      <div class="tile"><div class="k">Actual to date</div><div class="v">${compact(T.ytd)}</div><div class="d">${hasBudget ? 'Budget to date ' + compact(T.ytdBudget) : closedMonths.length + ' closed months'}</div></div>
      <div class="tile"><div class="k">Channel forecast, open months</div><div class="v">${compact(T.open)}</div><div class="d">Campaign detail ${compact(T.detail)} · unassigned ${compact(T.open - T.detail)}</div></div>
      <div class="tile"><div class="k">Full-year outlook</div><div class="v">${compact(out)}</div><div class="d">${hasBudget ? `<span class="${d > 0 ? 'down' : 'up'}">${d > 0 ? '▲' : '▼'} ${compact(Math.abs(d))}</span> ${d > 0 ? 'over' : 'under'} budget` : 'Actuals plus channel forecast'}</div></div>
    </div>
    <div class="card"><h2>Channel forecast, monthly</h2><p class="sub">Grey cells are actuals. ${canEdit ? 'White cells are the forecast for open months: type a new figure and press Enter to re-forecast. A bold cell has been re-forecast; clear it to return to budget.' : 'Pick a brand above to re-forecast.'} Until a month is re-forecast it shows the budget, or the campaign total where there is no budget. "Unassigned" is channel forecast not yet given to a campaign.</p>
      <div class="scroll"><table><tr><th>Channel</th>${th}<th>FY budget</th><th>FY outlook</th><th>Var</th><th>Campaigns, open mo</th><th>Unassigned</th></tr>${chBody || `<tr><td class="l muted" colspan="${months.length + 6}">Nothing for ${state.year} yet. Load a budget on the Import screen or pick a brand and enter a forecast.</td></tr>`}</table></div></div>
    ${wide ? '<div class="banner">Campaign detail below shows Level 1 totals across all brands. Pick a brand above to re-forecast campaigns or move spend.</div>' : !openMonths.length || rows.length < 2 ? '' : `<div class="card"><h2>Move spend between campaigns</h2><p class="sub">Takes projected dollars from one campaign and gives them to another in the same open month. The estimate uses each campaign's cost per appointment over the last three closed months.</p>
      <div class="row">
        <label>From <select id="r-from">${opts(rows, null, label)}</select></label>
        <label>To <select id="r-to">${opts(rows, rows[1]?.id, label)}</select></label>
        <label>Month <select id="r-month">${openMonths.map((m) => `<option value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label>
        <label>Amount <input id="r-amt" type="number" min="0" step="100" value="1000" style="width:110px"></label>
        <button class="primary" id="r-go">Move spend</button>
      </div><div class="preview" id="r-prev"></div></div>`}
    <div class="card"><h2>Campaign detail, quarterly</h2><p class="sub">Grey cells are actuals. White cells are projected spend you can edit; press Enter or leave the cell to save.</p>
      <div class="scroll"><table><tr><th>${wide ? 'Level 1' : 'Campaign'}</th>${th}<th>FY outlook</th><th>CPA, last 3 mo</th></tr>${body || `<tr><td class="l muted" colspan="${months.length + 3}">No campaign spend or projections for ${state.year} yet.</td></tr>`}</table></div></div>
    ${!state.glMonth ? '' : state.location ? '<div class="card"><h2>GL reconciliation</h2><p class="sub">Connected feeds are mostly held by brand, so clear the market location filter to see the reconciliation.</p></div>' : `
    <div class="card"><div class="row" style="justify-content:space-between"><div><h2>GL reconciliation and accrual signal</h2><p class="sub">General ledger marketing spend against spend tied to campaigns, by Level 1.</p></div>
      <label>Month <select id="gl-month">${closedMonths.map((m) => `<option ${m === state.glMonth ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label></div>
      <div class="scroll"><table><tr><th>Level 1</th><th>GL account</th><th>GL actual</th><th>Tied to campaigns</th><th>Difference</th><th class="l">Reading</th></tr>
      ${glRows.map((r) => `<tr><td>${esc(r.l.name)}</td><td>${esc(r.l.gl_account || '—')}</td><td>${money(r.gl)}</td><td>${money(r.src)}</td><td>${money(r.gl - r.src)}</td><td class="l muted">${note(r.gl - r.src, r.gl)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td></td><td>${money(glT.gl)}</td><td>${money(glT.src)}</td><td>${money(glT.gl - glT.src)}</td><td class="l">${ratio(glT.src, glT.gl, pct)} of GL explained</td></tr></table></div></div>`}`;

  if ($('#r-go')) {
    const byId = (id) => rows.find((c) => String(c.id) === String(id));
    const preview = () => {
      const a = byId($('#r-from').value), b = byId($('#r-to').value), m = $('#r-month').value, amt = Number($('#r-amt').value) || 0;
      if (!a || !b) return;
      const ta = trail(a), tb = trail(b), cpa = (t) => (t.appts ? t.actual / t.appts : null), roas = (t) => (t.actual ? t.bookings / t.actual : null);
      const lose = cpa(ta) ? amt / cpa(ta) : 0, gain = cpa(tb) ? amt / cpa(tb) : 0, bk = amt * ((roas(tb) || 0) - (roas(ta) || 0));
      const have = a.m[m]?.projected || 0;
      $('#r-prev').innerHTML = a.brand_id !== b.brand_id ? 'Pick two campaigns from the same brand.' :
        `${esc(a.name)} has ${money(have)} projected for ${mlabel(m)} (CPA ${cpa(ta) ? money(cpa(ta)) : '—'}); ${esc(b.name)} runs at CPA ${cpa(tb) ? money(cpa(tb)) : '—'}.
         Moving ${money(amt)} is estimated to change appointments by <b>${gain - lose >= 0 ? '+' : ''}${(gain - lose).toFixed(1)}</b> and bookings by <b>${bk >= 0 ? '+' : ''}${money(bk)}</b>.${amt > have ? ' <span class="down">That is more than the source campaign has projected.</span>' : ''}`;
      $('#r-go').disabled = a.brand_id !== b.brand_id || a.id === b.id || amt <= 0 || amt > have;
    };
    ['#r-from', '#r-to', '#r-month', '#r-amt'].forEach((s) => ($(s).oninput = preview)); preview();
    $('#r-go').onclick = () => act(() => api('/api/reallocate', { from: Number($('#r-from').value), to: Number($('#r-to').value), month: $('#r-month').value, amount: Number($('#r-amt').value), location_id: state.location }), 'Spend moved');
  }
  $$('td.cell input', el).forEach((i) => {
    i.oninput = () => i.classList.toggle('dirty', i.value !== i.dataset.was);
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); };
    i.onchange = () => {
      if (i.value === i.dataset.was) return;
      if (i.dataset.ch) act(() => api('/api/channel-forecast', { brand_id: Number(state.brand), location_id: state.location, channel_id: Number(i.dataset.ch), month: i.dataset.m, amount: i.value === '' ? null : Number(i.value) }), i.value === '' ? 'Back to budget' : 'Channel forecast saved');
      else act(() => api('/api/projected', { campaign_id: Number(i.dataset.c), month: i.dataset.m, amount: Number(i.value), location_id: state.location }), 'Projection saved');
    };
  });
  if ($('#gl-month')) $('#gl-month').onchange = (e) => { state.glMonth = e.target.value; render(); };
}

// ---- Campaigns -------------------------------------------------------------
async function campaigns(el) {
  const list = await api('/api/campaigns?' + scope());
  const brandId = Number(state.brand || meta.brands[0].id), brand = meta.brands.find((b) => b.id === brandId);
  const locs = meta.locations.filter((l) => l.brand_id === brandId), openMonths = meta.months;
  const waiting = list.filter((c) => c.status === 'pending').length;
  const actions = (c) => c.status === 'pending' ? (state.role === 'approver' ? `<button data-decide="approved" data-id="${c.id}" class="primary">Approve</button> <button data-decide="rejected" data-id="${c.id}">Reject</button>` : '<span class="muted">Waiting for approver</span>')
    : c.status === 'approved' ? `<button data-push="${c.id}" class="primary">Push to CRM</button>` : '';
  el.innerHTML = `
    <h1>Campaigns</h1><p class="sub">New campaigns start here. A campaign is created in the CRM only after it is approved, so the name is the same everywhere. ${waiting ? `<b>${waiting} waiting for approval.</b>` : ''}</p>
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
  const tabs = { names: 'CRM campaign names', links: 'Spend links', hierarchy: 'Channel and Level 1', brands: 'Brands and regions', changes: 'Changes' };
  let html = `<h1>Mappings</h1><p class="sub">Tie each CRM campaign name to one campaign, each campaign to a Level 1, and each Level 1 to a Channel.</p>
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
  el.innerHTML = `<h1>Import</h1><p class="sub">Load extract files from a folder on this computer. Files are read in place; nothing is uploaded anywhere. Import the mappings workbook first.
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
