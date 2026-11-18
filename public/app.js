// Maestro prototype front end. Plain ES modules, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const compact = (n) => { const a = Math.abs(n); return (n < 0 ? '-' : '') + '$' + (a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : Math.round(a).toLocaleString('en-US')); };
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—');
const ratio = (a, b, f) => (b > 0 ? f(a / b) : '—');
const cost = (a, b) => (a > 0 && b > 0 ? money(a / b) : '—');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (m) => MON[Number(m.slice(5)) - 1];
const COLORS = new Proxy([], { get: (_, i) => `var(--s${Math.min(9, Number(i) + 1)})` }); // channel colour by position; extras fold to grey
const ROLES = { marketer: 'Marketing manager (demo)', approver: 'Approver (demo)', finance: 'Finance (demo)' };

const state = { brand: '', location: '', role: 'marketer', measure: 'spend', from: null, to: null, open: new Set(), mapTab: 'names', glMonth: null };
let meta, facts;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Maestro-Role': state.role, 'X-Maestro-User': ROLES[state.role] },
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
const scope = () => new URLSearchParams(Object.entries({ brand: state.brand, location: state.location }).filter(([, v]) => v)).toString();
const opts = (rows, sel, label = (r) => r.name) => rows.map((r) => `<option value="${r.id}" ${String(r.id) === String(sel) ? 'selected' : ''}>${esc(label(r))}</option>`).join('');
const closed = (m) => m <= meta.closedThrough;
const brandCode = (id) => meta.brands.find((b) => b.id === id)?.code;

// ---- shared model ----------------------------------------------------------
function buildModel(f) {
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
  return { camps: [...camps.values()], unmapped, blank };
}
function sum(c, months, into) {
  const t = into || { budget: 0, actual: 0, projected: 0, leads: 0, appts: 0, sales: 0, bookings: 0 };
  for (const m of months) { const v = c.m ? c.m[m] : c[m]; if (v) for (const k in t) t[k] += v[k]; }
  return t;
}
const add = (a, b) => { for (const k in a) a[k] += b[k]; return a; };

// ---- chart -----------------------------------------------------------------
function stackedChart(host, { months, series, markers, fmt }) {
  const W = 960, H = 280, L = 56, R = 12, T = 12, B = 30, pw = W - L - R, ph = H - T - B;
  const totals = months.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
  const max = Math.max(1, ...totals, ...(markers || []));
  const step = (() => { const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  const top = Math.ceil(max / step) * step, y = (v) => T + ph - (v / top) * ph, bw = pw / months.length, w = Math.min(44, bw * 0.6);
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? 'var(--grid)' : 'var(--axis)'}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  months.forEach((m, i) => {
    const x = L + bw * i + (bw - w) / 2, op = closed(m) ? 1 : 0.45;
    let base = 0;
    const live = series.map((s, si) => ({ s, si })).filter((o) => o.s.values[i] > 0);
    live.forEach(({ s }, k) => {
      const v = s.values[i], y1 = y(base + v), h = Math.max(0, y(base) - y1 - (k < live.length - 1 ? 2 : 0)), r = k === live.length - 1 ? Math.min(4, h) : 0, yt = y(base) - h;
      svg += `<path d="M${x},${yt + h}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + w - r}Q${x + w},${yt} ${x + w},${yt + r}V${yt + h}Z" fill="${s.color}" opacity="${op}"/>`;
      base += v;
    });
    if (markers && markers[i] > 0) svg += `<line x1="${x - 5}" x2="${x + w + 5}" y1="${y(markers[i])}" y2="${y(markers[i])}" stroke="var(--ink)" stroke-width="2"/>`;
    svg += `<text x="${L + bw * i + bw / 2}" y="${H - 10}" text-anchor="middle">${mlabel(m)}${closed(m) ? '' : '*'}</text><rect data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}" fill="transparent"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly stacked bars by channel">${svg}</svg><div class="tip"></div>`;
  const tip = $('.tip', host);
  host.onmousemove = (e) => {
    const i = e.target.dataset?.i; if (i == null) return (tip.style.display = 'none');
    tip.innerHTML = `<b>${mlabel(months[i])} ${months[i].slice(0, 4)}${closed(months[i]) ? '' : ' · projected'}</b>` +
      series.map((s) => `<div><span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span><span>${fmt(s.values[i])}</span></div>`).join('') +
      `<div><span><b style="display:inline">Total</b></span><span><b style="display:inline">${fmt(totals[i])}</b></span></div>` +
      (markers ? `<div><span>Budget</span><span>${fmt(markers[i])}</span></div>` : '');
    const box = host.getBoundingClientRect(); tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX - box.left + 14, box.width - tip.offsetWidth - 4) + 'px'; tip.style.top = Math.max(0, e.clientY - box.top - 20) + 'px';
  };
  host.onmouseleave = () => (tip.style.display = 'none');
}

// ---- Insights --------------------------------------------------------------
async function insights(el) {
  facts = await api('/api/facts?' + scope());
  const closedMonths = meta.months.filter(closed);
  state.from ||= closedMonths[0]; state.to ||= closedMonths.at(-1);
  drawInsights(el);
}
function drawInsights(el) {
  const { camps, unmapped } = buildModel(facts);
  const closedMonths = meta.months.filter(closed);
  const range = closedMonths.filter((m) => m >= state.from && m <= state.to);
  const tot = camps.reduce((t, c) => sum(c, range, t), undefined) || sum({}, []);
  const un = sum(unmapped, range);
  const rows = camps.map((c) => ({ c, t: sum(c, range) })).filter((r) => r.t.actual || r.t.leads || r.t.budget);
  const blended = tot.actual ? tot.bookings / tot.actual : 0;
  const weak = (r) => r.c.source !== 'gl_unallocated' && r.t.leads > 0 && r.t.actual > tot.actual * 0.01 && r.t.bookings / r.t.actual < blended * 0.5;
  const v = tot.budget ? tot.actual / tot.budget - 1 : 0;
  const tiles = [
    ['Spend', compact(tot.actual), tot.budget ? `<span class="${v > 0 ? 'down' : 'up'}">${v > 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span> vs budget ${compact(tot.budget)}` : 'No budget loaded yet'],
    ['Leads', int(tot.leads), `CPL ${cost(tot.actual, tot.leads)}`],
    ['Appointments', int(tot.appts), `CPA ${cost(tot.actual, tot.appts)}`],
    ['Sales', int(tot.sales), `Closing rate ${ratio(tot.sales, tot.appts, pct)}`],
    ['Bookings $', compact(tot.bookings), `Conversion ${ratio(tot.appts, tot.leads, pct)} lead → appt`],
    ['ROAS', ratio(tot.bookings, tot.actual, (x) => x.toFixed(1) + 'x'), `MCOB ${ratio(tot.actual, tot.bookings, pct)}`],
  ];
  const measures = { spend: 'Spend', leads: 'Leads', appts: 'Appointments', bookings: 'Bookings $' };
  const head = '<tr><th>Channel / Level 1 / Campaign</th><th>Spend</th><th>Budget</th><th>Var</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Bookings $</th><th>CPL</th><th>CPA</th><th>Close %</th><th>ROAS</th><th class="l">Flag</th></tr>';
  const line = (cls, key, label, t, flag = '') => `<tr class="${cls}" ${key ? `data-key="${key}"` : ''}><td>${label}</td><td>${money(t.actual)}</td><td>${money(t.budget)}</td>
    <td class="${t.actual > t.budget ? 'down' : ''}">${ratio(t.actual - t.budget, t.budget, (x) => (x > 0 ? '+' : '') + pct(x))}</td><td>${int(t.leads)}</td><td>${int(t.appts)}</td><td>${int(t.sales)}</td><td>${money(t.bookings)}</td>
    <td>${cost(t.actual, t.leads)}</td><td>${cost(t.actual, t.appts)}</td><td>${ratio(t.sales, t.appts, pct)}</td><td>${ratio(t.bookings, t.actual, (x) => x.toFixed(1) + 'x')}</td><td class="l">${flag}</td></tr>`;
  let body = '';
  meta.channels.forEach((ch, ci) => {
    const inCh = rows.filter((r) => r.c.channel.id === ch.id); if (!inCh.length) return;
    const chOpen = !state.open.has('c' + ch.id); // channels start expanded
    body += line('ch', 'c' + ch.id, `${chOpen ? '▾' : '▸'} <i class="dot" style="background:${COLORS[ci]}"></i>${esc(ch.name)}`, inCh.reduce((t, r) => add(t, r.t), sum({}, [])));
    if (!chOpen) return;
    for (const l of meta.level1.filter((l) => l.channel_id === ch.id)) {
      const inL = inCh.filter((r) => r.c.level1.id === l.id); if (!inL.length) continue;
      const lOpen = state.open.has('l' + l.id), nWeak = inL.filter(weak).length;
      body += line('l1', 'l' + l.id, `${lOpen ? '▾' : '▸'} ${esc(l.name)} <span class="muted">(${inL.length})</span>`, inL.reduce((t, r) => add(t, r.t), sum({}, [])), nWeak && !lOpen ? `<span class="chip warn">⚠ ${nWeak} low return</span>` : '');
      if (lOpen) for (const r of inL.sort((a, b) => b.t.actual - a.t.actual))
        body += line('cp', '', esc(r.c.name) + (state.brand ? '' : ` <span class="muted">· ${brandCode(r.c.brand_id)}</span>`), r.t, weak(r) ? '<span class="chip warn">⚠ Low return</span> <a href="#projections">Reallocate</a>' : '');
    }
  });
  if (un.leads) body += line('l1', '', 'Not mapped to a campaign', un, '<a href="#mappings">Map names</a>');
  body += line('total', '', 'Total', add({ ...tot }, un));

  el.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><h1>Insights</h1><p class="sub" style="margin:0">Return on marketing spend. Outcomes follow the CRM lead-created campaign; spend follows the campaign's connected source.</p></div>
      <div class="row"><label>From <select id="from">${closedMonths.map((m) => `<option ${m === state.from ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label>
      <label>To <select id="to">${closedMonths.map((m) => `<option ${m === state.to ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label></div>
    </div>
    ${un.leads ? `<div class="banner">${int(un.leads)} leads and ${money(un.bookings)} of bookings in this period sit under CRM campaign names that are not mapped yet. <a href="#mappings">Review mappings</a></div>` : ''}
    <div class="tiles">${tiles.map(([k, val, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${val}</div><div class="d">${d}</div></div>`).join('')}</div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><h2>${measures[state.measure]} by channel, by month</h2><p class="sub" style="margin:0">Full year. Months marked * are open: spend shown is the current projection and outcomes are not in yet.</p></div>
      <div class="seg">${Object.entries(measures).map(([k, n]) => `<button data-measure="${k}" class="${k === state.measure ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="legend">${meta.channels.map((c, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(c.name)}</span>`).join('')}${state.measure === 'spend' ? '<span><i class="tick"></i>Budget</span>' : ''}</div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="card"><h2>Channel and Level 1 performance</h2><p class="sub">${mlabel(state.from)} to ${mlabel(state.to)} ${state.to.slice(0, 4)}. Select a row to expand. A campaign is flagged when its ROAS is under half the blended ${blended.toFixed(1)}x.</p>
      <div class="scroll"><table>${head}${body}</table></div></div>`;

  const val = (c, m) => { const x = c.m[m]; if (!x) return 0; return state.measure === 'spend' ? (closed(m) ? x.actual : x.projected) : x[state.measure]; };
  stackedChart($('#chart'), {
    months: meta.months,
    series: meta.channels.map((ch, i) => ({ name: ch.name, color: COLORS[i], values: meta.months.map((m) => camps.filter((c) => c.channel.id === ch.id).reduce((a, c) => a + val(c, m), 0)) })),
    markers: state.measure === 'spend' ? meta.months.map((m) => camps.reduce((a, c) => a + (c.m[m]?.budget || 0), 0)) : null,
    fmt: state.measure === 'spend' || state.measure === 'bookings' ? compact : int,
  });
  $('#from').onchange = (e) => { state.from = e.target.value; if (state.to < state.from) state.to = state.from; drawInsights(el); };
  $('#to').onchange = (e) => { state.to = e.target.value; if (state.from > state.to) state.from = state.to; drawInsights(el); };
  $$('[data-measure]', el).forEach((b) => (b.onclick = () => { state.measure = b.dataset.measure; drawInsights(el); }));
  $$('tr[data-key]', el).forEach((r) => (r.onclick = () => { const k = r.dataset.key; state.open.has(k) ? state.open.delete(k) : state.open.add(k); drawInsights(el); }));
}

// ---- Projections -----------------------------------------------------------
async function projections(el) {
  facts = await api('/api/facts?' + scope());
  const { camps } = buildModel(facts);
  const months = meta.months, openMonths = months.filter((m) => !closed(m)), closedMonths = months.filter(closed), last3 = closedMonths.slice(-3);
  const rows = camps.filter((c) => months.some((m) => c.m[m] && (c.m[m].budget || c.m[m].actual || c.m[m].projected)));
  const outlook = (c) => months.reduce((a, m) => a + (c.m[m] ? (closed(m) ? c.m[m].actual : c.m[m].projected) : 0), 0);
  const fy = (c, k) => months.reduce((a, m) => a + (c.m[m]?.[k] || 0), 0);
  const trail = (c) => sum(c, last3);
  const T = { budget: 0, ytd: 0, ytdBudget: 0, open: 0, openBudget: 0 };
  for (const c of rows) { T.budget += fy(c, 'budget'); for (const m of months) { const x = c.m[m]; if (!x) continue; if (closed(m)) { T.ytd += x.actual; T.ytdBudget += x.budget; } else { T.open += x.projected; T.openBudget += x.budget; } } }
  const out = T.ytd + T.open, d = out - T.budget;
  const label = (c) => c.name + (state.brand || c.rollup ? '' : ` · ${brandCode(c.brand_id)}`);
  // Across all brands the grid would run to hundreds of rows, so it rolls up to Level 1 and becomes read-only.
  const wide = !state.brand && rows.length > 150;
  const shown = !wide ? rows : meta.level1.map((l) => {
    const inL = rows.filter((c) => c.level1.id === l.id), m = {};
    for (const mo of months) m[mo] = inL.reduce((t, c) => (c.m[mo] ? add(t, c.m[mo]) : t), sum({}, []));
    return inL.length ? { id: 'l' + l.id, name: l.name, rollup: true, level1: l, channel: inL[0].channel, m } : null;
  }).filter(Boolean);
  let body = '';
  for (const l of meta.level1) {
    const inL = shown.filter((c) => c.level1.id === l.id); if (!inL.length) continue;
    if (!wide) body += `<tr class="group"><td colspan="${months.length + 5}">${esc(l.name)} <span class="muted">· ${esc(inL[0].channel.name)}</span></td></tr>`;
    for (const c of inL) {
      const t = trail(c), o = outlook(c), b = fy(c, 'budget');
      body += `<tr><td class="l">${esc(label(c))}</td>` + months.map((m) => {
        const x = c.m[m] || { actual: 0, projected: 0, budget: 0 };
        return closed(m) || wide ? `<td class="${closed(m) ? 'closed' : ''}" title="Budget ${money(x.budget)}">${(closed(m) ? x.actual : x.projected) ? int(closed(m) ? x.actual : x.projected) : '—'}</td>`
          : `<td class="cell"><input type="number" min="0" step="10" value="${Math.round(x.projected)}" data-c="${c.id}" data-m="${m}" data-was="${Math.round(x.projected)}" title="Budget ${money(x.budget)}" aria-label="${esc(c.name)} projected ${mlabel(m)}"></td>`;
      }).join('') + `<td>${money(b)}</td><td>${money(o)}</td><td class="${o > b ? 'down' : ''}">${money(o - b)}</td><td>${cost(t.actual, t.appts)}</td></tr>`;
    }
  }
  const glMonths = closedMonths; state.glMonth ||= glMonths.at(-1);
  const glRows = meta.level1.map((l) => ({ l, gl: facts.gl.filter((g) => g.level1_id === l.id && g.month === state.glMonth).reduce((a, g) => a + g.amount, 0),
    src: rows.filter((c) => c.level1.id === l.id && c.source !== 'gl_unallocated').reduce((a, c) => a + (c.m[state.glMonth]?.actual || 0), 0) })).filter((r) => r.gl || r.src);
  const glT = glRows.reduce((t, r) => ({ gl: t.gl + r.gl, src: t.src + r.src }), { gl: 0, src: 0 });
  const note = (x, gl) => (Math.abs(x) < Math.max(50, gl * 0.02) ? 'Tied out' : x > 0 ? 'In GL, not tied to a campaign: allocate' : 'Sourced, not in GL yet: accrual candidate');

  el.innerHTML = `
    <h1>Projections</h1><p class="sub">Budget is fixed for the year. Closed months show actual spend. Edit the open months to re-forecast, or move dollars between campaigns.</p>
    <div class="tiles">
      <div class="tile"><div class="k">Annual budget</div><div class="v">${compact(T.budget)}</div><div class="d">Set once, does not move</div></div>
      <div class="tile"><div class="k">Actual to date</div><div class="v">${compact(T.ytd)}</div><div class="d">Budget to date ${compact(T.ytdBudget)}</div></div>
      <div class="tile"><div class="k">Projected, open months</div><div class="v">${compact(T.open)}</div><div class="d">Budget for those months ${compact(T.openBudget)}</div></div>
      <div class="tile"><div class="k">Full-year outlook</div><div class="v">${compact(out)}</div><div class="d"><span class="${d > 0 ? 'down' : 'up'}">${d > 0 ? '▲' : '▼'} ${compact(Math.abs(d))}</span> ${d > 0 ? 'over' : 'under'} budget</div></div>
    </div>
    ${wide ? '<div class="banner">Showing Level 1 totals across all brands. Pick a brand above to re-forecast campaigns or move spend.</div>' : `<div class="card"><h2>Move spend between campaigns</h2><p class="sub">Takes projected dollars from one campaign and gives them to another in the same open month. The estimate uses each campaign's cost per appointment over the last three closed months.</p>
      <div class="row">
        <label>From <select id="r-from">${opts(rows, null, label)}</select></label>
        <label>To <select id="r-to">${opts(rows, rows[1]?.id, label)}</select></label>
        <label>Month <select id="r-month">${openMonths.map((m) => `<option value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label>
        <label>Amount <input id="r-amt" type="number" min="0" step="100" value="1000" style="width:110px"></label>
        <button class="primary" id="r-go">Move spend</button>
      </div><div class="preview" id="r-prev"></div></div>`}
    <div class="card"><h2>Spend by campaign and month</h2><p class="sub">Grey cells are actuals. White cells are projected spend you can edit; press Enter or leave the cell to save. Hover a cell for its budget.</p>
      <div class="scroll"><table><tr><th>${wide ? 'Level 1' : 'Campaign'}</th>${months.map((m) => `<th>${mlabel(m)}${closed(m) ? '' : '*'}</th>`).join('')}<th>FY budget</th><th>FY outlook</th><th>Var</th><th>CPA, last 3 mo</th></tr>${body}</table></div></div>
    ${state.location ? '<div class="card"><h2>GL reconciliation</h2><p class="sub">The general ledger is held by brand, so clear the market location filter to see it.</p></div>' : `
    <div class="card"><div class="row" style="justify-content:space-between"><div><h2>GL reconciliation and accrual signal</h2><p class="sub">General ledger marketing spend against spend tied to campaigns, by Level 1.</p></div>
      <label>Month <select id="gl-month">${glMonths.map((m) => `<option ${m === state.glMonth ? 'selected' : ''} value="${m}">${mlabel(m)} ${m.slice(0, 4)}</option>`).join('')}</select></label></div>
      <div class="scroll"><table><tr><th>Level 1</th><th>GL account</th><th>GL actual</th><th>Tied to campaigns</th><th>Difference</th><th class="l">Reading</th></tr>
      ${glRows.map((r) => `<tr><td>${esc(r.l.name)}</td><td>${esc(r.l.gl_account || '—')}</td><td>${money(r.gl)}</td><td>${money(r.src)}</td><td>${money(r.gl - r.src)}</td><td class="l muted">${note(r.gl - r.src, r.gl)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td></td><td>${money(glT.gl)}</td><td>${money(glT.src)}</td><td>${money(glT.gl - glT.src)}</td><td class="l">${ratio(glT.src, glT.gl, pct)} of GL explained</td></tr></table></div></div>`}`;

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
  if (!wide) { ['#r-from', '#r-to', '#r-month', '#r-amt'].forEach((s) => ($(s).oninput = preview)); preview(); }
  if (!wide) $('#r-go').onclick = () => act(() => api('/api/reallocate', { from: Number($('#r-from').value), to: Number($('#r-to').value), month: $('#r-month').value, amount: Number($('#r-amt').value), location_id: state.location }), 'Spend moved');
  $$('td.cell input', el).forEach((i) => {
    i.oninput = () => i.classList.toggle('dirty', i.value !== i.dataset.was);
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); };
    i.onchange = () => { if (i.value === i.dataset.was) return; act(() => api('/api/projected', { campaign_id: Number(i.dataset.c), month: i.dataset.m, amount: Number(i.value), location_id: state.location }), 'Projection saved'); };
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
  const tabs = { names: 'CRM campaign names', hierarchy: 'Channel and Level 1', changes: 'Changes' };
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
function fillLocations() {
  $('#f-location').innerHTML = '<option value="">All locations</option>' + opts(meta.locations.filter((l) => !state.brand || String(l.brand_id) === state.brand), state.location, (l) => (state.brand ? l.name : `${l.name} · ${brandCode(l.brand_id)}`));
}
async function loadMeta() {
  meta = await api('/api/meta');
  if (!meta.brands.some((b) => String(b.id) === state.brand)) { state.brand = ''; state.location = ''; }
  $('.tag').textContent = meta.mode === 'real' ? 'Prototype · imported data' : 'Prototype · synthetic data';
  $('#f-brand').innerHTML = '<option value="">All brands</option>' + opts([...meta.brands].sort((a, b) => a.name.localeCompare(b.name)), state.brand);
  fillLocations();
}
async function init() {
  await loadMeta();
  $('#f-brand').onchange = (e) => { state.brand = e.target.value; state.location = ''; fillLocations(); render(); };
  $('#f-location').onchange = (e) => {
    state.location = e.target.value;
    if (state.location && !state.brand) { state.brand = String(meta.locations.find((l) => String(l.id) === state.location).brand_id); $('#f-brand').value = state.brand; fillLocations(); }
    render();
  };
  $('#role').onchange = (e) => { state.role = e.target.value; render(); };
  window.onhashchange = render;
  render();
}
init();
