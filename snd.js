/* ============================================================
   snd.js — S&D tab: one grid, one row per basin, tonnage and cargo
   side by side against their own recent run rate.

   The page puts a number on the sentences from the morning call:
   "Cont is really building", "ECSA FH cargoes are thin", "W Med tonnage
   is low", "lots of minerals out of the USEC". So every row carries
   the basin totals AND a breakdown along the dimensions those
   sentences come from — each with the same count-vs-average read:
     tonnage: zone (Cont vs Baltic, W Med vs E Med), size class
     cargo:   leg (FH / TA), commodity family, destination, charterer
   The headline is drawn from all of them, so whatever moves most
   floats to the top, not a preset list.

   Basins are the cargo book's loading areas. NATL board zones and the
   ECSA board roll onto them (BASIN_ZONES); cargoes land by load port
   zone, then by stem.

   Filters: horizon (prompt 15d / 30d / all laydays) and lookback
   (4 / 8 / 13 weeks) — down vs 4 weeks but flat vs 13 is a blip.

   History:
     cargo   — rebuilt from the book (entered_market → departed_at),
               real from day one, for every breakdown.
     tonnage — daily snapshots posted to /api/snapshot by every browser
               with the boards loaded (max-merged per key), keyed by
               zone and zone~size; a one-off backfill from the old
               per-browser histories. "collecting" until 5 days.
   ============================================================ */

(function () {
'use strict';

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const DAY = 86400000;

// ─── Basins and zones ────────────────────────────────────────────────────────
const BASIN_ZONES = {
  'ECSA': ['ECSA'], 'NCSA': ['NCSA'], 'USG': ['USG'], 'USEC': ['USEC'], 'EC CAN': ['EC CAN'],
  'Cont/Baltic': ['N CONT', 'BALTIC'], 'WAFR': ['WAFR'], 'Bsea/Med': ['W MED', 'E MED', 'BSEA'],
};
const BASINS = Object.keys(BASIN_ZONES);
const ZONE_BASIN = {};
for (const [b, zs] of Object.entries(BASIN_ZONES)) for (const z of zs) ZONE_BASIN[z] = b;
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

// Ship size class from dwt — kmx ≥ 80k, pmx below
function sizeClass(dwt) {
  const n = Number(dwt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 80000 ? 'kmx' : 'pmx';
}

// Commodity family from the book's free text ("grain", "iron ore", "petcoke"...)
const FAMILIES = [
  ['coal', /coal|pet\s?coke|coke|anthracite|lignite/],
  ['fert', /fert|urea|phosph|potash|sulph|sulfur|\bdap\b|\bmap\b|npk|ammonium/],
  ['steel', /steel|scrap|pig\s?iron|\bhbi\b|\bdri\b|billet|slab|coil/],
  ['minerals', /ore|mineral|concentrate|bauxite|mangan|nickel|chrome|alumina|ilmenite|zircon|sand|aggregat|clinker|cement|gypsum|salt|limestone|slag|kaolin|feldspar|quartz/],
  ['grain', /grain|hss|soy|soja|corn|maize|wheat|barley|sorghum|bean|meal|\bsbm\b|pellet|oilseed|rape|canola|sugar|rice|agri|oats|lentil|pea/],
  ['wood', /wood|log|timber|chips|pulp|biomass/],
];
function commodityFamily(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return 'unspecified';
  for (const [fam, re] of FAMILIES) if (re.test(s)) return fam;
  return 'other';
}

// Where a cargo is going, coarsely: an Atlantic zone by port, else a
// region by name. Unknown discharge text stays out of the breakdown.
const DEST_REGIONS = [
  ['Far East', /china|japan|korea|taiwan|qingdao|caofeidian|rizhao|fangcheng|singapore|spore|vietnam|philippin|indonesia|malaysia|thailand|far\s?east|\bfe\b|\bspore\b|s\.?korea|kaohsiung|busan|pusan|kwangyang|chiba|kashima|hong\s?kong|tianjin|dalian|lianyungang|zhoushan|nantong|taicang|jingtang|bayuquan|yantai|ningbo|shanghai|lanshan|zhanjiang|guangzhou|xiamen|manila|ho\s?chi|cai\s?lan|map\s?ta|koh\s?si/],
  ['India/PG', /india|wc\s?india|ec\s?india|kandla|mundra|paradip|vizag|visakh|haldia|chennai|krishnapatnam|gangavaram|tuticorin|mangalore|pakistan|karachi|qasim|bangladesh|chittagong|\bpg\b|persian|arabian|jebel|dammam|jubail|kuwait|bahrain|qatar|oman|sohar|salalah|iran|iraq|umm\s?qasr|red\s?sea|jeddah|yanbu|aqaba|sudan|djibouti|aden|hodeidah|sri\s?lanka|colombo/],
  ['SE Asia/Oz', /austral|newcastle|port\s?kembla|gladstone|nz\b|new\s?zealand|tauranga/],
  ['S Africa', /south\s?africa|s\.?africa|durban|richards|saldanha|cape\s?town|mozambique|maputo|beira|tanzania|kenya|mombasa|dar\s?es/],
  ['Med', /\bmed\b|medit|italy|spain|greece|turkey|egypt|alger|morocco|tunis|libya|israel|lebanon|syria|cyprus|malta|croatia|slovenia|koper|adriatic|black\s?sea|bsea|romania|bulgaria|ukraine|georgia|poti|batumi/],
  ['Cont', /\bcont\b|continent|arag|rotterdam|antwerp|amsterdam|hamburg|bremen|ghent|dunkirk|uk\b|ireland|scandinav|norway|sweden|denmark|finland|poland|baltic|riga|klaipeda|gdansk|gdynia|liepaja|ventspils|lithuania|latvia|estonia|russia|ust\s?luga|st\s?peter/],
  ['Americas', /\busg\b|usec|us\s?gulf|gulf|nola|new\s?orleans|houston|mobile|tampa|norfolk|baltimore|philadelphia|savannah|charleston|canada|montreal|quebec|halifax|caribs?|carib|mexico|colombia|venezuela|brazil|ecsa|argentin|uruguay|chile|peru|ncsa|santos|paranagua|rio\s?grande|itaqui|vitoria|tubarao|buenos|rosario|san\s?lorenzo|bahia\s?blanca/],
  ['W Africa', /wafr|w\.?\s?africa|west\s?africa|nigeria|lagos|ghana|tema|ivory|abidjan|senegal|dakar|guinea|conakry|cameroon|douala|angola|luanda|togo|lome|benin|cotonou|gabon|congo|pointe\s?noire|mauritania|nouakchott/],
];
function destRegion(text, zonesApi) {
  const s = String(text || '').trim();
  if (!s) return null;
  const z = zonesApi ? zonesApi.zoneOfPort(s) : null;
  if (z) return ZONE_LABEL[z] || z;
  const lc = s.toLowerCase();
  for (const [name, re] of DEST_REGIONS) if (re.test(lc)) return name;
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
const LS_BACKFILL = 'snd_backfilled_v2';
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
const ui = Object.assign({ horizon: '30', lookback: '28', detail: true },
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
function zonesApi() {
  return (typeof window !== 'undefined' && window.Zones) || (typeof Zones !== 'undefined' ? Zones : null);
}
function cargoBook() {
  const hist = (typeof cargoHistory !== 'undefined' && Array.isArray(cargoHistory)) ? cargoHistory : [];
  const cur = (typeof cargoCurrent !== 'undefined' && Array.isArray(cargoCurrent)) ? cargoCurrent : [];
  return { hist, cur };
}

// ─── Tonnage now ─────────────────────────────────────────────────────────────
// Counts keyed the way snapshots are stored: zone, and zone~size.
// { key: { open, n15, n30 } } — a ship counts toward n15/n30 when her
// layday/ETA is inside that many days (a passed layday is spot, so it
// counts too); undated ships count only under "all".
const sizeKey = (zone, size) => `${zone}~${size}`;
function tonnageNow(today, src) {
  const t = today || dayStr(Date.now());
  const out = {};
  const bump = (key, dateStr) => {
    const c = out[key] || (out[key] = { open: 0, n15: 0, n30: 0 });
    c.open++;
    if (dateStr) {
      const d = daysBetween(t, dateStr);
      if (d <= 15) c.n15++;
      if (d <= 30) c.n30++;
    }
  };
  const ship = (zone, dwt, dateStr) => {
    bump(zone, dateStr);
    const sz = sizeClass(dwt);
    if (sz) bump(sizeKey(zone, sz), dateStr);
  };
  const ecsa = src && src.ecsa ? src.ecsa : ecsaVessels();
  for (const v of ecsa) {
    if (v.status !== 'OPEN') continue;
    ship('ECSA', v.dwt, v.eta_ecsa ? String(v.eta_ecsa).slice(0, 10) : null);
  }
  const natl = src && src.natl !== undefined ? src.natl : natlData().data;
  const Z = zonesApi();
  if (natl && Array.isArray(natl.vessels) && Z) {
    for (const v of natl.vessels) {
      if (NATL_EXCLUDED.includes(String(v.region || '').toUpperCase())) continue;
      const z = Z.zoneOfVessel(v);
      const basin = basinOfZone(z);
      if (!basin || basin === 'ECSA') continue;   // ECSA comes from the ECSA board
      ship(z, v.dwt, v.lay ? String(v.lay).slice(0, 10) : null);
    }
  }
  return out;
}

// ─── Cargo: spans and daily series ───────────────────────────────────────────
// One span per physical cargo (the history id includes the sheet's stamp,
// so a retouched cargo has several entries): strict union on
// charterer/stem/load/disch/laycan, then chain hand-offs where the old
// entry ends within a day of the new one entering. Same rules as
// computeDemandPulse in cargo.js.
function cargoSpans(hist, cur, today) {
  const t = today || dayStr(Date.now());
  const Z = zonesApi();
  const norm = x => String(x || '').toLowerCase().replace(/\s+/g, '');
  const entries = [];
  for (const c of hist) {
    const start = c.entered_market || c.first_seen;
    if (!start) continue;
    const live = cur.includes(c.id) && !c.fixed;
    const end = live ? t : (c.departed_at || c.last_seen || start);
    const hasSubstance = c.load || c.laycan || c.disch || c.cargo;
    const zone = Z ? Z.zoneOfPort(c.load) : null;
    const basin = basinOfZone(zone) || basinOfStem(c.stem);
    const stemStr = String(c.stem || '');
    const leg = /f(ront)?haul/i.test(stemStr) ? 'FH' : /\bta\b/i.test(stemStr) ? 'TA' : null;
    entries.push({
      start: String(start).slice(0, 10), end: String(end).slice(0, 10), live,
      basin, zone: zone && basinOfZone(zone) === basin ? zone : null, leg,
      family: commodityFamily(c.cargo),
      dest: destRegion(c.disch, Z),
      charterer: String(c.charterer || '').trim().toLowerCase() || null,
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

// Daily counts over the window (oldest → today) for every key a span
// maps to: { key: [{date, n}] }. keyFn returns a key or null.
function seriesBy(spans, keyFn, windowDays, horizonDays, today) {
  const t = today || dayStr(Date.now());
  const todayT = T(t);
  const keyed = spans.map(s => [keyFn(s), s]).filter(x => x[0] != null);
  const out = {};
  for (const [k] of keyed) if (!out[k]) out[k] = [];
  for (let i = windowDays; i >= 0; i--) {
    const d = dayStr(todayT - i * DAY);
    const counts = {};
    for (const [k, s] of keyed) if (spanCounts(s, d, horizonDays)) counts[k] = (counts[k] || 0) + 1;
    for (const k of Object.keys(out)) out[k].push({ date: d, n: counts[k] || 0 });
  }
  return out;
}

// ─── Tonnage history (snapshots) ─────────────────────────────────────────────
function loadSnaps() {
  if (!IS_BROWSER) return {};
  try { return JSON.parse(localStorage.getItem(LS_SNAPS) || '{}'); } catch (e) { return {}; }
}
function saveSnaps(days) { if (IS_BROWSER) localStorage.setItem(LS_SNAPS, JSON.stringify(days)); }

// Merge by max per key per field — a browser with half the data loaded
// never drags a good day down.
function mergeDays(into, from) {
  for (const [date, keys] of Object.entries(from || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !keys) continue;
    const day = into[date] || (into[date] = {});
    for (const [key, c] of Object.entries(keys)) {
      if (!c) continue;
      const cur = day[key] || (day[key] = {});
      for (const f of ['open', 'n15', 'n30']) {
        if (c[f] == null || !Number.isFinite(Number(c[f]))) continue;
        cur[f] = Math.max(cur[f] ?? 0, Math.round(Number(c[f])));
      }
    }
  }
  return into;
}

// The old per-browser histories, translated into snapshot days:
//   nb_basin_history  { date: { zone: n } }         → zone open
//   sp_snapshots + CURVES_SEED { date, next30, ... } → ECSA n30
function legacyBackfill() {
  const days = {};
  if (!IS_BROWSER) return days;
  try {
    const nb = JSON.parse(localStorage.getItem('nb_basin_history') || '{}');
    for (const [date, zones] of Object.entries(nb)) {
      const d = {};
      for (const [zone, n] of Object.entries(zones || {})) {
        if (!basinOfZone(zone) || zone === 'ECSA') continue;
        d[zone] = { open: Number(n) || 0 };
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

// Series over the window from stored days, summing the given keys (gaps
// skipped). A day with none of the keys but a legacy basin-level key
// (first days of snapshots were keyed by basin) uses that instead.
function tonnageSeries(days, keys, field, windowDays, today, legacyKey) {
  const t = today || dayStr(Date.now());
  const from = dayStr(T(t) - windowDays * DAY);
  const out = [];
  for (const d of Object.keys(days).filter(d => d >= from && d < t).sort()) {
    const day = days[d];
    let n = null;
    for (const k of keys) if (day[k] && day[k][field] != null) n = (n || 0) + day[k][field];
    if (n == null && legacyKey && day[legacyKey] && day[legacyKey][field] != null) n = day[legacyKey][field];
    if (n != null) out.push({ date: d, n });
  }
  return out;
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
// One measured thing: now, its history, index, word
function metric(kind, now, series, extra) {
  const m = Object.assign({ now, series, ...indexOf(now, series) }, extra || {});
  m.verdict = verdict(kind, m.idx);
  return m;
}

// ─── Compute the grid ────────────────────────────────────────────────────────
// Breakdown dimensions, each read with the same count-vs-average as the
// totals. Cargo dims come straight from the spans; tonnage dims from the
// live counts + snapshot keys.
const CARGO_DIMS = [
  { key: 'leg', label: 'leg', fn: s => s.leg },
  { key: 'family', label: 'cargo', fn: s => s.family },
  { key: 'dest', label: 'to', fn: s => s.dest, prefix: '→ ' },
  { key: 'charterer', label: 'charterer', fn: s => s.charterer },
];

function computeGrid(opts) {
  const o = opts || {};
  const today = o.today || dayStr(Date.now());
  const H = o.horizon || horizon();
  const L = o.lookback || lookback();
  const tNow = o.tonnageNow || tonnageNow(today);
  const days = o.days || loadSnaps();
  const { hist, cur } = o.book || cargoBook();
  const spans = cargoSpans(hist, cur, today);

  const totalSeries = seriesBy(spans, s => s.basin, L.days, H.days, today);
  const zoneSeries = seriesBy(spans, s => s.zone, L.days, H.days, today);
  const dimSeries = {};
  for (const dim of CARGO_DIMS) dimSeries[dim.key] = seriesBy(spans, s => (s.basin && dim.fn(s) != null) ? s.basin + '|' + dim.fn(s) : null, L.days, H.days, today);

  const fromSeries = (kind, ser) => ser && ser.length ? metric(kind, ser[ser.length - 1].n, ser.slice(0, -1)) : metric(kind, 0, []);
  const tonnageMetric = (keys, legacyKey, extra) => {
    const now = keys.reduce((s, k) => s + ((tNow[k] || {})[H.field] || 0), 0);
    return metric('supply', now, tonnageSeries(days, keys, H.field, L.days, today, legacyKey), extra);
  };

  const rows = BASINS.map(basin => {
    const zones = BASIN_ZONES[basin];
    const supply = tonnageMetric(zones, basin, { open: zones.reduce((s, z) => s + ((tNow[z] || {}).open || 0), 0) });
    supply.dims = {};
    if (zones.length > 1) {
      supply.dims.zone = zones.map(z => Object.assign(tonnageMetric([z], null), { value: ZONE_LABEL[z] || z }))
        .filter(m => m.now || m.avg);
    }
    supply.dims.size = ['kmx', 'pmx'].map(sz => Object.assign(tonnageMetric(zones.map(z => sizeKey(z, sz)), null), { value: sz }))
      .filter(m => m.now || m.avg);

    const demand = fromSeries('demand', totalSeries[basin]);
    demand.dims = {};
    if (zones.length > 1) {
      demand.dims.zone = zones.map(z => Object.assign(fromSeries('demand', zoneSeries[z]), { value: ZONE_LABEL[z] || z }))
        .filter(m => m.now || m.avg);
    }
    for (const dim of CARGO_DIMS) {
      const prefix = basin + '|';
      demand.dims[dim.key] = Object.entries(dimSeries[dim.key])
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, ser]) => Object.assign(fromSeries('demand', ser), { value: k.slice(prefix.length) }))
        .filter(m => m.now || (m.avg != null && m.avg >= 1))
        .sort((a, b) => b.now - a.now || (b.avg || 0) - (a.avg || 0));
    }

    // Balance: cargoes per ship today vs the same ratio on past days
    // where both sides have a reading
    const ratio = supply.now > 0 ? demand.now / supply.now : null;
    const past = [];
    for (const p of supply.series) {
      const dd = demand.series.find(x => x.date === p.date);
      if (dd && p.n > 0) past.push({ date: p.date, n: dd.n / p.n });
    }
    const balance = ratio == null ? { ratio, idx: null, avg: null, sample: past.length, verdict: verdict('balance', null) }
      : Object.assign({ ratio }, metric('balance', ratio, past));
    return { basin, supply, demand, balance };
  });
  return { today, horizon: H, lookback: L, rows };
}

// Headline: the standouts across totals and every breakdown, strongest
// first, with a floor so a 0-to-1 move never leads. One note per basin
// and side: the total if it is notable, plus the strongest breakdown
// only when it says something the total doesn't (a different direction,
// or a slice that isn't just most of the total moving with it).
function headline(grid, max) {
  const note = (m, text) => {
    if (m.idx == null || m.avg == null) return null;
    if (Math.abs(m.idx - 100) < 15 || m.now + m.avg < 4) return null;
    return { mag: Math.abs(m.idx - 100) * Math.log2(1 + m.now + m.avg), dir: Math.sign(m.idx - 100), now: m.now,
      text: `${text} ${m.verdict.word} (${m.now} vs ${m.avg.toFixed(1)} avg)` };
  };
  const DIM_TEXT = {
    zone: (b, v) => v, size: (b, v) => `${b} ${v}`, leg: (b, v) => `${b} ${v}`,
    family: (b, v) => `${b} ${v}`, dest: (b, v) => `${b} → ${v}`, charterer: (b, v) => `${b} ${v}`,
  };
  const notes = [];
  for (const r of grid.rows) {
    for (const [side, word] of [['supply', 'tonnage'], ['demand', 'cargo']]) {
      const m = r[side];
      const total = note(m, `${r.basin} ${word}`);
      const parts = [];
      for (const [dk, list] of Object.entries(m.dims)) for (const x of list) {
        const n = note(x, `${DIM_TEXT[dk](r.basin, x.value)} ${word}`);
        if (n) parts.push(n);
      }
      parts.sort((a, b) => b.mag - a.mag);
      if (total) notes.push(total);
      const best = parts.find(p => !total || p.dir !== total.dir || p.now < 0.7 * total.now);
      if (best) notes.push(best);
    }
  }
  notes.sort((a, b) => b.mag - a.mag);
  return notes.slice(0, max || 5).map(n => n.text);
}

// Short change label: percent against a meaningful average, units against
// a tiny one (+833% on a 0.1 avg reads silly), nothing while collecting
function changeText(m) {
  if (m.idx == null || m.avg == null) return '';
  if (m.avg < 2) { const d = m.now - m.avg; return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1); }
  return (m.idx >= 100 ? '+' : '') + (m.idx - 100) + '%';
}

// WhatsApp text for the call
function buildText(grid) {
  const H = grid.horizon, L = grid.lookback;
  const date = new Date(T(grid.today)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ch = m => { const c = changeText(m); return c ? ` (${c}, ${m.verdict.word})` : ''; };
  const dimLine = (list, n) => list.slice(0, n).map(m => `${m.value} ${m.now}${changeText(m) ? ' ' + changeText(m) : ''}`).join(', ');
  let text = `*S&D SNAPSHOT — ${date}*\n_${H.label.toLowerCase()} · vs ${L.label} avg_\n\n`;
  for (const r of grid.rows) {
    if (!r.supply.now && !r.demand.now && r.supply.idx == null) continue;
    text += `*${r.basin}* — ships ${r.supply.now}${ch(r.supply)} · cargoes ${r.demand.now}${ch(r.demand)}`;
    if (r.balance.idx != null) text += ` · ${r.balance.verdict.word}`;
    text += '\n';
    const bits = [];
    if (r.supply.dims.zone && r.supply.dims.zone.length) bits.push(`ships: ${dimLine(r.supply.dims.zone, 3)}`);
    if (r.demand.dims.leg && r.demand.dims.leg.length) bits.push(dimLine(r.demand.dims.leg, 2));
    if (r.demand.dims.family && r.demand.dims.family.length) bits.push(dimLine(r.demand.dims.family, 3));
    if (bits.length) text += `  _${bits.join(' · ')}_\n`;
  }
  const h = headline(grid, 4);
  if (h.length) text += `\n_${h.join(' · ')}_\n`;
  return text;
}

// ─── Snapshot posting ────────────────────────────────────────────────────────
// Today's tonnage counts go to the server once an hour per browser, and
// the legacy local histories go once ever. Local mirror keeps file:// working.
async function syncSnapshots() {
  if (!IS_BROWSER) return loadSnaps();
  const local = loadSnaps();
  const body = {};
  if (!localStorage.getItem(LS_BACKFILL)) mergeDays(body, legacyBackfill());
  const today = dayStr(Date.now());
  const natl = natlData();
  const ecsa = ecsaVessels();
  // Only snapshot from a browser that actually has data: ECSA board loaded,
  // and the NATL list from the feed (never the July seed)
  if (ecsa.length || natl.fromFeed) {
    const now = tonnageNow(today, { ecsa, natl: natl.fromFeed ? natl.data : null });
    if (Object.keys(now).length) body[today] = now;
  }
  mergeDays(local, body);
  saveSnaps(local);

  if (!/^https?:/.test(location.protocol)) return local;
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

function changeLabel(m) {
  if (m.idx == null) return `<span class="sd-idx sd-dim" title="${m.sample} of ${MIN_SAMPLE} days of history so far">collecting</span>`;
  return `<span class="sd-idx sd-tone-${m.verdict.tone}" title="index ${m.idx}">${esc(changeText(m))}</span>`;
}

// One breakdown line: "FH 8 +45% · TA 2 −10%"
function dimLine(label, list, n, prefix) {
  if (!list || !list.length) return '';
  const chips = list.slice(0, n).map(m => {
    const c = changeText(m);
    return `<span class="sd-chip" title="${esc(m.value)}: ${m.now} now${m.avg != null ? ', avg ' + m.avg.toFixed(1) : ''}">` +
      `${esc((prefix || '') + m.value)} <b>${m.now}</b>${c ? ` <i class="sd-tone-${m.verdict.tone}">${esc(c)}</i>` : ''}</span>`;
  }).join('<span class="sd-dot">·</span>');
  const more = list.length > n ? `<span class="sd-more">+${list.length - n}</span>` : '';
  return `<div class="sd-line"><span class="sd-line-k">${esc(label)}</span>${chips}${more}</div>`;
}

function cell(m, lines) {
  const v = m.verdict;
  return `<div class="sd-cell">
      <div class="sd-now">${m.now}</div>
      <div class="sd-meta">${changeLabel(m)}${m.avg != null ? `<span class="sd-avg">avg ${m.avg.toFixed(1)}</span>` : ''}</div>
      ${sparkline(m.series, v.tone)}
      <div class="sd-word sd-tone-${v.tone}">${esc(v.word)}</div>
    </div>${ui.detail && lines ? `<div class="sd-lines">${lines}</div>` : ''}`;
}

function render() {
  const root = document.getElementById('sd_root');
  if (!root) return;
  const grid = computeGrid({ days: SD.days || loadSnaps() });
  const H = grid.horizon, L = grid.lookback;

  const pills = (list, key) => list.map(x =>
    `<button class="filter-pill${ui[key] === x.key ? ' active' : ''}" data-k="${key}" data-v="${x.key}">${x.label}</button>`).join('');

  const head = headline(grid, 5);
  const rows = grid.rows.map(r => {
    const s = r.supply, d = r.demand, b = r.balance;
    const sLines = dimLine('zone', s.dims.zone, 3) + dimLine('size', s.dims.size, 2);
    const dLines = dimLine('zone', d.dims.zone, 3) + dimLine('leg', d.dims.leg, 2) + dimLine('cargo', d.dims.family, 3)
      + dimLine('to', d.dims.dest, 3) + dimLine('chtr', d.dims.charterer, 3);
    const bal = b.ratio == null
      ? '<div class="sd-cell"><div class="sd-now sd-dim">—</div><div class="sd-word sd-dim">no ships</div></div>'
      : `<div class="sd-cell"><div class="sd-now">${b.ratio.toFixed(2)}</div>
           <div class="sd-meta">${changeLabel(Object.assign({ now: b.ratio }, b))}</div>
           <div class="sd-word sd-tone-${b.verdict.tone}">${esc(b.verdict.word)}</div></div>`;
    return `<tr>
      <td class="sd-basin"><div class="sd-basin-name">${esc(r.basin)}</div>
        <div class="sd-sub">${s.open ? `${s.open} open` : 'no open ships'}${s.open && s.open !== s.now ? `, ${s.now} inside ${esc(H.label.toLowerCase())}` : ''}</div></td>
      <td>${cell(s, sLines)}</td>
      <td>${cell(d, dLines)}</td>
      <td>${bal}</td>
    </tr>`;
  }).join('');

  const snapDays = Object.keys(SD.days || {}).length;
  root.innerHTML = `
    <div class="sd-toolbar">
      <div class="sd-filter"><span class="toolbar-label">Laydays</span>${pills(HORIZONS, 'horizon')}</div>
      <div class="sd-filter"><span class="toolbar-label">Versus</span>${pills(LOOKBACKS, 'lookback')}</div>
      <button class="filter-pill${ui.detail ? ' active' : ''}" id="sd_detail" title="Zone, size, leg, commodity, destination and charterer breakdowns under each cell">Breakdowns</button>
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
    <div class="sd-foot">Every number is read against its own trailing ${esc(L.label)} average (100 = typical). Words: tonnage thin → deep, cargo dried up → busy, balance loose → tight.
      Cargo history is rebuilt from the book for every breakdown; tonnage history is a daily snapshot (${snapDays} days stored) and reads "collecting" until it has ${MIN_SAMPLE}.
      ECSA ships come from the ECSA board, every other basin from the NATL list; cargoes land by load port, then by stem.</div>`;

  root.querySelectorAll('.filter-pill[data-k]').forEach(b => b.addEventListener('click', () => {
    ui[b.dataset.k] = b.dataset.v; saveUi(); render();
  }));
  document.getElementById('sd_detail').addEventListener('click', () => { ui.detail = !ui.detail; saveUi(); render(); });
  const copy = document.getElementById('sd_copy');
  copy.addEventListener('click', () => {
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
    .sd-headline{font-size:13px;color:var(--text-bright);background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:14px;line-height:1.6}
    .sd-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2)}
    .sd-table{width:100%;border-collapse:collapse;min-width:820px}
    .sd-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
    .sd-th-sub{text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-dim);margin-left:6px}
    .sd-table td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top}
    .sd-table tr:last-child td{border-bottom:0}
    .sd-table tr:hover td{background:var(--bg-hover)}
    .sd-basin{width:150px}
    .sd-basin-name{font-weight:600;font-size:14px;color:var(--text-bright)}
    .sd-sub{font-size:11px;color:var(--text-dim);margin-top:2px}
    .sd-cell{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:12px;row-gap:2px;align-items:center;min-width:200px}
    .sd-now{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text-bright);grid-row:1/3;line-height:1;font-variant-numeric:tabular-nums}
    .sd-meta{display:flex;gap:8px;align-items:baseline;font-size:12px}
    .sd-idx{font-family:var(--mono);font-weight:600;font-variant-numeric:tabular-nums}
    .sd-avg{color:var(--text-dim);font-size:11px}
    .sd-word{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;grid-column:1/3}
    .sd-lines{margin-top:6px;display:flex;flex-direction:column;gap:2px}
    .sd-line{font-size:11px;color:var(--text);white-space:nowrap;display:flex;align-items:baseline;gap:5px}
    .sd-line-k{color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:.5px;min-width:34px}
    .sd-chip b{font-family:var(--mono);font-weight:600;color:var(--text-bright)}
    .sd-chip i{font-style:normal;font-family:var(--mono);font-size:10.5px;font-weight:600}
    .sd-dot{color:var(--border2);padding:0 1px}
    .sd-more{color:var(--text-dim);font-size:10px}
    .sd-spark{display:block}
    .sd-spark-empty{width:96px;height:22px;display:inline-block}
    .sd-spark-line{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}
    .sd-spark-fill{fill:currentColor;opacity:.12}
    .sd-spark-dot{fill:currentColor}
    .sd-tone-up{color:var(--accent)} .sd-tone-down{color:var(--amber)} .sd-tone-flat{color:var(--text-dim)} .sd-tone-dim{color:var(--text-dim)}
    .sd-dim{color:var(--text-dim)}
    .sd-foot{font-size:11px;color:var(--text-dim);margin-top:10px;line-height:1.5;max-width:100ch}
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
  // Snapshot today's tonnage even if nobody opens the tab: history only
  // accumulates on days the boards are loaded, whichever tab is showing
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => { syncSnapshots().then(d => { SD.days = d; }); }, 4000));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _test: {
      BASINS, BASIN_ZONES, basinOfZone, basinOfStem, sizeClass, commodityFamily, destRegion, laycanStart,
      tonnageNow, cargoSpans, seriesBy, tonnageSeries, indexOf, verdict, mergeDays, computeGrid, headline, buildText, changeText,
      setUi: u => Object.assign(ui, u),
    },
  };
}

})();
