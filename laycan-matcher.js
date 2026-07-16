/* ============================================================
   laycan-matcher.js — "Laycan Matcher" tab
   Which ships in the North Atlantic position list can make a
   cargo's laycan at a given load port?

   Data source: the NORTH ATLANTIC TONNAGE sheet ("NEW MAINVIEW" +
   "Distances"), delivered by the Google Sheets feed (feeds.js →
   applyNatlFeed, stored in localStorage key lm_data). Seed snapshot
   in na-seed.js for first boot.

   ETA convention (mirrors the master sheet):
     ballast days = distance / speed / 24 * 1.08   (8% sea margin)
     ETA          = vessel open date (layfrom) + ballast days
   Option (default ON): departure clamped to today if the vessel's
   open date is already in the past.

   NB: the master sheet's Ust Luga ETA column reuses the Rouen
   ballast time ($AX2) — a formula bug. This module computes each
   port from its own distance.
   ============================================================ */

(function () {
'use strict';

// Shared fit logic (fit-utils.js): browser global or CJS require in tests
const FU = (typeof FitUtils !== 'undefined') ? FitUtils
  : (typeof require === 'function' ? require('./fit-utils.js') : null);
// Port → zone mapping (zones.js): geography from the dely port itself,
// sheet region tag as fallback
const ZN = (typeof Zones !== 'undefined') ? Zones
  : (typeof require === 'function' ? require('./zones.js') : null);
function vesselZone(v) { return ZN.zoneOfVessel(v) || '—'; }

const SEA_MARGIN = 1.08;
const EXCLUDED_REGIONS = ['GONE', 'FIXED', 'ONSUB'];
const NON_GEO_REGIONS = EXCLUDED_REGIONS.concat(['IN HOUSE']);
const DAYS_TO_NM_SPEED = 13; // "9.5d" input converts to NM at this speed
const LS_KEY = 'lm_data';
const LS_UI = 'lm_ui';
const LS_CUSTOM = 'lm_custom';

// Port display order: NA/Continent loading areas first
const PORT_ORDER = ['Rouen', 'Ust Luga', 'NORFOLK', 'Nola', 'Yuzhny', 'Itaqui', 'San Lorenzo',
  'Santos', 'Rio grande', 'Kamsar', 'Gibraltar', 'PASSERO', 'PORT SAID', 'RBCT', 'ASTORIA', 'SEATTLE', 'VANCOUVER'];

// Loads at these ports are fronthaul business (via ECSA) → show the FH offer;
// everything else on this desk is transatlantic → show the TA offer.
const FH_PORTS = ['Itaqui', 'Santos', 'San Lorenzo', 'Rio grande', 'Kamsar', 'RBCT', 'Qingdao'];
function offerSide() {
  const p = ui.port.startsWith('custom:') ? '' : ui.port;
  return FH_PORTS.includes(p) ? 'FH' : 'TA';
}
function offerOf(v) {
  return offerSide() === 'FH'
    ? { rate: v.rate_fh, bb: v.bb_fh, other: v.rate_ta }
    : { rate: v.rate_ta, bb: v.bb_ta, other: v.rate_fh };
}

// Destination columns with fewer dely-port rows than this are dropped (empty Capesize stubs)
const MIN_PORT_COVERAGE = 20;

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

let LM = { data: null, initialised: false };
let ui = Object.assign({
  port: 'Rouen', layFrom: '', layTo: '', extraDays: 0, tolDays: 2, waitTolDays: 2,
  clampToday: true, grainOnly: false, scrubOnly: false, fhOnly: false,
  includeGone: false, showAll: false, search: '', minDwt: '', maxDwt: '', maxAge: '',
  regionFilter: 'ALL', tierFilter: 'ALL', showAdv: false,
  sortKey: 'fit', sortDir: 1,
  seaMarginPct: 8, fixedSpeed: '', // fixedSpeed empty = per-vessel ballast speed

}, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
// Migration: stored UI from before the FIT/EARLY split — adopt the new default sort
if (IS_BROWSER && !JSON.parse(localStorage.getItem(LS_UI) || '{}').hasOwnProperty('waitTolDays')) ui.sortKey = 'fit';

function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

// ─── Custom load areas ───────────────────────────────────────────────────────
// A custom area (e.g. "NCSA bss Pto Drummond") resolves distance per vessel:
//   1. regionNm[vessel zone]  — your NM constant from that opening zone
//   2. else base port distance + offsetNm  — route-offset rough guide
// Input "9.5d" in the editor = days at 13 kn, converted to NM on save.
let customAreas = IS_BROWSER ? JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]') : [];
function saveCustom() { if (IS_BROWSER) localStorage.setItem(LS_CUSTOM, JSON.stringify(customAreas)); }
function getArea(portKey) {
  if (!portKey || !portKey.startsWith('custom:')) return null;
  const nm = portKey.slice(7);
  return customAreas.find(a => a.name === nm) || null;
}
function vesselZones() {
  const seen = new Map();
  if (LM.data) for (const v of LM.data.vessels) {
    const raw = (v.region || '').toUpperCase();
    if (NON_GEO_REGIONS.includes(raw)) continue;   // status, not geography
    const z = vesselZone(v);
    if (z && z !== '—') seen.set(z, (seen.get(z) || 0) + 1);
  }
  for (const a of customAreas) for (const z in (a.regionNm || {})) if (!seen.has(z)) seen.set(z, 0);
  return [...seen.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
}
function parseNmInput(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^([\d.]+)\s*d(ays?)?$/);
  if (m) return Math.round(parseFloat(m[1]) * 24 * DAYS_TO_NM_SPEED);
  const f = parseFloat(t.replace(/,/g, ''));
  return isNaN(f) ? null : Math.round(f);
}

// ─── Desk corrections ────────────────────────────────────────────────────────
// Tyler-supplied facts that beat estimates. Add lines here as they come up.
//
// Dely-port aliases: same water, different label — resolve to the matrix's
// name so all its distances apply.
const DELY_ALIASES = {
  'pdm': 'itaqui', 'ponta da madeira': 'itaqui',   // PDM ≡ Itaqui (same complex)
  'colon': 'cristobal', 'panama': 'cristobal',
};
// Known distances the matrix lacks, in NM. Convention: desk quotes in days
// are expected passage incl weather at ~13 kn, so NM = days × 13 × 24 / 1.08
// (the engine re-applies its 8% margin).
const DESK_DISTANCES = {
  'cristobal': { 'Itaqui': 2600 },     // "Cristobal→Itaqui is 9 days" — Tyler
  'balboa': { 'Itaqui': 2650 },        // Cristobal + canal transit
};
function resolveDelyKey(delyPort) {
  const k = (delyPort || '').toLowerCase().trim();
  return DELY_ALIASES[k] || k;
}

// ─── Zone-median distance estimate ───────────────────────────────────────────
// Dely port not in the matrix? Estimate: median distance of KNOWN same-zone
// ports to the target. Cristobal borrows from the NCSA cluster, Mississippi
// river from USG. Honest rough guide (±1-2 days) — always marked ~.
const _zoneEstCache = new Map();
function medianOfGroup(groupOf, groupKey, targetPort) {
  const samples = [];
  for (const [dp, dists] of Object.entries(LM.data.distances)) {
    if (groupOf(dp) !== groupKey) continue;
    const d = dists[targetPort];
    if (d && d > 0) samples.push(d);
  }
  if (samples.length < 3) return null;   // thinner than 3 ports = too rough even for us
  samples.sort((a, b) => a - b);
  return { d: samples[Math.floor(samples.length / 2)], n: samples.length,
    lo: samples[0], hi: samples[samples.length - 1] };
}
function zoneEstimate(v, targetPort) {
  if (!LM.data || !ZN) return null;
  const key = (LM.data.imported_at || '') + '|' + (v.dely_port || v.region || '') + '|' + targetPort;
  if (_zoneEstCache.has(key)) return _zoneEstCache.get(key);
  let out = null;
  // 1. Fine cluster first (PANAMA / N BRAZIL / CARIB RIM / normal zones) —
  //    tight geography, trustworthy median
  const cluster = v.dely_port ? ZN.estClusterOfPort(v.dely_port) : null;
  if (cluster && !EXCLUDED_REGIONS.includes(cluster)) {
    const m = medianOfGroup(dp => ZN.estClusterOfPort(dp), cluster, targetPort);
    if (m) out = { d: m.d, n: m.n, zone: cluster, wide: false };
  }
  // 2. Zone-wide fallback — kept visible but flagged low-confidence when the
  //    zone's spread is big (a wide zone median can be days off)
  if (!out) {
    const zone = ZN.zoneOfVessel(v);
    if (zone && !EXCLUDED_REGIONS.includes(zone)) {
      const m = medianOfGroup(dp => ZN.zoneOfPort(dp), zone, targetPort);
      if (m) out = { d: m.d, n: m.n, zone, lo: m.lo, hi: m.hi,
        wide: (m.hi - m.lo) > Math.max(600, m.d * 0.5) };
    }
  }
  _zoneEstCache.set(key, out);
  return out;
}

// ─── Data loading ────────────────────────────────────────────────────────────
function loadData() {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored) { LM.data = JSON.parse(stored); return; }
  } catch (e) { /* fall through to seed */ }
  if (window.NA_SEED) LM.data = window.NA_SEED;
}

function storeData(data) {
  LM.data = data;
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); }
  catch (e) { console.warn('lm: localStorage full, running from memory only', e); }
}

// ─── xlsx import (SheetJS) ───────────────────────────────────────────────────
function excelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') { // excel serial
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  // ISO string (JSON-serialised Date from the Google Sheets feed)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}
function s(v) { return (v == null) ? null : String(v).trim() || null; }
function n(v) { const f = parseFloat(v); return isNaN(f) ? null : f; }

// Core parser over plain row arrays — fed by the Google Sheets feed
// (rows arrive as JSON via feeds.js → LaycanMatcher.applyNatlFeed).
function parseArrays(vrows, drows, sourceLabel) {
  // Distances: header on 2nd row, dely port in col B.
  // Destinations: main block C..AG, plus extra named columns further right
  // (mostly empty Capesize stubs — kept only if coverage >= MIN_PORT_COVERAGE).
  const hdr = drows[1] || [];
  const SKIP = /eca|^row$|^region$|zone|cal$|passage|ballast|canal|^miles|^time$|^cost$/i;
  let ports = [];
  for (let ci = 2; ci <= 32; ci++) {
    const nm = s(hdr[ci]);
    if (nm && !SKIP.test(nm)) ports.push([nm, ci]);
  }
  for (let ci = 45; ci < Math.min(hdr.length, 75); ci++) {
    const nm = s(hdr[ci]);
    if (nm && !SKIP.test(nm)) ports.push([nm, ci]);
  }
  // Coverage pass
  const coverage = {};
  for (let ri = 2; ri < drows.length; ri++) {
    const r = drows[ri]; if (!r || !s(r[1])) continue;
    for (const [pname, ci] of ports) {
      const v = n(r[ci]);
      if (v && v > 0) coverage[pname] = (coverage[pname] || 0) + 1;
    }
  }
  ports = ports.filter(([pname]) => (coverage[pname] || 0) >= MIN_PORT_COVERAGE);

  const distances = {}, port_regions = {};
  for (let ri = 2; ri < drows.length; ri++) {
    const r = drows[ri]; if (!r) continue;
    const dp = s(r[1]); if (!dp) continue;
    const key = dp.toLowerCase();
    if (distances[key]) continue; // dup dely-port rows: keep first (Excel VLOOKUP behaviour)
    const d = {};
    for (const [pname, ci] of ports) {
      const v = n(r[ci]);
      if (v && v > 0) d[pname] = Math.round(v);
    }
    distances[key] = d;
    port_regions[key] = s(r[0]);
  }

  // NEW MAINVIEW: fixed column positions (0-based), header on row 1
  const PRE = [['Rouen', 49], ['Ust Luga', 52], ['NORFOLK', 55], ['Itaqui', 58], ['Nola', 61], ['Yuzhny', 64], ['San Lorenzo', 67]];
  const vessels = [];
  for (let ri = 1; ri < vrows.length; ri++) {
    const r = vrows[ri]; if (!r) continue;
    const name = s(r[4]), dwt = n(r[19]);
    if (!name || !dwt) continue; // divider / region rows
    const pre = {};
    for (const [pname, ci] of PRE) { const d = n(r[ci]); if (d && d > 0) pre[pname] = Math.round(d); }
    vessels.push({
      name, dwt_yr: s(r[5]), dely_port: s(r[6]), laycan_str: s(r[7]),
      owner: s(r[8]), comments: s(r[9]),
      grain_clean: !!r[3], fh_candidate: !!r[10], scrubber: !!r[11],
      lay: excelDate(r[12]), can: excelDate(r[13]),
      region: s(r[17]), dwt, draft: n(r[20]),
      built: n(r[21]) ? Math.round(n(r[21])) : null, cubic: n(r[23]),
      ballast_speed: n(r[48]), pre_dist: pre,
      imo: s(r[70]), updated: excelDate(r[1]), user: s(r[2]),
      // Offers (phase 2): TA and FH rates + ballast bonuses where quoted
      rate_ta: n(r[71]), bb_ta: n(r[72]), rate_fh: n(r[73]), bb_fh: n(r[74]),
    });
  }
  return {
    imported_at: new Date().toISOString().slice(0, 10),
    source: sourceLabel || 'imported xlsx', ports: ports.map(p => p[0]),
    distances, port_regions, vessels,
  };
}

// ─── Laycan parsing (delegates to shared fit-utils) ──────────────────────────
function parseLaycanWindow(str) { return FU.parseLaycanWindow(str); }

function matchPortName(text) {
  if (!text || !LM.data) return null;
  const t = text.toLowerCase();
  const aliases = {
    'rouen': 'Rouen', 'ust luga': 'Ust Luga', 'ustluga': 'Ust Luga',
    'norfolk': 'NORFOLK', 'hampton': 'NORFOLK', 'nola': 'Nola', 'new orleans': 'Nola', 'mississippi': 'Nola', 'usg': 'Nola', 'miss river': 'Nola',
    'yuzhny': 'Yuzhny', 'pivdennyi': 'Yuzhny', 'itaqui': 'Itaqui', 'pdm': 'Itaqui', 'ponta da madeira': 'Itaqui',
    'san lorenzo': 'San Lorenzo', 'up river': 'San Lorenzo', 'upriver': 'San Lorenzo',
    'santos': 'Santos', 'rio grande': 'Rio grande', 'kamsar': 'Kamsar', 'gibraltar': 'Gibraltar', 'passero': 'PASSERO', 'port said': 'PORT SAID', 'rbct': 'RBCT', 'richards bay': 'RBCT',
  };
  const available = (LM.data.ports || []);
  // exact/substring match against actual destination port names first
  for (const p of available) if (t.includes(p.toLowerCase())) return p;
  for (const k in aliases) if (t.includes(k) && available.includes(aliases[k])) return aliases[k];
  // custom areas: match on name or any word >= 4 chars
  for (const a of customAreas) {
    const an = a.name.toLowerCase();
    if (t.includes(an) || an.includes(t)) return 'custom:' + a.name;
    for (const w of an.split(/[\s,\/·-]+/)) if (w.length >= 4 && t.includes(w)) return 'custom:' + a.name;
  }
  return null;
}
function portLabel(portKey) { return portKey && portKey.startsWith('custom:') ? portKey.slice(7) + ' ~' : portKey; }

// ─── Core match ──────────────────────────────────────────────────────────────
function computeRows() {
  const d = LM.data;
  if (!d) return [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const layTo = ui.layTo ? new Date(ui.layTo + 'T23:59:59Z') : null;
  const layFrom = ui.layFrom ? new Date(ui.layFrom + 'T00:00:00Z') : null;
  const extra = (parseFloat(ui.extraDays) || 0) * 86400000;

  const rows = [];
  for (const v of d.vessels) {
    const region = (v.region || '').toUpperCase();
    if (!ui.includeGone && EXCLUDED_REGIONS.includes(region)) continue;
    if (ui.regionFilter !== 'ALL' && vesselZone(v) !== ui.regionFilter) continue;
    if (ui.grainOnly && !v.grain_clean) continue;
    if (ui.scrubOnly && !v.scrubber) continue;
    if (ui.fhOnly && !v.fh_candidate) continue;
    if (ui.minDwt && v.dwt < parseFloat(ui.minDwt)) continue;
    if (ui.maxDwt && v.dwt > parseFloat(ui.maxDwt)) continue;
    if (ui.maxAge && v.built && (today.getUTCFullYear() - v.built) > parseFloat(ui.maxAge)) continue;
    if (ui.search) {
      const hay = [v.name, v.owner, v.dely_port, v.region, v.comments].join(' ').toLowerCase();
      if (!hay.includes(ui.search.toLowerCase())) continue;
    }

    const key = resolveDelyKey(v.dely_port);
    const lookup = p => (d.distances[key] && d.distances[key][p]) || (v.pre_dist && v.pre_dist[p])
      || (DESK_DISTANCES[key] && DESK_DISTANCES[key][p]) || null;
    const area = getArea(ui.port);
    let dist = null, distSrc = 'matrix', estN = null, estZone = null, estWide = false, estLo = null, estHi = null;
    if (area) {
      const zone = vesselZone(v);
      if (area.regionNm && area.regionNm[zone] != null) { dist = area.regionNm[zone]; distSrc = 'zone'; }
      else if (area.base) {
        const b = lookup(area.base);
        if (b != null) { dist = b + (area.offsetNm || 0); distSrc = 'offset'; }
      }
    } else {
      dist = lookup(ui.port);
      if (dist == null) {
        // Unknown dely port — zone-median estimate keeps the ship in play
        const est = zoneEstimate(v, ui.port);
        if (est) { dist = est.d; distSrc = 'zoneest'; estN = est.n; estZone = est.zone; estWide = !!est.wide; estLo = est.lo || null; estHi = est.hi || null; }
      }
    }
    const speed = (parseFloat(ui.fixedSpeed) > 0) ? parseFloat(ui.fixedSpeed) : (v.ballast_speed || 13);
    const margin = 1 + (parseFloat(ui.seaMarginPct) >= 0 ? parseFloat(ui.seaMarginPct) : 8) / 100;

    let eta = null, ballastDays = null, departs = null, clamped = false;
    if (dist && v.lay) {
      ballastDays = dist / speed / 24 * margin;
      departs = new Date(v.lay + 'T00:00:00Z');
      if (ui.clampToday && departs < today) { departs = today; clamped = true; }
      eta = new Date(departs.getTime() + ballastDays * 86400000 + extra);
    }

    const { status, marginDays, waitDays } = FU.fitStatus(eta, layFrom, layTo,
      { waitTolDays: ui.waitTolDays, tightTolDays: ui.tolDays });

    const offer = offerOf(v);
    rows.push({ v, dist, distSrc, speed, ballastDays, eta, clamped, status, marginDays, waitDays, offer, estN, estZone, estWide, estLo, estHi });
  }

  const dir = ui.sortDir;
  const key = ui.sortKey;
  const FIT_ORDER = FU.FIT_ORDER;
  rows.sort((a, b) => {
    const val = r => {
      switch (key) {
        // fit-first, then shortest ballast (cheapest to deliver) within each tier
        case 'fit': return (FIT_ORDER[r.status] ?? 9) * 10000 + (r.ballastDays != null ? r.ballastDays : 9999);
        // fit-first, then cheapest offer (priced ships before unpriced)
        case 'offer': return (FIT_ORDER[r.status] ?? 9) * 1e9 + (r.offer.rate != null ? r.offer.rate : 9e8);
        case 'ballast': return r.ballastDays != null ? r.ballastDays : Infinity;
        case 'eta': return r.eta ? r.eta.getTime() : Infinity;
        case 'margin': return r.marginDays == null ? -Infinity : r.marginDays;
        case 'dwt': return r.v.dwt || 0;
        case 'built': return r.v.built || 0;
        case 'open': return r.v.lay || '9999';
        case 'name': return r.v.name || '';
        default: return r.eta ? r.eta.getTime() : Infinity;
      }
    };
    const av = val(a), bv = val(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
  return rows;
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function fmtD(dt) {
  if (!dt) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
function fmtDStr(str) {
  if (!str) return '—';
  return fmtD(new Date(str + 'T00:00:00Z'));
}
function esc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Share/export text (for principals — internal comments deliberately excluded)
function describeRow(r, oneLine) {
  const v = r.v;
  const dwtBlt = v.dwt_yr || `${Math.round((v.dwt || 0) / 1000)},000/${v.built || '?'}`;
  const openTxt = v.lay ? fmtDStr(v.lay) + (v.can ? '-' + fmtDStr(v.can) : '') : (v.laycan_str || '?');
  const flags = [v.grain_clean ? 'grain clean' : '', v.scrubber ? 'scrubber' : ''].filter(Boolean).join(', ');
  const portLbl = portLabel(ui.port).replace(' ~', '');
  const etaTxt = r.eta ? fmtD(r.eta) : 'n/a';
  const speedTxt = r.speed ? `${r.speed.toFixed(1)}kn` : '';
  const offer = r.offer && r.offer.rate != null
    ? `$${r.offer.rate.toLocaleString()}${r.offer.bb ? ' + $' + r.offer.bb.toLocaleString() + ' bb' : ''} ${offerSide()}`
    : null;
  let fitTxt = '';
  if (ui.layTo && r.marginDays != null) {
    if (r.status === 'FIT' || r.status === 'EARLY') fitTxt = `makes ${fmtDStr(ui.layFrom)}-${fmtDStr(ui.layTo)} laycan (${r.marginDays.toFixed(1)}d spare${r.waitDays ? `, arrives ${r.waitDays.toFixed(1)}d early` : ''})`;
    else if (r.status === 'TIGHT') fitTxt = `tight for ${fmtDStr(ui.layFrom)}-${fmtDStr(ui.layTo)} (misses cancelling by ${(-r.marginDays).toFixed(1)}d)`;
  }
  if (oneLine) {
    return `${(v.name || '').toUpperCase()} ${dwtBlt} — open ${v.dely_port || '?'} ${openTxt}` +
      ` — ETA ${portLbl} ${etaTxt}${offer ? ` — ${offer}` : ''}`;
  }
  const lines = [
    `MV ${(v.name || '').toUpperCase()} — ${dwtBlt}${v.owner ? ' — ' + v.owner.toUpperCase() : ''}`,
    `Open ${v.dely_port || '?'} ${openTxt}${flags ? ' · ' + flags : ''}`,
    `ETA ${portLbl} ${etaTxt}` + (r.dist ? ` (${r.dist.toLocaleString()}nm${speedTxt ? ' @ ' + speedTxt : ''})` : '') + (fitTxt ? ` — ${fitTxt}` : ''),
  ];
  if (offer) lines.push(`Offer ${offer}`);
  return lines.join('\n');
}

function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const t = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = t; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* give up quietly */ }
  document.body.removeChild(ta);
  done();
}

const BADGE = {
  FIT: ['FITS', '#fff', 'var(--green)'],
  EARLY: ['EARLY', 'var(--blue)', 'var(--blue-light)'],
  TIGHT: ['TIGHT', 'var(--amber)', 'var(--amber-light)'],
  MISSES: ['MISSES', 'var(--red)', 'var(--red-light)'],
  ETA: ['ETA', 'var(--accent)', 'var(--accent-light)'],
  NODATA: ['NO DIST', 'var(--text-dim)', 'var(--bg3)'],
};

function render() {
  const root = document.getElementById('lm_root');
  if (!root || !LM.initialised) return;
  const d = LM.data;
  if (!d) {
    root.querySelector('#lm_tbody').innerHTML = '<tr><td colspan="14" style="padding:20px;color:var(--text-dim)">No position data. Drop the NORTH ATLANTIC TONNAGE xlsx above.</td></tr>';
    return;
  }

  const rows = computeRows();
  const hasLaycan = !!ui.layTo;
  const visible = rows.filter(r => {
    if (ui.tierFilter !== 'ALL') return r.status === ui.tierFilter;
    if (!hasLaycan) return true;
    if (ui.showAll) return true;
    return r.status === 'FIT' || r.status === 'EARLY' || r.status === 'TIGHT';
  });

  // Region pills (counts respect all filters except the region itself)
  const pillWrap = document.getElementById('lm_regionPills');
  if (pillWrap) {
    const saveRegion = ui.regionFilter;
    ui.regionFilter = 'ALL';
    const allRows = computeRows();
    ui.regionFilter = saveRegion;
    const counts = {};
    allRows.forEach(r => { const g = vesselZone(r.v); counts[g] = (counts[g] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    pillWrap.innerHTML = [['ALL', allRows.length]].concat(entries).map(([g, c]) =>
      `<button class="filter-pill ${ui.regionFilter === g ? 'active' : ''}" data-region="${esc(g)}">${esc(g)} <span class="filter-count">${c}</span></button>`).join('');
    pillWrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      ui.regionFilter = ui.regionFilter === b.dataset.region ? 'ALL' : b.dataset.region;
      saveUi(); render();
    }));
  }

  // Cheapest delivery: shortest ballast among genuinely fixable ships (FIT/TIGHT).
  // Shorter ballast = fewer bunkers burnt getting to the load = lower rate/BB needed.
  const fixable = visible.filter(r => (r.status === 'FIT' || r.status === 'TIGHT') && r.ballastDays != null)
    .sort((a, b) => a.ballastDays - b.ballastDays);
  fixable.forEach((r, i) => { r.cheap = i < 3; });

  // Stats — clickable: click a tier card to see only that tier
  const cnt = st => rows.filter(r => r.status === st).length;
  const statEl = document.getElementById('lm_stats');
  statEl.innerHTML = [
    ['Candidates', rows.length, 'ALL'],
    ['Fits (≤' + (ui.waitTolDays || 0) + 'd wait)', hasLaycan ? cnt('FIT') : '—', 'FIT'],
    ['Early (long wait)', hasLaycan ? cnt('EARLY') : '—', 'EARLY'],
    ['Tight (+' + (ui.tolDays || 0) + 'd)', hasLaycan ? cnt('TIGHT') : '—', 'TIGHT'],
    ['Miss', hasLaycan ? cnt('MISSES') : '—', 'MISSES'],
    ['No distance', cnt('NODATA'), 'NODATA'],
  ].map(([l, v, tier]) => `<div class="stat lm-tier" data-tier="${tier}" title="Click to show only these ships" style="min-width:90px;padding:8px 16px;cursor:pointer${ui.tierFilter === tier && tier !== 'ALL' ? ';border-color:var(--accent);background:var(--accent-light)' : ''}"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px">${v}</div></div>`).join('');
  statEl.querySelectorAll('.lm-tier').forEach(el => el.addEventListener('click', () => {
    const t = el.dataset.tier;
    ui.tierFilter = (ui.tierFilter === t || t === 'ALL') ? 'ALL' : t;
    saveUi(); render();
  }));

  // Remember what's on screen for the copy handlers
  LM.visibleRows = visible;

  // Table
  const tb = root.querySelector('#lm_tbody');
  if (!visible.length) {
    tb.innerHTML = `<tr><td colspan="14" style="padding:20px;color:var(--text-dim)">No vessels ${hasLaycan ? 'make this laycan — toggle "Show all" to see the misses.' : 'match the current filters.'}</td></tr>`;
  } else {
    tb.innerHTML = visible.map((r, i) => {
      const [label, fg, bg] = BADGE[r.status];
      const flags = [
        r.v.grain_clean ? '<span class="lm-flag" title="Grain clean">G</span>' : '',
        r.v.scrubber ? '<span class="lm-flag" title="Scrubber fitted">S</span>' : '',
        r.v.fh_candidate ? '<span class="lm-flag" title="FH candidate">FH</span>' : '',
      ].join('');
      const marginTxt = r.marginDays == null ? '—'
        : (r.marginDays >= 0 ? '+' : '') + r.marginDays.toFixed(1) + 'd';
      const marginColor = r.marginDays == null ? 'var(--text-dim)' : r.marginDays >= 0 ? 'var(--green)' : 'var(--red)';
      const waitTxt = r.waitDays ? `<span style="color:var(--text-dim)" title="Arrives before layfrom — idle days">wait ${r.waitDays.toFixed(1)}d</span>` : '';
      const openTxt = r.v.lay ? fmtDStr(r.v.lay) + (r.v.can ? '–' + fmtDStr(r.v.can) : '') : esc(r.v.laycan_str || '—');
      return `<tr>
        <td><span class="lm-badge" style="color:${fg};background:${bg}">${label}</span></td>
        <td style="font-weight:600;color:var(--text-bright)">${esc(r.v.name)}${r.v.comments ? ` <span class="lm-info" title="${esc(r.v.comments)}">ⓘ</span>` : ''}</td>
        <td style="font-family:var(--mono);font-size:12px">${esc(r.v.dwt_yr || (Math.round(r.v.dwt / 1000) + 'k/' + (r.v.built || '?')))}</td>
        <td>${flags || ''}</td>
        <td>${esc(r.v.dely_port || '—')}</td>
        <td style="font-family:var(--mono);font-size:12px">${openTxt}${r.clamped ? ' <span title="Open date in the past — departure assumed today" style="color:var(--amber)">▸today</span>' : ''}</td>
        <td>${esc(r.v.owner || '—')}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px" title="${r.distSrc === 'zone' ? 'From your zone constant (' + esc(r.v.region || '') + ')' : r.distSrc === 'offset' ? 'Base port + offset — rough guide' : r.distSrc === 'zoneest' ? 'Dely port not in the distances matrix — estimated as the median of ' + r.estN + ' known ' + esc(r.estZone || '') + ' ports' + (r.estWide ? '. WIDE SPREAD (' + r.estLo.toLocaleString() + '–' + r.estHi.toLocaleString() + 'nm) — verify before relying on this ETA' : ' (±1-2d)') : 'Distances matrix'}">${r.dist ? (r.distSrc !== 'matrix' ? '~' : '') + r.dist.toLocaleString() + (r.estWide ? '<span style="color:var(--amber)" title="wide-spread estimate">⚠</span>' : '') : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${r.speed ? r.speed.toFixed(1) : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;${r.cheap ? 'color:var(--green);font-weight:700' : ''}">${r.cheap ? '<span title="Top-3 shortest ballast among fixable ships — cheapest delivery for the charterer">$</span> ' : ''}${r.ballastDays != null ? r.ballastDays.toFixed(1) : '—'}</td>
        <td style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text-bright)">${fmtD(r.eta)}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;font-weight:600" title="${r.offer.rate != null ? offerSide() + ' offer' + (r.offer.bb ? ' + BB $' + r.offer.bb.toLocaleString() : '') + (r.offer.other != null ? ' · other side $' + r.offer.other.toLocaleString() : '') : 'no offer on the sheet'}">${r.offer.rate != null ? '$' + r.offer.rate.toLocaleString() + (r.offer.bb ? '<span style="color:var(--text-dim);font-weight:400">+bb</span>' : '') : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;color:${marginColor}">${marginTxt} ${waitTxt}</td>
        <td><button class="lm-mini lm-copy" data-copy="${i}" title="Copy a share-ready description for the principal (internal comments excluded)">📋</button></td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('.lm-copy').forEach(b => b.addEventListener('click', () => {
      const r = LM.visibleRows[parseInt(b.dataset.copy, 10)];
      if (r) copyText(describeRow(r, false), b);
    }));
  }

  const src = document.getElementById('lm_source');
  if (src) src.textContent = `${d.vessels.length} vessels · data as of ${d.imported_at}${d.source === 'imported xlsx' ? ' (imported)' : ' (seed)'}`;
}

// ─── UI wiring ───────────────────────────────────────────────────────────────
function buildUI() {
  const root = document.getElementById('lm_root');
  if (!root) return;

  const style = document.createElement('style');
  style.textContent = `
    .lm-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:12px}
    .lm-field{display:flex;flex-direction:column;gap:4px}
    .lm-field label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)}
    .lm-field input,.lm-field select{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;padding:7px 10px;outline:none}
    .lm-field input:focus,.lm-field select:focus{border-color:var(--accent)}
    .lm-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:20px;background:var(--bg2);cursor:pointer;user-select:none}
    .lm-check.on{background:var(--accent-light);border-color:var(--accent);color:var(--accent);font-weight:600}
    .lm-badge{font-size:10px;font-weight:700;letter-spacing:.5px;padding:3px 8px;border-radius:10px;white-space:nowrap}
    .lm-flag{display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--accent-light);color:var(--accent);margin-right:3px}
    .lm-info{cursor:help;color:var(--text-dim);font-size:11px}
    .lm-table{width:100%;border-collapse:collapse}
    .lm-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;position:sticky;top:0;background:var(--bg2);z-index:1}
    .lm-table td{padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
    .lm-table tr:hover td{background:var(--bg-hover)}
    .lm-drop{border:1.5px dashed var(--border2);border-radius:var(--radius);padding:8px 14px;font-size:12px;color:var(--text-dim);cursor:pointer;transition:all .15s}
    .lm-drop.over{border-color:var(--accent);background:var(--accent-light);color:var(--accent)}
    .lm-mini{border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;font-size:11px;padding:4px 10px}
    .lm-mini:hover{border-color:var(--accent);color:var(--accent)}
  `;
  document.head.appendChild(style);

  const portOpts = () => {
    const ports = (LM.data && LM.data.ports) || PORT_ORDER;
    const ordered = PORT_ORDER.filter(p => ports.includes(p)).concat(ports.filter(p => !PORT_ORDER.includes(p)));
    let html = ordered.map(p => `<option value="${esc(p)}"${p === ui.port ? ' selected' : ''}>${esc(p)}</option>`).join('');
    if (customAreas.length) {
      html += '<optgroup label="Custom areas">' + customAreas.map(a => {
        const val = 'custom:' + a.name;
        return `<option value="${esc(val)}"${val === ui.port ? ' selected' : ''}>${esc(a.name)} ~</option>`;
      }).join('') + '</optgroup>';
    }
    return html;
  };

  root.innerHTML = `
    <div style="padding:20px 28px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">NATL Matcher</h2>
          <div style="font-size:12px;color:var(--text-dim)">North Atlantic list — no declared ETAs here, so arrival is <b>computed</b>: open date + ballast at chosen speed &amp; sea margin · for ECSA board ships (declared ETAs, priced) use ECSA Pairings</div>
        </div>
        <div class="spacer" style="flex:1"></div>
        <span id="lm_source" style="font-size:11px;color:var(--text-dim)"></span>
        <button class="lm-mini" id="lm_copyFits" style="padding:7px 14px" title="Copy a share-ready shortlist of every FITS ship on screen — one line each, internal comments excluded">Copy fits 📋</button>
      </div>

      <div class="lm-controls">
        <div class="lm-field"><label>Cargo (from Cargo Book)</label>
          <div style="display:flex;gap:4px">
            <select id="lm_cargoPick" style="max-width:260px"><option value="">— manual entry —</option></select>
            <button id="lm_toPairings" class="lm-mini" style="display:none;white-space:nowrap" title="Check the same cargo against ECSA board ships (declared ETAs, priced)">ECSA ⇢</button>
          </div></div>
        <div class="lm-field"><label>Load port / area</label>
          <div style="display:flex;gap:4px">
            <select id="lm_port">${portOpts()}</select>
            <button id="lm_custBtn" title="Manage custom load areas (NCSA, one-off ports…)" style="border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;padding:0 9px;font-size:14px">✎</button>
          </div></div>
        <div class="lm-field"><label>Laycan from</label><input type="date" id="lm_layFrom" value="${esc(ui.layFrom)}"></div>
        <div class="lm-field"><label>Cancelling</label><input type="date" id="lm_layTo" value="${esc(ui.layTo)}"></div>
        <div class="lm-field"><label>Search</label><input type="text" id="lm_search" placeholder="vessel / owner / port" value="${esc(ui.search)}" style="width:170px"></div>
        <span class="lm-check" id="lm_advBtn" title="Tolerances, speed & margin, size/age limits, flag filters">⚙ More filters</span>
      </div>

      <div id="lm_advanced" class="lm-controls" style="gap:6px;display:${ui.showAdv ? 'flex' : 'none'};border:1px dashed var(--border);border-radius:var(--radius);padding:10px 12px;background:var(--bg3)">
        <div class="lm-field"><label title="One-off port: extra steaming days vs the selected base port (+/-)">± days (one-off port)</label>
          <input type="number" id="lm_extra" step="0.5" style="width:80px" value="${ui.extraDays || 0}"></div>
        <div class="lm-field"><label title="Max days a ship can arrive before layfrom and still count as FITS — few owners will wait longer for free">Max wait (d)</label>
          <input type="number" id="lm_waitTol" step="0.5" min="0" style="width:70px" value="${ui.waitTolDays}"></div>
        <div class="lm-field"><label>Tight tolerance (d)</label>
          <input type="number" id="lm_tol" step="0.5" min="0" style="width:70px" value="${ui.tolDays}"></div>
        <div class="lm-field"><label title="Weather/routing allowance added to sea time. Sheet convention 8%; Netpas-style estimators often 5%">Sea margin %</label>
          <input type="number" id="lm_margin" step="1" min="0" max="25" style="width:70px" value="${ui.seaMarginPct}"></div>
        <div class="lm-field"><label title="Blank = each vessel's own warranted ballast speed. Enter a figure (e.g. 11.7) to force one speed for all">Speed kn</label>
          <input type="number" id="lm_speed" step="0.1" min="8" max="18" style="width:90px" placeholder="per vessel" value="${esc(ui.fixedSpeed)}"></div>
        <div class="lm-field"><label>DWT min</label><input type="number" id="lm_minDwt" style="width:80px" value="${esc(ui.minDwt)}"></div>
        <div class="lm-field"><label>DWT max</label><input type="number" id="lm_maxDwt" style="width:80px" value="${esc(ui.maxDwt)}"></div>
        <div class="lm-field"><label>Max age</label><input type="number" id="lm_maxAge" style="width:70px" value="${esc(ui.maxAge)}"></div>
        <span class="lm-check" id="lm_grain">Grain clean</span>
        <span class="lm-check" id="lm_scrub">Scrubber</span>
        <span class="lm-check" id="lm_fh">FH candidates</span>
        <span class="lm-check" id="lm_clamp" title="If a vessel's open date is in the past, ballast is counted from today">Depart ≥ today</span>
        <span class="lm-check" id="lm_gone" title="Include vessels marked GONE / FIXED / ONSUB">Incl. gone/fixed/onsub</span>
        <span class="lm-check" id="lm_all" title="Show vessels that miss the laycan too">Show all</span>
      </div>

      <div id="lm_pickNote" style="display:none;font-size:12px;font-weight:500;margin:-4px 0 10px"></div>
      <div id="lm_custPanel" style="display:none"></div>

      <div id="lm_regionPills" class="filter-row" style="margin-bottom:10px"></div>

      <div id="lm_stats" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap"></div>

      <div style="overflow:auto;max-height:calc(100vh - 380px);border:1px solid var(--border);border-radius:var(--radius)">
        <table class="lm-table">
          <thead><tr>
            <th data-sort="fit" title="Sort: best fit first, shortest ballast within each tier">Status ▾</th><th data-sort="name">Vessel</th><th data-sort="dwt">DWT/Blt</th><th></th>
            <th>Dely port</th><th data-sort="open">Open</th><th>Owner</th>
            <th style="text-align:right">Dist NM</th><th style="text-align:right">Spd</th>
            <th data-sort="ballast" style="text-align:right" title="$ = top-3 shortest ballast among fixable ships — cheapest delivery">Ballast d</th><th data-sort="eta">ETA</th><th data-sort="offer" style="text-align:right" title="Sheet offer for the relevant direction: FH for ECSA-bound loads, TA otherwise. Hover a value for BB and the other side">Offer</th><th data-sort="margin" style="text-align:right">vs Canc.</th><th></th>
          </tr></thead>
          <tbody id="lm_tbody"></tbody>
        </table>
      </div>
    </div>`;

  // Wiring
  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  on('lm_port', 'change', e => { ui.port = e.target.value; saveUi(); render(); });
  on('lm_layFrom', 'change', e => { ui.layFrom = e.target.value; saveUi(); render(); });
  on('lm_layTo', 'change', e => { ui.layTo = e.target.value; saveUi(); render(); });
  on('lm_extra', 'input', e => { ui.extraDays = e.target.value; saveUi(); render(); });
  on('lm_tol', 'input', e => { ui.tolDays = e.target.value; saveUi(); render(); });
  on('lm_waitTol', 'input', e => { ui.waitTolDays = e.target.value; saveUi(); render(); });
  on('lm_margin', 'input', e => { ui.seaMarginPct = e.target.value; saveUi(); render(); });
  on('lm_speed', 'input', e => { ui.fixedSpeed = e.target.value; saveUi(); render(); });
  on('lm_search', 'input', e => { ui.search = e.target.value; saveUi(); render(); });
  on('lm_minDwt', 'input', e => { ui.minDwt = e.target.value; saveUi(); render(); });
  on('lm_maxDwt', 'input', e => { ui.maxDwt = e.target.value; saveUi(); render(); });
  on('lm_maxAge', 'input', e => { ui.maxAge = e.target.value; saveUi(); render(); });

  const toggles = [['lm_grain', 'grainOnly'], ['lm_scrub', 'scrubOnly'], ['lm_fh', 'fhOnly'],
    ['lm_clamp', 'clampToday'], ['lm_gone', 'includeGone'], ['lm_all', 'showAll']];
  for (const [id, key] of toggles) {
    const el = document.getElementById(id);
    const sync = () => el.classList.toggle('on', !!ui[key]);
    sync();
    el.addEventListener('click', () => { ui[key] = !ui[key]; saveUi(); sync(); render(); });
  }

  // Sortable headers
  root.querySelectorAll('.lm-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (ui.sortKey === k) ui.sortDir = -ui.sortDir; else { ui.sortKey = k; ui.sortDir = 1; }
      saveUi(); render();
    });
  });

  // Advanced filters toggle
  const advBtn = document.getElementById('lm_advBtn');
  const syncAdv = () => {
    advBtn.classList.toggle('on', !!ui.showAdv);
    document.getElementById('lm_advanced').style.display = ui.showAdv ? 'flex' : 'none';
  };
  syncAdv();
  advBtn.addEventListener('click', () => { ui.showAdv = !ui.showAdv; saveUi(); syncAdv(); });

  // Copy-fits shortlist
  document.getElementById('lm_copyFits').addEventListener('click', e => {
    const fits = (LM.visibleRows || []).filter(r => r.status === 'FIT');
    if (!fits.length) { copyText('No ships fit the current laycan/filters.', e.target); return; }
    const hdr = ui.layTo
      ? `Ships for ${portLabel(ui.port).replace(' ~', '')} ${fmtDStr(ui.layFrom)}-${fmtDStr(ui.layTo)}:`
      : `Ships open for ${portLabel(ui.port).replace(' ~', '')}:`;
    copyText(hdr + '\n' + fits.map(r => '· ' + describeRow(r, true)).join('\n'), e.target);
  });

  // Custom areas editor
  document.getElementById('lm_custBtn').addEventListener('click', () => {
    const p = document.getElementById('lm_custPanel');
    if (p.style.display === 'none') { renderCustPanel(); p.style.display = ''; }
    else p.style.display = 'none';
  });

  populateCargoPicker();
}

// ─── Custom areas editor panel ───────────────────────────────────────────────
let custEditing = null; // name of area being edited, or '' for new

function refreshPortSelect() {
  const sel = document.getElementById('lm_port');
  if (!sel) return;
  const ports = (LM.data && LM.data.ports) || PORT_ORDER;
  const ordered = PORT_ORDER.filter(p => ports.includes(p)).concat(ports.filter(p => !PORT_ORDER.includes(p)));
  let html = ordered.map(p => `<option value="${esc(p)}"${p === ui.port ? ' selected' : ''}>${esc(p)}</option>`).join('');
  if (customAreas.length) {
    html += '<optgroup label="Custom areas">' + customAreas.map(a => {
      const val = 'custom:' + a.name;
      return `<option value="${esc(val)}"${val === ui.port ? ' selected' : ''}>${esc(a.name)} ~</option>`;
    }).join('') + '</optgroup>';
  }
  sel.innerHTML = html;
}

function renderCustPanel() {
  const p = document.getElementById('lm_custPanel');
  if (!p) return;
  const area = custEditing != null ? (customAreas.find(a => a.name === custEditing) || { name: '', regionNm: {}, base: '', offsetNm: 0 }) : null;
  const zones = vesselZones();
  const ports = (LM.data && LM.data.ports) || [];
  const basePorts = PORT_ORDER.filter(x => ports.includes(x)).concat(ports.filter(x => !PORT_ORDER.includes(x)));

  const listHtml = customAreas.length
    ? customAreas.map(a => {
        const nZones = Object.keys(a.regionNm || {}).length;
        const fb = a.base ? `${esc(a.base)} ${a.offsetNm >= 0 ? '+' : ''}${a.offsetNm || 0} NM` : 'none';
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
          <strong>${esc(a.name)}</strong>
          <span style="color:var(--text-dim)">${nZones} zone constant${nZones === 1 ? '' : 's'} · fallback: ${fb}</span>
          <div style="flex:1"></div>
          <button class="lm-mini" data-edit="${esc(a.name)}">Edit</button>
          <button class="lm-mini" data-del="${esc(a.name)}" style="color:var(--red)">Delete</button>
        </div>`;
      }).join('')
    : '<div style="font-size:12px;color:var(--text-dim);padding:6px 0">No custom areas yet.</div>';

  const formHtml = area == null ? '' : `
    <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
      <div class="lm-controls">
        <div class="lm-field"><label>Area name</label><input type="text" id="lm_caName" placeholder="e.g. NCSA bss Pto Drummond" value="${esc(area.name)}" style="width:220px"></div>
        <div class="lm-field"><label>Fallback base port</label>
          <select id="lm_caBase"><option value="">— none —</option>${basePorts.map(x => `<option${x === area.base ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="lm-field"><label>Fallback ± NM</label><input type="text" id="lm_caOff" style="width:90px" value="${area.offsetNm || 0}"></div>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
        Zone constants (preferred): NM from each opening zone to this area. Accepts NM ("4600") or days at ${DAYS_TO_NM_SPEED} kn ("9.5d"). Blank = fall back to base port ± NM.
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${zones.map(z => `<div class="lm-field"><label>${esc(z)}</label>
          <input type="text" class="lm-caZone" data-zone="${esc(z)}" style="width:110px" placeholder="NM or 9.5d"
            value="${area.regionNm && area.regionNm[z] != null ? area.regionNm[z] : ''}"></div>`).join('')}
        <div class="lm-field"><label>+ zone</label><input type="text" id="lm_caNewZone" style="width:110px" placeholder="zone name"></div>
      </div>
      <button class="lm-mini" id="lm_caSave" style="background:var(--accent);color:#fff;border-color:var(--accent);padding:6px 16px">Save area</button>
      <button class="lm-mini" id="lm_caCancel" style="padding:6px 12px">Cancel</button>
      <span id="lm_caErr" style="font-size:12px;color:var(--red);margin-left:8px"></span>
    </div>`;

  p.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3);padding:12px 16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim)">Custom load areas</strong>
        <div style="flex:1"></div>
        ${area == null ? '<button class="lm-mini" id="lm_caAdd">+ Add area</button>' : ''}
      </div>
      ${listHtml}${formHtml}
    </div>`;

  const q = id => p.querySelector('#' + id);
  p.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { custEditing = b.dataset.edit; renderCustPanel(); }));
  p.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    customAreas = customAreas.filter(a => a.name !== b.dataset.del);
    if (ui.port === 'custom:' + b.dataset.del) ui.port = 'Rouen';
    saveCustom(); saveUi(); refreshPortSelect(); renderCustPanel(); render();
  }));
  if (q('lm_caAdd')) q('lm_caAdd').addEventListener('click', () => { custEditing = ''; renderCustPanel(); });
  if (q('lm_caCancel')) q('lm_caCancel').addEventListener('click', () => { custEditing = null; renderCustPanel(); });
  if (q('lm_caSave')) q('lm_caSave').addEventListener('click', () => {
    const name = q('lm_caName').value.trim();
    if (!name) { q('lm_caErr').textContent = 'Name required.'; return; }
    const regionNm = {};
    p.querySelectorAll('.lm-caZone').forEach(inp => {
      const nm = parseNmInput(inp.value);
      if (nm != null) regionNm[inp.dataset.zone.toUpperCase()] = nm;
    });
    const nz = q('lm_caNewZone').value.trim().toUpperCase();
    const a = {
      name,
      base: q('lm_caBase').value || null,
      offsetNm: parseNmInput(q('lm_caOff').value) || 0,
      regionNm,
    };
    if (nz && !(nz in regionNm)) a.regionNm[nz] = null; // placeholder row appears next edit
    const old = custEditing;
    customAreas = customAreas.filter(x => x.name !== old && x.name !== name).concat([a]);
    if (old && ui.port === 'custom:' + old) ui.port = 'custom:' + name;
    saveCustom(); saveUi();
    custEditing = nz ? name : null; // keep editing if they added a new zone row
    refreshPortSelect(); renderCustPanel(); render();
  });
}

function populateCargoPicker() {
  const sel = document.getElementById('lm_cargoPick');
  if (!sel) return;
  if (typeof cargoHistory === 'undefined' || typeof cargoCurrent === 'undefined') return;
  const live = cargoHistory.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
  sel.innerHTML = '<option value="">— manual entry —</option>' + live.map(c =>
    `<option value="${esc(c.id)}">${esc(c.charterer || '?')} · ${esc(c.load || '?')} · ${esc(c.laycan || 'no laycan')}</option>`).join('');
  const toPairings = document.getElementById('lm_toPairings');
  if (toPairings && !toPairings._wired) {
    toPairings._wired = true;
    toPairings.addEventListener('click', () => {
      if (sel.value && window.PairingsSelectCargo) window.PairingsSelectCargo(sel.value);
    });
  }
  if (toPairings) toPairings.style.display = sel.value ? '' : 'none';
  sel.onchange = () => {
    const note = document.getElementById('lm_pickNote');
    if (note) { note.style.display = 'none'; note.textContent = ''; }
    if (toPairings) toPairings.style.display = sel.value ? '' : 'none';
    const c = live.find(x => x.id === sel.value);
    if (!c) return;
    const msgs = [];
    const w = parseLaycanWindow(c.laycan);
    if (w) {
      ui.layFrom = w.from; ui.layTo = w.to;
      document.getElementById('lm_layFrom').value = w.from;
      document.getElementById('lm_layTo').value = w.to;
      if (w.onw) msgs.push(`"${c.laycan}" is open-ended — assumed a 20-day window (adjust Cancelling if you know better).`);
    } else if (c.laycan) {
      msgs.push(`Couldn't parse laycan "${c.laycan}" — enter dates manually.`);
    }
    const p = matchPortName(c.load);
    if (p) {
      ui.port = p; document.getElementById('lm_port').value = p;
      if (p.toLowerCase() !== (c.load || '').toLowerCase().trim()) msgs.push(`Load "${c.load}" mapped to ${p}.`);
    } else if (c.load) {
      msgs.push(`⚠ No distances for load port "${c.load}" — pick the nearest base port and use ± days, or add it as a custom area (✎). Load port left at ${portLabel(ui.port)}.`);
    }
    if (note && msgs.length) {
      note.textContent = msgs.join(' ');
      note.style.color = msgs.some(m => m.startsWith('⚠')) ? 'var(--amber)' : 'var(--text-dim)';
      note.style.display = '';
    }
    saveUi(); render();
  };
}

function lmInit() {
  if (LM.initialised) { populateCargoPicker(); render(); return; }
  loadData();
  buildUI();
  LM.initialised = true;
  render();
}

// Hook into the existing tab switcher (same decorator pattern as the other tabs)
if (IS_BROWSER) {
  const _origSwitchTabMatcher = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabMatcher) _origSwitchTabMatcher(tab);
    if (tab === 'matcher') lmInit();
  };

  // Cross-link hook: ECSA Pairings hands a cargo over to check NATL ballasters
  window.LaycanMatcherSelectCargo = function (cargoId) {
    window.switchTab('matcher');       // ensures lmInit + picker populated
    const sel = document.getElementById('lm_cargoPick');
    if (sel) {
      sel.value = cargoId;
      if (typeof sel.onchange === 'function') sel.onchange();
    }
  };

  // Public hook for the Google Sheets feed (feeds.js).
  // distancesRows may be null: the script only sends the (rarely-changing)
  // distances matrix once a day — in between, we reuse the cached matrix.
  window.LaycanMatcher = {
    applyNatlFeed(mainviewRows, distancesRows) {
      let data;
      if (distancesRows) {
        data = parseArrays(mainviewRows, distancesRows, 'sheets feed');
      } else {
        loadData(); // ensure LM.data holds the cached matrix (or seed)
        if (!LM.data) throw new Error('mainview-only feed but no cached distances');
        const fresh = parseArrays(mainviewRows,
          [[], ['', 'DELY PORT']], 'sheets feed'); // vessels only; empty matrix
        data = {
          imported_at: fresh.imported_at, source: 'sheets feed',
          ports: LM.data.ports, distances: LM.data.distances,
          port_regions: LM.data.port_regions, vessels: fresh.vessels,
        };
      }
      storeData(data);
      if (LM.initialised) render();
      return { vessels: data.vessels.length, ports: Object.keys(data.distances).length };
    },
  };
}

// Expose internals for Node tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseLaycanWindow, SEA_MARGIN,
    _test: {
      setData: d => { LM.data = d; },
      setUi: u => { Object.assign(ui, u); },
      setCustom: c => { customAreas = c; },
      computeRows, parseNmInput, vesselZones, parseArrays, describeRow,
    },
  };
}

})();
