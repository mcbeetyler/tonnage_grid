/* ============================================================
   snd.js — S&D tab: one grid, one row per basin, supply and demand
   side by side against their own recent run rate.

   "Cont is deep and thin on cargo" should read off a single line:
     basin · open ships (vs 4-wk avg, sparkline, word)
           · live cargoes (vs 4-wk avg, sparkline, word)
           · balance = cargoes per ship vs its own average

   Basins are the cargo book's loading areas. NATL board zones and the
   ECSA board roll onto them (ZONE_BASIN), cargo stems map by prefix.

   Filters: horizon (prompt 15d / 30d / all laydays) and lookback
   (4 / 8 / 13 weeks) — a basin down vs 4 weeks but flat vs 13 is a
   blip; down against both is a shift.

   History:
     demand  — rebuilt from the cargo book (entered_market → departed_at),
               so it is real from day one.
     supply  — daily snapshots posted to /api/snapshot by every browser
               that has the boards loaded (merged by max per basin), plus
               a one-off backfill from the old per-browser histories
               (nb_basin_history, sp_snapshots + CURVES_SEED). Rows show
               "collecting" until they have 5 days of history.
   ============================================================ */

(function () {
'use strict';

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const DAY = 86400000;

// ─── Basins ──────────────────────────────────────────────────────────────────
const BASINS = ['ECSA', 'NCSA', 'USG', 'USEC', 'EC CAN', 'Cont/Baltic', 'WAFR', 'Bsea/Med'];
const ZONE_BASIN = {
  'ECSA': 'ECSA', 'NCSA': 'NCSA', 'USG': 'USG', 'USEC': 'USEC', 'EC CAN': 'EC CAN',
  'N CONT': 'Cont/Baltic', 'BALTIC': 'Cont/Baltic', 'WAFR': 'WAFR',
  'W MED': 'Bsea/Med', 'E MED': 'Bsea/Med', 'BSEA': 'Bsea/Med',
};
const ZONE_LABEL = {
  'N CONT': 'Cont', 'BALTIC': 'Baltic', 'W MED': 'W Med', 'E MED': 'E Med', 'BSEA': 'Bsea',
  'EC CAN': 'EC Can', 'USG': 'USG', 'USEC': 'USEC', 'NCSA': 'NCSA', 'WAFR': 'WAfr', 'ECSA': 'ECSA',
};
const NATL_EXCLUDED = ['GONE', 'FIXED', 'ONSUB', 'IN HOUSE'];

function basinOfZone(zone) { return ZONE_BASIN[String(zone || '').toUpperCase()] || null; }

function basinOfStem(stem) {
  const s = String(stem || '').toLowerCase();
  if (!s) return null;
  if (/ecsa/.test(s)) return 'ECSA';
  if (/ncsa/.test(s)) return 'NCSA';
  if (/usg/.test(s)) return 'USG';
  if (/usec/.test(s)) return 'USEC';
  if (/ec\s?can/.test(s)) return 'EC CAN';
  if (/cont|baltic/.test(s)) return 'Cont/Baltic';
  if (/wafr/.test(s)) return 'WAFR';
  if (/bsea|med/.test(s)) return 'Bsea/Med';
  return null;
}

// ─── Dates (UTC calendar strings, as the cargo book uses) ────────────────────
const dayStr = t => new Date(t).toISOString().slice(0, 10);
const T = d => new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime();
const daysBetween = (from, to) => Math.round((T(to) - T(from)) / DAY);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// First day of a laycan ("15-30 Jul", "1jul onw", "early aug") as an ISO
// date. The year is whichever puts the date nearest the day the cargo
// entered the market — a Jan laycan quoted in December is next year's.
function laycanStart(laycan, refDate) {
  if (!laycan) return null;
  const lc = String(laycan).toLowerCase().replace(/\s+/g, '');
  let day = null, mon = null;
  const pair = lc.match(/(\d{1,2})[^a-z]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (pair) { day = parseInt(pair[1], 10); mon = MONTHS.indexOf(pair[2]); }
  else {
    const m = lc.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
    if (!m) return null;
    mon = MONTHS.indexOf(m[1]);
    day = /end|late|lh|2h/.test(lc) ? 16 : 1;
  }
  if (day < 1 || day > 31) return null;
  const ref = refDate ? T(refDate) : Date.now();
  const refYear = new Date(ref).getUTCFullYear();
  let best = null, bestGap = Infinity;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const t = Date.UTC(y, mon, Math.min(day, 28));
    const gap = Math.abs(t - ref);
    if (gap < bestGap) { bestGap = gap; best = Date.UTC(y, mon, day); }
  }
  return best == null ? null : dayStr(best);
}

// ─── UI state ────────────────────────────────────────────────────────────────
const LS_UI = 'snd_ui';
const LS_SNAPS = 'snd_snapshots';       // local mirror of /api/snapshot
const LS_BACKFILL = 'snd_backfilled';
const HORIZONS = [
  { key: '15', label: 'Prompt (15d)', days: 15, field: 'n15' },
  { key: '30', label: '30 days', days: 30, field: 'n30' },
  { key: 'all', label: 'All dates', days: null, field: 'open' },
];
const LOOKBACKS = [
  { key: '28', label: '4 wk', days: 28 },
  { key: '56', label: '8 wk', days: 56 },
  { key: '91', label: '13 wk', days: 91 },
];
const ui = Object.assign({ horizon: '30', lookback: '28' },
  IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }
const horizon = () => HORIZONS.find(h => h.key === ui.horizon) || HORIZONS[1];
const lookback = () => LOOKBACKS.find(l => l.key === ui.lookback) || LOOKBACKS[0];

// ─── Data access ─────────────────────────────────────────────────────────────
function ecsaVessels() {
  return (typeof vessels !== 'undefined' && Array.isArray(vessels)) ? vessels : [];
}
// NATL list: the feed's copy in localStorage, else the committed seed.
// The seed is a snapshot from July — fine for a look, never for a snapshot.
function natlData() {
  if (IS_BROWSER) {
    try { const s = localStorage.getItem('lm_data'); if (s) return { data: JSON.parse(s), fromFeed: true }; } catch (e) { /* ignore */ }
    if (window.NA_SEED) return { data: window.NA_SEED, fromFeed: false };
  }
  return { data: null, fromFeed: false };
}
function zoneOf(v) {
  const Z = (typeof window !== 'undefined' && window.Zones) || (typeof Zones !== 'undefined' ? Zones : null);
  return Z ? Z.zoneOfVessel(v) : null;
}
function cargoBook() {
  const hist = (typeof cargoHistory !== 'undefined' && Array.isArray(cargoHistory)) ? cargoHistory : [];
  const cur = (typeof cargoCurrent !== 'undefined' && Array.isArray(cargoCurrent)) ? cargoCurrent : [];
  return { hist, cur };
}

// ─── Supply now ──────────────────────────────────────────────────────────────
// { basin: { open, n15, n30, zones: { zone: n } } } — a ship counts toward
// n15/n30 when her layday/ETA is inside that many days (a passed layday is
// spot, so it counts too); undated ships count only under "all".
function supplyNow(today, src) {
  const t = today || dayStr(Date.now());
  const out = {};
  const bump = (basin, zone, dateStr) => {
    const b = out[basin] || (out[basin] = { open: 0, n15: 0, n30: 0, zones: {} });
    b.open++;
    b.zones[zone] = (b.zones[zone] || 0) + 1;
    if (dateStr) {
      const d = daysBetween(t, dateStr);
      if (d <= 15) b.n15++;
      if (d <= 30) b.n30++;
    }
  };
  const ecsa = src && src.ecsa ? src.ecsa : ecsaVessels();
  for (const v of ecsa) {
    if (v.status !== 'OPEN') continue;
    bump('ECSA', 'ECSA', v.eta_ecsa ? String(v.eta_ecsa).slice(0, 10) : null);
  }
  const natl = src && src.natl !== undefined ? src.natl : natlData().data;
  if (natl && Array.isArray(natl.vessels)) {
    for (const v of natl.vessels) {
      if (NATL_EXCLUDED.includes(String(v.region || '').toUpperCase())) continue;
      const z = zoneOf(v);
      const basin = basinOfZone(z);
      if (!basin || basin === 'ECSA') continue;   // ECSA comes from the ECSA board
      bump(basin, z, v.lay ? String(v.lay).slice(0, 10) : null);
    }
  }
  return out;
}

// ─── Demand: spans and daily series ──────────────────────────────────────────
// One span per physical cargo (the history id includes the sheet's stamp,
// so a retouched cargo has several entries): strict union on
// charterer/stem/load/disch/laycan, then chain hand-offs where the old
// entry ends within a day of the new one entering. Same rules as
// computeDemandPulse in cargo.js.
function demandSpans(hist, cur, today) {
  const t = today || dayStr(Date.now());
  const norm = x => String(x || '').toLowerCase().replace(/\s+/g, '');
  const entries = [];
  for (const c of hist) {
    const start = c.entered_market || c.first_seen;
    if (!start) continue;
    const live = cur.includes(c.id) && !c.fixed;
    const end = live ? t : (c.departed_at || c.last_seen || start);
    const hasSubstance = c.load || c.laycan || c.disch || c.cargo;
    let basin = basinOfStem(c.stem);
    if (!basin && c.load) basin = basinOfZone((typeof window !== 'undefined' && window.Zones) ? window.Zones.zoneOfPort(c.load) : null);
    const stemStr = String(c.stem || '');
    const leg = /f(ront)?haul/i.test(stemStr) ? 'FH' : /\bta\b/i.test(stemStr) ? 'TA' : null;
    entries.push({
      start: String(start).slice(0, 10), end: String(end).slice(0, 10), live, basin, leg,
      laycan: laycanStart(c.laycan, start),
      strictKey: hasSubstance ? [c.charterer, c.stem, c.load, c.disch, c.laycan].map(norm).join('|') : 'id:' + c.id,
      looseKey: hasSubstance ? [c.charterer, c.stem, c.load, c.disch].map(norm).join('|') : 'id:' + c.id,
    });
  }
  const strict = {};
  for (const e of entries) {
    const p = strict[e.strictKey];
    if (!p) strict[e.strictKey] = Object.assign({}, e);
    else {
      if (e.start < p.start) p.start = e.start;
      if (e.end > p.end) p.end = e.end;
      p.live = p.live || e.live;
    }
  }
  const groups = {};
  for (const s of Object.values(strict)) (groups[s.looseKey] = groups[s.looseKey] || []).push(s);
  const spans = [];
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.start < b.start ? -1 : 1);
    let curSpan = null;
    for (const s of list) {
      if (curSpan && Math.abs(T(s.start) - T(curSpan.end)) <= DAY) {
        if (s.end > curSpan.end) curSpan.end = s.end;
        curSpan.live = curSpan.live || s.live;
        if (s.laycan) curSpan.laycan = s.laycan;   // the retouch carries the current laycan
      } else {
        if (curSpan) spans.push(curSpan);
        curSpan = Object.assign({}, s);
      }
    }
    if (curSpan) spans.push(curSpan);
  }
  return spans;
}

// Was this span on the book on day d, and inside the horizon as seen from d?
function spanCounts(s, d, horizonDays) {
  const onBook = s.live
    ? (s.start <= d && d <= s.end)
    : (s.start === s.end ? d === s.start : (s.start <= d && d < s.end));
  if (!onBook) return false;
  if (horizonDays == null) return true;
  if (!s.laycan) return false;                       // undated: "all" only
  return daysBetween(d, s.laycan) <= horizonDays;
}

// Daily live-cargo count per basin over the window: { basin: [{date, n}] }
function demandSeries(spans, windowDays, horizonDays, today) {
  const t = today || dayStr(Date.now());
  const todayT = T(t);
  const out = {};
  for (const b of BASINS) out[b] = [];
  for (let i = windowDays; i >= 0; i--) {
    const d = dayStr(todayT - i * DAY);
    const counts = {};
    for (const s of spans) {
      if (!s.basin || !spanCounts(s, d, horizonDays)) continue;
      counts[s.basin] = (counts[s.basin] || 0) + 1;
    }
    for (const b of BASINS) out[b].push({ date: d, n: counts[b] || 0 });
  }
  return out;
}

function demandNow(spans, horizonDays, today) {
  const t = today || dayStr(Date.now());
  const out = {};
  for (const s of spans) {
    if (!s.basin || !spanCounts(s, t, horizonDays)) continue;
    const b = out[s.basin] || (out[s.basin] = { n: 0, FH: 0, TA: 0 });
    b.n++;
    if (s.leg) b[s.leg]++;
  }
  return out;
}

// ─── Supply history (snapshots) ──────────────────────────────────────────────
function loadSnaps() {
  if (!IS_BROWSER) return {};
  try { return JSON.parse(localStorage.getItem(LS_SNAPS) || '{}'); } catch (e) { return {}; }
}
function saveSnaps(days) { if (IS_BROWSER) localStorage.setItem(LS_SNAPS, JSON.stringify(days)); }

// Merge by max per basin per field — a browser with half the data loaded
// never drags a good day down.
function mergeDays(into, from) {
  for (const [date, basins] of Object.entries(from || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !basins) continue;
    const day = into[date] || (into[date] = {});
    for (const [basin, c] of Object.entries(basins)) {
      if (!c) continue;
      const cur = day[basin] || (day[basin] = {});
      for (const f of ['open', 'n15', 'n30']) {
        if (c[f] == null || !Number.isFinite(Number(c[f]))) continue;
        cur[f] = Math.max(cur[f] ?? 0, Math.round(Number(c[f])));
      }
    }
  }
  return into;
}

// The old per-browser histories, translated into snapshot days:
//   nb_basin_history  { date: { zone: n } }         → basin open
//   sp_snapshots + CURVES_SEED { date, next30, ... } → ECSA n30
function legacyBackfill() {
  const days = {};
  if (!IS_BROWSER) return days;
  try {
    const nb = JSON.parse(localStorage.getItem('nb_basin_history') || '{}');
    for (const [date, zones] of Object.entries(nb)) {
      const d = {};
      for (const [zone, n] of Object.entries(zones || {})) {
        const b = basinOfZone(zone);
        if (!b || b === 'ECSA') continue;
        d[b] = d[b] || { open: 0 };
        d[b].open += Number(n) || 0;
      }
      if (Object.keys(d).length) days[date] = d;
    }
  } catch (e) { /* ignore */ }
  try {
    const seed = window.CURVES_SEED || [];
    const sp = JSON.parse(localStorage.getItem('sp_snapshots') || '{}');
    const rows = seed.map(h => [h.date, h]).concat(Object.entries(sp));
    for (const [date, h] of rows) {
      if (h && h.next30 != null) {
        days[date] = days[date] || {};
        days[date].ECSA = Object.assign(days[date].ECSA || {}, { n30: Number(h.next30) });
      }
    }
  } catch (e) { /* ignore */ }
  return days;
}

// Series for a basin/field over the window from stored days (gaps skipped)
function supplySeries(days, basin, field, windowDays, today) {
  const t = today || dayStr(Date.now());
  const from = dayStr(T(t) - windowDays * DAY);
  return Object.keys(days).filter(d => d >= from && d < t).sort()
    .map(d => ({ date: d, n: days[d][basin] && days[d][basin][field] != null ? days[d][basin][field] : null }))
    .filter(x => x.n != null);
}

// ─── Index + words ───────────────────────────────────────────────────────────
const MIN_SAMPLE = 5;
function indexOf(now, past) {
  const vals = past.map(p => p.n).filter(n => n != null);
  if (vals.length < MIN_SAMPLE) return { idx: null, avg: null, sample: vals.length };
  const avg = vals.reduce((s, n) => s + n, 0) / vals.length;
  return { idx: avg > 0 ? Math.round(now / avg * 100) : (now > 0 ? 999 : 100), avg, sample: vals.length };
}
const WORDS = {
  supply: ['thin', 'thinning', 'steady', 'building', 'deep'],
  demand: ['dried up', 'quiet', 'steady', 'building', 'busy'],
  balance: ['loose', 'loosening', 'balanced', 'tightening', 'tight'],
};
function verdict(kind, idx) {
  if (idx == null) return { word: 'collecting', tone: 'dim' };
  const w = WORDS[kind];
  if (idx >= 130) return { word: w[4], tone: 'up' };
  if (idx >= 112) return { word: w[3], tone: 'up' };
  if (idx > 88) return { word: w[2], tone: 'flat' };
  if (idx > 70) return { word: w[1], tone: 'down' };
  return { word: w[0], tone: 'down' };
}

// ─── Compute the grid ────────────────────────────────────────────────────────
function computeGrid(opts) {
  const o = opts || {};
  const today = o.today || dayStr(Date.now());
  const H = o.horizon || horizon();
  const L = o.lookback || lookback();
  const sNow = o.supplyNow || supplyNow(today);
  const days = o.days || loadSnaps();
  const { hist, cur } = o.book || cargoBook();
  const spans = demandSpans(hist, cur, today);
  const dNow = demandNow(spans, H.days, today);
  const dSeries = demandSeries(spans, L.days, H.days, today);

  const rows = BASINS.map(basin => {
    const s = sNow[basin] || { open: 0, n15: 0, n30: 0, zones: {} };
    const sVal = s[H.field] || 0;
    const sPast = supplySeries(days, basin, H.field, L.days, today);
    const sIdx = indexOf(sVal, sPast);
    const d = dNow[basin] || { n: 0, FH: 0, TA: 0 };
    const dPast = dSeries[basin].slice(0, -1);
    const dIdx = indexOf(d.n, dPast);
    // Balance: cargoes per ship today vs the same ratio on past days where
    // both sides have a reading
    const ratio = sVal > 0 ? d.n / sVal : null;
    const past = [];
    for (const p of sPast) {
      const dd = dPast.find(x => x.date === p.date);
      if (dd && p.n > 0) past.push({ date: p.date, n: dd.n / p.n });
    }
    const bIdx = ratio == null ? { idx: null, sample: past.length } : indexOf(ratio, past);
    return {
      basin, supply: { now: sVal, open: s.open, zones: s.zones, series: sPast, ...sIdx, verdict: verdict('supply', sIdx.idx) },
      demand: { now: d.n, FH: d.FH, TA: d.TA, series: dSeries[basin], ...dIdx, verdict: verdict('demand', dIdx.idx) },
      balance: { ratio, ...bIdx, verdict: verdict('balance', bIdx.idx) },
    };
  });
  return { today, horizon: H, lookback: L, rows };
}

// Headline: the standouts, strongest first
function headline(grid) {
  const notes = [];
  for (const r of grid.rows) {
    if (r.supply.idx != null && Math.abs(r.supply.idx - 100) >= 15 && r.supply.now + r.supply.avg >= 4) notes.push({ mag: Math.abs(r.supply.idx - 100), text: `${r.basin} tonnage ${r.supply.verdict.word} (${r.supply.now} vs ${r.supply.avg.toFixed(0)} avg)` });
    if (r.demand.idx != null && Math.abs(r.demand.idx - 100) >= 15 && r.demand.now + r.demand.avg >= 4) notes.push({ mag: Math.abs(r.demand.idx - 100), text: `${r.basin} cargo ${r.demand.verdict.word} (${r.demand.now} vs ${r.demand.avg.toFixed(0)} avg)` });
  }
  notes.sort((a, b) => b.mag - a.mag);
  return notes.slice(0, 4).map(n => n.text);
}

// WhatsApp text for the call
function buildText(grid) {
  const H = grid.horizon, L = grid.lookback;
  const date = new Date(T(grid.today)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const idx = x => x.idx == null ? '—' : x.idx;
  let text = `*S&D SNAPSHOT — ${date}*\n_${H.label.toLowerCase()} · vs ${L.label} avg (100 = typical)_\n\n`;
  for (const r of grid.rows) {
    if (!r.supply.now && !r.demand.now && r.supply.idx == null) continue;
    text += `*${r.basin}* — ships ${r.supply.now} (${idx(r.supply)}, ${r.supply.verdict.word}) · cargoes ${r.demand.now} (${idx(r.demand)}, ${r.demand.verdict.word})`;
    if (r.balance.idx != null) text += ` · ${r.balance.verdict.word}`;
    text += '\n';
  }
  const h = headline(grid);
  if (h.length) text += `\n_${h.join(' · ')}_\n`;
  return text;
}

// ─── Snapshot posting ────────────────────────────────────────────────────────
// Today's supply counts go to the server once an hour per browser, and the
// legacy local histories go once ever. Local mirror keeps file:// working.
async function syncSnapshots() {
  if (!IS_BROWSER) return loadSnaps();
  const local = loadSnaps();
  const body = {};
  if (!localStorage.getItem(LS_BACKFILL)) {
    mergeDays(body, legacyBackfill());
  }
  const today = dayStr(Date.now());
  const natl = natlData();
  const ecsa = ecsaVessels();
  // Only snapshot from a browser that actually has data: ECSA board loaded,
  // and the NATL list from the feed (never the July seed)
  if (ecsa.length || natl.fromFeed) {
    const now = supplyNow(today, { ecsa, natl: natl.fromFeed ? natl.data : null });
    const day = {};
    for (const [b, c] of Object.entries(now)) day[b] = { open: c.open, n15: c.n15, n30: c.n30 };
    if (Object.keys(day).length) body[today] = day;
  }
  mergeDays(local, body);
  saveSnaps(local);

  const isHttp = /^https?:/.test(location.protocol);
  if (!isHttp) return local;
  try {
    const stamp = localStorage.getItem('snd_posted') || '';
    const hour = new Date().toISOString().slice(0, 13);
    if (Object.keys(body).length && stamp !== hour) {
      const r = await fetch('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: body }) });
      if (r.ok) {
        localStorage.setItem('snd_posted', hour);
        localStorage.setItem(LS_BACKFILL, '1');
      }
    }
    const g = await fetch('/api/snapshot');
    if (g.ok) {
      const j = await g.json();
      mergeDays(local, j.days || {});
      saveSnaps(local);
    }
  } catch (e) { /* offline: local mirror stands */ }
  return local;
}

// ─── Render ──────────────────────────────────────────────────────────────────
const SD = { initialised: false, days: null };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function sparkline(series, tone) {
  const pts = series.map(p => p.n).filter(n => n != null);
  if (pts.length < 2) return '<span class="sd-spark sd-spark-empty"></span>';
  const W = 96, Hh = 22, pad = 2;
  const max = Math.max(...pts, 1), min = Math.min(...pts, 0);
  const x = i => pad + i * (W - 2 * pad) / (pts.length - 1);
  const y = n => Hh - pad - (n - min) * (Hh - 2 * pad) / (max - min || 1);
  const d = pts.map((n, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(n).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="sd-spark sd-tone-${tone}" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" aria-hidden="true">` +
    `<path d="${d} L${x(pts.length - 1).toFixed(1)} ${Hh - pad} L${pad} ${Hh - pad} Z" class="sd-spark-fill"/>` +
    `<path d="${d}" class="sd-spark-line"/>` +
    `<circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2" class="sd-spark-dot"/></svg>`;
}

// A percent against a tiny average reads silly (+833% on 0.1 avg), so
// below an average of 2 the change is shown in units instead
function changeLabel(m) {
  if (m.idx == null) return `<span class="sd-idx sd-dim" title="${m.sample} of ${MIN_SAMPLE} days of history so far">collecting</span>`;
  const tone = m.verdict.tone;
  if (m.avg != null && m.avg < 2) {
    const d = m.now - m.avg;
    return `<span class="sd-idx sd-tone-${tone}" title="index ${m.idx}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}</span>`;
  }
  return `<span class="sd-idx sd-tone-${tone}">${m.idx >= 100 ? '+' : ''}${m.idx - 100}%</span>`;
}

function cell(kind, m) {
  const v = m.verdict;
  const idx = changeLabel(m);
  const avg = m.avg == null ? '' : `<span class="sd-avg">avg ${m.avg.toFixed(1)}</span>`;
  return `<div class="sd-cell">
      <div class="sd-now">${m.now}</div>
      <div class="sd-meta">${idx}${avg}</div>
      ${sparkline(m.series, v.tone)}
      <div class="sd-word sd-tone-${v.tone}">${esc(v.word)}</div>
    </div>`;
}

function render() {
  const root = document.getElementById('sd_root');
  if (!root) return;
  const grid = computeGrid({ days: SD.days || loadSnaps() });
  const H = grid.horizon, L = grid.lookback;

  const pills = (list, key) => list.map(x =>
    `<button class="filter-pill${ui[key] === x.key ? ' active' : ''}" data-k="${key}" data-v="${x.key}">${x.label}</button>`).join('');

  const head = headline(grid);
  const rows = grid.rows.map(r => {
    const zones = Object.entries(r.supply.zones).sort((a, b) => b[1] - a[1])
      .map(([z, n]) => `${ZONE_LABEL[z] || z} ${n}`).join(' · ');
    const legs = [r.demand.FH ? `FH ${r.demand.FH}` : '', r.demand.TA ? `TA ${r.demand.TA}` : ''].filter(Boolean).join(' · ');
    const b = r.balance;
    const bal = b.ratio == null
      ? '<div class="sd-cell"><div class="sd-now sd-dim">—</div><div class="sd-word sd-dim">no ships</div></div>'
      : `<div class="sd-cell"><div class="sd-now">${b.ratio.toFixed(2)}</div>
           <div class="sd-meta">${changeLabel(Object.assign({ now: b.ratio }, b))}</div>
           <div class="sd-word sd-tone-${b.verdict.tone}">${esc(b.verdict.word)}</div></div>`;
    return `<tr>
      <td class="sd-basin"><div class="sd-basin-name">${esc(r.basin)}</div>
        <div class="sd-sub">${esc(zones || (r.supply.open ? '' : 'no open ships'))}</div>
        <div class="sd-sub">${esc(legs)}</div></td>
      <td>${cell('supply', r.supply)}</td>
      <td>${cell('demand', r.demand)}</td>
      <td>${bal}</td>
    </tr>`;
  }).join('');

  const snapDays = Object.keys(SD.days || {}).length;
  root.innerHTML = `
    <div class="sd-toolbar">
      <div class="sd-filter"><span class="toolbar-label">Laydays</span>${pills(HORIZONS, 'horizon')}</div>
      <div class="sd-filter"><span class="toolbar-label">Versus</span>${pills(LOOKBACKS, 'lookback')}</div>
      <div class="sd-spacer"></div>
      <button class="filter-pill" id="sd_copy">Copy for WhatsApp</button>
    </div>
    ${head.length ? `<div class="sd-headline">${head.map(esc).join(' <span class="sd-dim">·</span> ')}</div>` : ''}
    <div class="sd-wrap"><table class="sd-table">
      <thead><tr>
        <th>Basin</th>
        <th>Tonnage <span class="sd-th-sub">open ships, ${esc(H.label.toLowerCase())}</span></th>
        <th>Cargo <span class="sd-th-sub">live cargoes, ${esc(H.label.toLowerCase())}</span></th>
        <th>Balance <span class="sd-th-sub">cargoes per ship</span></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="sd-foot">Change is against the trailing ${esc(L.label)} average, index 100 = typical for that basin.
      Cargo history is rebuilt from the book; tonnage history is a daily snapshot (${snapDays} days stored) and reads "collecting" until a basin has ${MIN_SAMPLE}.
      ECSA ships come from the ECSA board, every other basin from the NATL list.</div>`;

  root.querySelectorAll('.filter-pill[data-k]').forEach(b => b.addEventListener('click', () => {
    ui[b.dataset.k] = b.dataset.v; saveUi(); render();
  }));
  const copy = document.getElementById('sd_copy');
  if (copy) copy.addEventListener('click', () => {
    const text = buildText(grid);
    const done = () => { copy.textContent = '✓ copied'; setTimeout(() => { copy.textContent = 'Copy for WhatsApp'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done); else done();
  });
}

function injectCss() {
  if (document.getElementById('sd_css')) return;
  const st = document.createElement('style');
  st.id = 'sd_css';
  st.textContent = `
    #sd_root{padding:18px 28px 40px}
    .sd-toolbar{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
    .sd-filter{display:flex;gap:6px;align-items:center}
    .sd-spacer{flex:1}
    .sd-headline{font-size:13px;color:var(--text-bright);background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:14px;line-height:1.5}
    .sd-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2)}
    .sd-table{width:100%;border-collapse:collapse;min-width:720px}
    .sd-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
    .sd-th-sub{text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-dim);margin-left:6px}
    .sd-table td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top}
    .sd-table tr:last-child td{border-bottom:0}
    .sd-table tr:hover td{background:var(--bg-hover)}
    .sd-basin{width:180px}
    .sd-basin-name{font-weight:600;font-size:14px;color:var(--text-bright)}
    .sd-sub{font-size:11px;color:var(--text-dim);margin-top:2px;white-space:nowrap}
    .sd-cell{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:12px;row-gap:2px;align-items:center;min-width:200px}
    .sd-now{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text-bright);grid-row:1/3;line-height:1;font-variant-numeric:tabular-nums}
    .sd-meta{display:flex;gap:8px;align-items:baseline;font-size:12px}
    .sd-idx{font-family:var(--mono);font-weight:600;font-variant-numeric:tabular-nums}
    .sd-avg{color:var(--text-dim);font-size:11px}
    .sd-word{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;grid-column:1/3}
    .sd-spark{display:block}
    .sd-spark-empty{width:96px;height:22px;display:inline-block}
    .sd-spark-line{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}
    .sd-spark-fill{fill:currentColor;opacity:.12}
    .sd-spark-dot{fill:currentColor}
    .sd-tone-up{color:var(--accent)} .sd-tone-down{color:var(--amber)} .sd-tone-flat{color:var(--text-dim)} .sd-tone-dim{color:var(--text-dim)}
    .sd-dim{color:var(--text-dim)}
    .sd-foot{font-size:11px;color:var(--text-dim);margin-top:10px;line-height:1.5;max-width:90ch}
  `;
  document.head.appendChild(st);
}

async function sdInit() {
  if (!SD.initialised) { injectCss(); SD.initialised = true; }
  render();                                   // paint with what we have
  SD.days = await syncSnapshots();            // then with the server's history
  render();
}

if (IS_BROWSER) {
  const _origSwitchTabSd = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabSd) _origSwitchTabSd(tab);
    if (tab === 'snd') sdInit();
  };
  // Snapshot today's supply even if nobody opens the tab: history only
  // accumulates on days the boards are loaded, whichever tab is showing
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => { syncSnapshots().then(d => { SD.days = d; }); }, 4000));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _test: {
      BASINS, basinOfZone, basinOfStem, laycanStart, supplyNow, demandSpans, demandSeries, demandNow,
      supplySeries, indexOf, verdict, mergeDays, computeGrid, headline, buildText,
      setUi: u => Object.assign(ui, u),
    },
  };
}

})();
