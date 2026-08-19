/* ============================================================
   supply.js — "Supply" tab
   The cleaner Curves view: a true supply curve built live from
   the Tonnage Board (which the CSV sync keeps fresh).

   Price ladder  — OPEN ships sorted by rate ascending, cumulative
                   count on x, rate on y (stepped line). Rated
                   ships (with an offer) plotted on BKI eqvt;
                   unrated ships optionally included at Arrow eqvt
                   (dashed = implied, not an offer).
   Depth buckets — live counts of ships arriving 0-10 / 10-20 /
                   20-30 / 30-40 days out, replacing the static
                   columns of the old Curves tab.

   Filters: laycan (LAYDAY) window, ETA window, DWT range,
   scrubber-only, search. Optional P6 reference line.
   ============================================================ */

(function () {
'use strict';

const LS_UI = 'sp_ui';
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const DAY = 86400000;

let SP = { initialised: false, chart: null, rollChart: null };
let ui = Object.assign({
  includeUnrated: true,
  layFrom: '', layTo: '', etaFrom: '', etaTo: '',
  minDwt: '', maxDwt: '', scrubOnly: false, search: '',
  p6Ref: '', range: '6M', ratedCurve: false,
}, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

// ─── Rolling depth history ───────────────────────────────────────────────────
// Seeded from the workbook's Curves tab (curves-seed.js); every day the tab
// is opened, today's bucket counts are snapshotted so the series keeps
// growing without the spreadsheet. Snapshots also store rated-only counts,
// which the seed doesn't have.
const LS_SNAPS = 'sp_snapshots';

function loadHistory() {
  const seed = (IS_BROWSER && window.CURVES_SEED) ? window.CURVES_SEED : [];
  const snaps = IS_BROWSER ? JSON.parse(localStorage.getItem(LS_SNAPS) || '{}') : {};
  const byDate = {};
  for (const h of seed) byDate[h.date] = Object.assign({}, h);
  for (const d in snaps) byDate[d] = Object.assign(byDate[d] || { date: d }, snaps[d]);
  return Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
}

function snapshotToday(res) {
  if (!IS_BROWSER) return;
  if (!res.ships.length) return;   // don't overwrite a good snapshot with an empty board
  const d = new Date().toISOString().slice(0, 10);
  const snaps = JSON.parse(localStorage.getItem(LS_SNAPS) || '{}');
  const b = res.buckets, rb = res.ratedBuckets;
  snaps[d] = {
    b0_10: b.b0_10, b10_20: b.b10_20, b20_30: b.b20_30, next30: b.next30, b30_40: b.b30_40,
    r0_10: rb.b0_10, r10_20: rb.b10_20, r20_30: rb.b20_30, rnext30: rb.next30, r30_40: rb.b30_40,
    p6: parseFloat(ui.p6Ref) || (snaps[d] && snaps[d].p6) || null,
  };
  localStorage.setItem(LS_SNAPS, JSON.stringify(snaps));
}

// ─── Data ────────────────────────────────────────────────────────────────────
function boardVessels() {
  return (typeof vessels !== 'undefined' && Array.isArray(vessels)) ? vessels : [];
}

function ratedValue(v) {
  // BKI eqvt is the comparable rate for a ship WITH an offer
  if (v.bki_eqvt != null) return v.bki_eqvt;
  const mc = v.market_colour && v.market_colour[0];
  if (mc && mc.p6_offer != null) return mc.p6_offer;
  return null;
}
function hasOffer(v) {
  const mc = v.market_colour && v.market_colour[0];
  return v.hire_offer != null || v.bki_eqvt != null || (mc && (mc.offer_usd != null || mc.p6_offer != null));
}
function impliedValue(v) { return v.arrow_eqvt != null ? v.arrow_eqvt : null; }

function inDateWindow(iso, from, to) {
  if (!from && !to) return true;
  if (!iso) return false;           // window active but ship has no date → excluded
  const d = String(iso).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function computeSupply() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const excluded = { laycan: 0, eta: 0 };
  const ships = [];

  for (const v of boardVessels()) {
    if (v.status !== 'OPEN' || !v.vessel_name) continue;
    if (ui.scrubOnly && !v.scrubber) continue;
    if (ui.minDwt && (v.dwt || 0) < parseFloat(ui.minDwt)) continue;
    if (ui.maxDwt && (v.dwt || 0) > parseFloat(ui.maxDwt)) continue;
    if (ui.search) {
      const hay = [v.vessel_name, v.owner, v.delivery_basis, v.notes].join(' ').toLowerCase();
      if (!hay.includes(ui.search.toLowerCase())) continue;
    }
    if (!inDateWindow(v.open_date || v.laycan_date, ui.layFrom, ui.layTo)) { excluded.laycan++; continue; }
    if (!inDateWindow(v.eta_ecsa, ui.etaFrom, ui.etaTo)) { excluded.eta++; continue; }

    const rated = hasOffer(v);
    const rate = rated ? ratedValue(v) : impliedValue(v);
    const etaDays = v.eta_ecsa ? Math.floor((new Date(String(v.eta_ecsa).slice(0, 10) + 'T00:00:00') - today) / DAY) : null;
    ships.push({ v, rated, rate, etaDays });
  }

  // Depth buckets on ETA (all filtered ships, priced or not) + rated-only set
  const mkB = () => ({ b0_10: 0, b10_20: 0, b20_30: 0, b30_40: 0, next30: 0, noEta: 0 });
  const buckets = mkB(), ratedBuckets = mkB();
  const bump = (B, d) => {
    if (d >= 0 && d < 10) B.b0_10++;
    else if (d >= 10 && d < 20) B.b10_20++;
    else if (d >= 20 && d < 30) B.b20_30++;
    else if (d >= 30 && d < 40) B.b30_40++;
    if (d >= 0 && d < 30) B.next30++;
  };
  for (const s of ships) {
    if (s.etaDays == null) { buckets.noEta++; if (s.rated) ratedBuckets.noEta++; continue; }
    bump(buckets, s.etaDays);
    if (s.rated) bump(ratedBuckets, s.etaDays);
  }

  // Ladder: rated always; unrated included when toggled and priced by Arrow
  const ladder = ships
    .filter(s => s.rate != null && (s.rated || ui.includeUnrated))
    .sort((a, b) => a.rate - b.rate);
  ladder.forEach((s, i) => { s.cum = i + 1; });

  const rates = ladder.filter(s => s.rated).map(s => s.rate);
  const median = rates.length ? rates.slice().sort((a, b) => a - b)[Math.floor(rates.length / 2)] : null;

  return { ships, ladder, buckets, ratedBuckets, excluded, ratedCount: rates.length, median };
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function esc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtK(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
function fmtD(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// ─── Supply Pulse ────────────────────────────────────────────────────────────
// Mirror of the cargo book's Demand Pulse: are more or fewer ships arriving
// than typical? Metric = ships arriving inside 30 days (next30), series from
// the imported Curves history + daily snapshots, norm = trailing 28d mean.
function computeSupplyPulse() {
  const hist = loadHistory().filter(h => h.next30 != null);
  if (!hist.length) return null;
  const t = hist[hist.length - 1];
  const from = Math.max(0, hist.length - 28);
  const window28 = hist.slice(from);
  const avg28 = window28.reduce((s, h) => s + h.next30, 0) / window28.length;
  const prev = hist[hist.length - 2];
  // w/w: nearest entry 6-9 days back by DATE (the series can skip weekends)
  let wk = null;
  for (let back = 7; back <= 9 && !wk; back++) {
    for (const sign of [0, 1, -1]) {
      const d = new Date(new Date(t.date + 'T00:00:00Z').getTime() - (back + sign) * FU_DAY()).toISOString().slice(0, 10);
      const hit = hist.find(h => h.date === d);
      if (hit) { wk = hit; break; }
    }
  }
  return {
    date: t.date, today: t.next30,
    avg28, index: avg28 > 0 ? Math.round(t.next30 / avg28 * 100) : null,
    dd: prev ? t.next30 - prev.next30 : null,
    ww: wk ? t.next30 - wk.next30 : null,
  };
}
function FU_DAY() { return 86400000; }

// Rolling depth curve — the old Curves tab, live: x = date, y = ships by ETA
// bucket, P6 value on the right axis.
function renderRollChart() {
  const canvas = document.getElementById('sp_rollChart');
  if (!canvas || typeof Chart === 'undefined') return;
  let hist = loadHistory();
  const days = { '3M': 92, '6M': 183, '1Y': 366, 'ALL': 99999 }[ui.range] || 183;
  const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  hist = hist.filter(h => h.date >= cutoff);

  const rated = ui.ratedCurve;
  const pick = (h, all, r) => rated ? (h[r] != null ? h[r] : null) : h[all];
  const mkSeries = (label, all, r, color, width, hidden) => ({
    label, data: hist.map(h => pick(h, all, r)),
    borderColor: color, backgroundColor: color, borderWidth: width,
    pointRadius: 0, pointHoverRadius: 4, tension: .3, spanGaps: true, yAxisID: 'y', hidden,
  });
  const datasets = [
    mkSeries('0–10d', 'b0_10', 'r0_10', '#A32D2D', 1.5, false),
    mkSeries('10–20d', 'b10_20', 'r10_20', '#BA7517', 1.5, false),
    mkSeries('20–30d', 'b20_30', 'r20_30', '#3B6D11', 1.5, false),
    mkSeries('Next 30d', 'next30', 'rnext30', '#185FA5', 2.5, false),
    mkSeries('30–40d', 'b30_40', 'r30_40', '#888888', 1.5, true),
    {
      label: 'P6 $/day', data: hist.map(h => h.p6 ?? null),
      borderColor: '#1A1A1A', borderDash: [6, 4], borderWidth: 1.5,
      pointRadius: 0, pointHoverRadius: 4, tension: .2, spanGaps: true, yAxisID: 'y2',
    },
  ];

  if (SP.rollChart) SP.rollChart.destroy();
  SP.rollChart = new Chart(canvas, {
    type: 'line',
    data: { labels: hist.map(h => h.date), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 14, callback(v) {
          const d = this.getLabelForValue(v);
          const dt = new Date(d + 'T00:00:00Z');
          return isNaN(dt) ? d : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
        } } },
        y: { title: { display: true, text: rated ? 'Ships with offers (by ETA)' : 'Ships (by ETA)' }, beginAtZero: true },
        y2: { position: 'right', title: { display: true, text: 'P6 $/day' }, grid: { drawOnChartArea: false } },
      },
      plugins: { legend: { position: 'top', labels: { boxWidth: 18 } } },
    },
  });
}

function renderChart(res) {
  const canvas = document.getElementById('sp_chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const rated = res.ladder.filter(s => s.rated).map(s => ({ x: s.cum, y: s.rate, ship: s }));
  const implied = ui.includeUnrated ? res.ladder.filter(s => !s.rated).map(s => ({ x: s.cum, y: s.rate, ship: s })) : [];

  const datasets = [{
    label: 'Offers (BKI eqvt)',
    data: rated, stepped: 'before', showLine: true,
    borderColor: '#185FA5', backgroundColor: '#185FA5', pointRadius: 4, pointHoverRadius: 6,
  }];
  if (implied.length) datasets.push({
    label: 'Unrated (Arrow eqvt, implied)',
    data: implied, showLine: false,
    borderColor: '#BA7517', backgroundColor: '#BA751799', pointStyle: 'triangle', pointRadius: 5, pointHoverRadius: 7,
  });

  const p6 = parseFloat(ui.p6Ref);
  const annotations = !isNaN(p6) && p6 > 0 ? [{ y: p6 }] : [];

  if (SP.chart) SP.chart.destroy();
  SP.chart = new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Cumulative ships (sorted by rate)' }, ticks: { stepSize: 1 }, beginAtZero: true },
        y: { title: { display: true, text: 'Rate $/day (P6-normalised)' } },
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: ctx => {
              const s = ctx.raw.ship, v = s.v;
              return [
                `${v.vessel_name} — ${fmtK(s.rate)}${s.rated ? '' : ' (implied)'}`,
                `${v.dwt ? Math.round(v.dwt / 1000) + 'k' : '?'}/${v.build_year || '?'} · ${v.delivery_basis || '?'}`,
                `layday ${fmtD(v.open_date || v.laycan_date)} · ETA ${fmtD(v.eta_ecsa)}${v.scrubber ? ' · SCR' : ''}`,
              ];
            },
          },
        },
      },
    },
    plugins: [{
      id: 'p6line',
      afterDraw(chart) {
        if (!annotations.length) return;
        const y = chart.scales.y.getPixelForValue(annotations[0].y);
        if (y < chart.chartArea.top || y > chart.chartArea.bottom) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = '#A32D2D'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(chart.chartArea.left, y); ctx.lineTo(chart.chartArea.right, y); ctx.stroke();
        ctx.fillStyle = '#A32D2D'; ctx.font = '11px sans-serif';
        ctx.fillText('P6 ' + fmtK(annotations[0].y), chart.chartArea.left + 6, y - 5);
        ctx.restore();
      },
    }],
  });
}

function render() {
  const root = document.getElementById('sp_root');
  if (!root || !SP.initialised) return;
  const res = computeSupply();

  // Stat cards: depth buckets + rated stats + the SUPPLY PULSE — same
  // grammar as the cargo book's demand pulse (>100 = more ships than typical
  // = softer market for owners)
  const b = res.buckets;
  const pulse = computeSupplyPulse();
  const sgn = n => n == null ? '—' : (n > 0 ? '+' : '') + n;
  const pulseCards = pulse ? [
    ['Supply index', pulse.index != null ? pulse.index : '—',
      pulse.index == null ? '' : pulse.index >= 115 ? 'color:var(--red)' : pulse.index <= 85 ? 'color:var(--green)' : '',
      `Arrivals ≤30d (${pulse.today}) ÷ trailing 28d norm (${pulse.avg28.toFixed(1)}) × 100. >100 = more ships than typical (softer); <100 = tighter.`],
    ['Supply d/d', sgn(pulse.dd), pulse.dd > 0 ? 'color:var(--red)' : pulse.dd < 0 ? 'color:var(--green)' : '', 'Change in ≤30d arrivals vs the previous data day'],
    ['Supply w/w', sgn(pulse.ww), pulse.ww > 0 ? 'color:var(--red)' : pulse.ww < 0 ? 'color:var(--green)' : '', 'Change vs ~7 days ago'],
  ] : [];
  document.getElementById('sp_stats').innerHTML = [
    ['0–10d', b.b0_10], ['10–20d', b.b10_20], ['20–30d', b.b20_30],
    ['Next 30d', b.next30, true], ['30–40d', b.b30_40],
    ['Rated', res.ratedCount], ['Median offer', res.median != null ? fmtK(res.median) : '—'],
  ].map(([l, v, hot]) => `<div class="stat" style="min-width:86px;padding:8px 14px${hot ? ';border-color:var(--accent);background:var(--accent-light)' : ''}">
      <div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px">${v}</div></div>`).join('')
    + pulseCards.map(([l, v, style, tip]) => `<div class="stat" title="${tip}" style="min-width:86px;padding:8px 14px;border-style:dashed">
      <div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px;${style}">${v}</div></div>`).join('');

  const note = [];
  if (res.excluded.laycan) note.push(`${res.excluded.laycan} hidden by laycan window`);
  if (res.excluded.eta) note.push(`${res.excluded.eta} hidden by ETA window`);
  if (b.noEta) note.push(`${b.noEta} without ETA (not in buckets)`);
  document.getElementById('sp_note').textContent = note.join(' · ');

  snapshotToday(res);
  renderRollChart();
  renderChart(res);

  // Ranked table (cheapest first)
  const tb = document.getElementById('sp_tbody');
  tb.innerHTML = res.ladder.length ? res.ladder.map(s => {
    const v = s.v;
    return `<tr style="${s.rated ? '' : 'opacity:.6'}">
      <td style="font-family:var(--mono);font-size:12px;text-align:right">${s.cum}</td>
      <td style="font-weight:600;color:var(--text-bright)">${esc(v.vessel_name)}${v.notes ? ` <span style="cursor:help;color:var(--text-dim);font-size:11px" title="${esc(v.notes)}">ⓘ</span>` : ''}</td>
      <td style="font-family:var(--mono);font-size:12px">${v.dwt ? Math.round(v.dwt / 1000) + 'k' : '?'}/${v.build_year || '?'}</td>
      <td>${v.scrubber ? '<span class="lm-flag" style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--accent-light);color:var(--accent)">S</span>' : ''}</td>
      <td>${esc(v.delivery_basis || '—')}</td>
      <td style="font-family:var(--mono);font-size:12px">${fmtD(v.open_date || v.laycan_date)}</td>
      <td style="font-family:var(--mono);font-size:12px">${fmtD(v.eta_ecsa)}${s.etaDays != null ? ` <span style="color:var(--text-dim)">(${s.etaDays}d)</span>` : ''}</td>
      <td>${esc(v.owner || '—')}</td>
      <td style="text-align:right;font-family:var(--mono);font-size:12px;font-weight:600">${fmtK(s.rated ? s.rate : null)}</td>
      <td style="text-align:right;font-family:var(--mono);font-size:12px;color:var(--amber)">${s.rated ? '' : '~' + fmtK(s.rate).slice(1)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" style="padding:18px;color:var(--text-dim)">No priced ships match the filters.</td></tr>';
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function buildUI() {
  const root = document.getElementById('sp_root');
  if (!root) return;

  // Shared control styles (same look as Pairings; injected here too in case
  // this tab is opened first)
  const style = document.createElement('style');
  style.textContent = `
    .pr-field{display:flex;flex-direction:column;gap:4px}
    .pr-field label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)}
    .pr-field input,.pr-field select{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;padding:7px 10px;outline:none}
    .pr-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:20px;background:var(--bg2);cursor:pointer;user-select:none}
    .pr-check.on{background:var(--accent-light);border-color:var(--accent);color:var(--accent);font-weight:600}
    .pr-table{width:100%;border-collapse:collapse}
    .pr-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--bg2);z-index:1}
    .pr-table td{padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
    .pr-table tr:hover td{background:var(--bg-hover)}
  `;
  document.head.appendChild(style);

  root.innerHTML = `
    <div style="padding:20px 28px">
      <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">Supply Curve</h2>
          <div style="font-size:12px;color:var(--text-dim)">Live from the Tonnage Board · offers on BKI eqvt, unrated ships shown at Arrow eqvt (implied) · buckets = ETA to ECSA</div>
        </div>
      </div>

      <div class="lm-controls" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px">
        <span class="pr-check" id="sp_unrated" title="Include ships without an offer, plotted at Arrow eqvt (implied rate)">Include unrated</span>
        <span class="pr-check" id="sp_scrub">Scrubber only</span>
        <div class="pr-field"><label>Layday from</label><input type="date" id="sp_layFrom" value="${esc(ui.layFrom)}"></div>
        <div class="pr-field"><label>Layday to</label><input type="date" id="sp_layTo" value="${esc(ui.layTo)}"></div>
        <div class="pr-field"><label>ETA from</label><input type="date" id="sp_etaFrom" value="${esc(ui.etaFrom)}"></div>
        <div class="pr-field"><label>ETA to</label><input type="date" id="sp_etaTo" value="${esc(ui.etaTo)}"></div>
        <div class="pr-field"><label>DWT min</label><input type="number" id="sp_minDwt" style="width:80px" value="${esc(ui.minDwt)}"></div>
        <div class="pr-field"><label>DWT max</label><input type="number" id="sp_maxDwt" style="width:80px" value="${esc(ui.maxDwt)}"></div>
        <div class="pr-field"><label title="Draws a dashed reference line — ships under it are below index">P6 today $</label><input type="number" id="sp_p6" style="width:90px" value="${esc(ui.p6Ref)}"></div>
        <div class="pr-field"><label>Search</label><input type="text" id="sp_search" placeholder="vessel / owner / dely" value="${esc(ui.search)}" style="width:160px"></div>
      </div>

      <div id="sp_stats" style="display:flex;gap:10px;margin-bottom:6px;flex-wrap:wrap"></div>
      <div id="sp_note" style="font-size:11px;color:var(--text-dim);margin-bottom:10px"></div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Rolling supply depth</strong>
        <div style="flex:1"></div>
        <span class="pr-check" id="sp_ratedCurve" title="Plot only ships with offers (tracked from today onwards — the imported history counts all ships)">Offers only</span>
        <div id="sp_range" style="display:inline-flex;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">
          ${['3M', '6M', '1Y', 'ALL'].map(r => `<button data-range="${r}" style="border:none;border-right:1px solid var(--border);background:var(--bg2);font-size:11px;padding:6px 12px;cursor:pointer">${r}</button>`).join('')}
        </div>
      </div>
      <div style="height:360px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg2);margin-bottom:18px">
        <canvas id="sp_rollChart"></canvas>
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Price ladder (today)</strong>
      </div>
      <div style="height:340px;border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg2);margin-bottom:14px">
        <canvas id="sp_chart"></canvas>
      </div>

      <div style="overflow:auto;max-height:420px;border:1px solid var(--border);border-radius:var(--radius)">
        <table class="pr-table">
          <thead><tr>
            <th style="text-align:right">#</th><th>Vessel</th><th>DWT/Blt</th><th></th><th>Dely</th>
            <th>Layday</th><th>ETA ECSA</th><th>Owner</th>
            <th style="text-align:right">Offer BKI</th><th style="text-align:right" title="Implied (Arrow eqvt) — not an offer">Implied</th>
          </tr></thead>
          <tbody id="sp_tbody"></tbody>
        </table>
      </div>
    </div>`;

  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  on('sp_layFrom', 'change', e => { ui.layFrom = e.target.value; saveUi(); render(); });
  on('sp_layTo', 'change', e => { ui.layTo = e.target.value; saveUi(); render(); });
  on('sp_etaFrom', 'change', e => { ui.etaFrom = e.target.value; saveUi(); render(); });
  on('sp_etaTo', 'change', e => { ui.etaTo = e.target.value; saveUi(); render(); });
  on('sp_minDwt', 'input', e => { ui.minDwt = e.target.value; saveUi(); render(); });
  on('sp_maxDwt', 'input', e => { ui.maxDwt = e.target.value; saveUi(); render(); });
  on('sp_p6', 'input', e => { ui.p6Ref = e.target.value; saveUi(); render(); });
  on('sp_search', 'input', e => { ui.search = e.target.value; saveUi(); render(); });
  for (const [id, key] of [['sp_unrated', 'includeUnrated'], ['sp_scrub', 'scrubOnly'], ['sp_ratedCurve', 'ratedCurve']]) {
    const el = document.getElementById(id);
    const sync = () => el.classList.toggle('on', !!ui[key]);
    sync();
    el.addEventListener('click', () => { ui[key] = !ui[key]; saveUi(); sync(); render(); });
  }

  // Range buttons for the rolling curve
  const rangeWrap = document.getElementById('sp_range');
  const syncRange = () => rangeWrap.querySelectorAll('button').forEach(b => {
    const on = b.dataset.range === ui.range;
    b.style.background = on ? 'var(--accent)' : 'var(--bg2)';
    b.style.color = on ? '#fff' : 'var(--text)';
    b.style.fontWeight = on ? '600' : '400';
  });
  syncRange();
  rangeWrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    ui.range = b.dataset.range; saveUi(); syncRange(); renderRollChart();
  }));
}

function spInit() {
  if (!SP.initialised) { buildUI(); SP.initialised = true; }
  render();
}

if (IS_BROWSER) {
  const _origSwitchTabSupply = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabSupply) _origSwitchTabSupply(tab);
    if (tab === 'supply') spInit();
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _test: {
      setUi: u => Object.assign(ui, u),
      setVessels: v => { global.vessels = v; },
      computeSupply, computeSupplyPulse,
    },
  };
}

})();
