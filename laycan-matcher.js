/* ============================================================
   laycan-matcher.js — "Laycan Matcher" tab
   Which ships in the North Atlantic position list can make a
   cargo's laycan at a given load port?

   Data source: NORTH ATLANTIC TONNAGE.xlsx ("NEW MAINVIEW" +
   "Distances" sheets). Seed snapshot ships in na-seed.js;
   drag-drop a fresh export of the sheet to refresh (stored in
   localStorage, key lm_data).

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

const SEA_MARGIN = 1.08;
const EXCLUDED_REGIONS = ['GONE', 'FIXED', 'ONSUB'];
const LS_KEY = 'lm_data';
const LS_UI = 'lm_ui';

// Port display order: NA/Continent loading areas first
const PORT_ORDER = ['Rouen', 'Ust Luga', 'NORFOLK', 'Nola', 'Yuzhny', 'Itaqui', 'San Lorenzo',
  'Santos', 'Rio grande', 'Kamsar', 'Gibraltar', 'PASSERO', 'PORT SAID', 'RBCT', 'ASTORIA', 'SEATTLE', 'VANCOUVER'];

// Destination columns with fewer dely-port rows than this are dropped (empty Capesize stubs)
const MIN_PORT_COVERAGE = 20;

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

let LM = { data: null, initialised: false };
let ui = Object.assign({
  port: 'Rouen', layFrom: '', layTo: '', extraDays: 0, tolDays: 2,
  clampToday: true, grainOnly: false, scrubOnly: false, fhOnly: false,
  includeGone: false, showAll: false, search: '', minDwt: '', maxDwt: '', maxAge: '',
  sortKey: 'eta', sortDir: 1,
}, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});

function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

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
  return null;
}
function s(v) { return (v == null) ? null : String(v).trim() || null; }
function n(v) { const f = parseFloat(v); return isNaN(f) ? null : f; }

function parseWorkbook(wb) {
  const mv = wb.Sheets['NEW MAINVIEW'];
  const di = wb.Sheets['Distances'];
  if (!mv) throw new Error('Sheet "NEW MAINVIEW" not found in workbook');
  if (!di) throw new Error('Sheet "Distances" not found in workbook');

  // Distances: header on 2nd row, dely port in col B.
  // Destinations: main block C..AG, plus extra named columns further right
  // (mostly empty Capesize stubs — kept only if coverage >= MIN_PORT_COVERAGE).
  const drows = XLSX.utils.sheet_to_json(di, { header: 1, raw: true });
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
  const vrows = XLSX.utils.sheet_to_json(mv, { header: 1, raw: true, cellDates: true });
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
    });
  }
  return {
    imported_at: new Date().toISOString().slice(0, 10),
    source: 'imported xlsx', ports: ports.map(p => p[0]),
    distances, port_regions, vessels,
  };
}

function handleFile(file) {
  const note = document.getElementById('lm_importNote');
  if (typeof XLSX === 'undefined') {
    if (note) { note.textContent = 'SheetJS failed to load — check network / CDN.'; note.style.color = 'var(--red)'; }
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const data = parseWorkbook(wb);
      storeData(data);
      if (note) { note.textContent = `Imported ${data.vessels.length} vessels · ${Object.keys(data.distances).length} dely ports · ${data.imported_at}`; note.style.color = 'var(--green)'; }
      render();
    } catch (err) {
      if (note) { note.textContent = 'Import failed: ' + err.message; note.style.color = 'var(--red)'; }
    }
  };
  reader.readAsArrayBuffer(file);
}

// ─── Laycan parsing (for cargo-book prefill) ─────────────────────────────────
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseLaycanWindow(str) {
  if (!str) return null;
  const t = str.toLowerCase().replace(/\s+/g, '');
  const yearNow = new Date().getFullYear();
  const mk = (d, m) => {
    let dt = new Date(Date.UTC(yearNow, m, d));
    const now = new Date();
    if (dt < now && (now - dt) / 86400000 > 180) dt = new Date(Date.UTC(yearNow + 1, m, d));
    return dt.toISOString().slice(0, 10);
  };
  let m;
  // 11jul-12jul / 11jul–12aug
  if ((m = t.match(/^(\d{1,2})([a-z]{3})[-–\/](\d{1,2})([a-z]{3})/)) && MONTHS[m[2]] != null && MONTHS[m[4]] != null)
    return { from: mk(+m[1], MONTHS[m[2]]), to: mk(+m[3], MONTHS[m[4]]) };
  // 1-10aug / 01-10aug
  if ((m = t.match(/^(\d{1,2})[-–\/](\d{1,2})([a-z]{3})/)) && MONTHS[m[3]] != null)
    return { from: mk(+m[1], MONTHS[m[3]]), to: mk(+m[2], MONTHS[m[3]]) };
  // 15jul (single day)
  if ((m = t.match(/^(\d{1,2})([a-z]{3})$/)) && MONTHS[m[2]] != null)
    return { from: mk(+m[1], MONTHS[m[2]]), to: mk(+m[1], MONTHS[m[2]]) };
  // jul11-12 style
  if ((m = t.match(/^([a-z]{3})(\d{1,2})[-–\/](\d{1,2})$/)) && MONTHS[m[1]] != null)
    return { from: mk(+m[2], MONTHS[m[1]]), to: mk(+m[3], MONTHS[m[1]]) };
  return null;
}

function matchPortName(text) {
  if (!text || !LM.data) return null;
  const t = text.toLowerCase();
  const aliases = {
    'rouen': 'Rouen', 'ust luga': 'Ust Luga', 'ustluga': 'Ust Luga',
    'norfolk': 'NORFOLK', 'hampton': 'NORFOLK', 'nola': 'Nola', 'new orleans': 'Nola', 'mississippi': 'Nola', 'usg': 'Nola', 'miss river': 'Nola',
    'yuzhny': 'Yuzhny', 'pivdennyi': 'Yuzhny', 'itaqui': 'Itaqui', 'san lorenzo': 'San Lorenzo', 'up river': 'San Lorenzo', 'upriver': 'San Lorenzo',
    'santos': 'Santos', 'rio grande': 'Rio grande', 'kamsar': 'Kamsar', 'gibraltar': 'Gibraltar', 'passero': 'PASSERO', 'port said': 'PORT SAID', 'rbct': 'RBCT', 'richards bay': 'RBCT',
  };
  const available = (LM.data.ports || []);
  // exact/substring match against actual destination port names first
  for (const p of available) if (t.includes(p.toLowerCase())) return p;
  for (const k in aliases) if (t.includes(k) && available.includes(aliases[k])) return aliases[k];
  return null;
}

// ─── Core match ──────────────────────────────────────────────────────────────
function computeRows() {
  const d = LM.data;
  if (!d) return [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const layTo = ui.layTo ? new Date(ui.layTo + 'T23:59:59Z') : null;
  const layFrom = ui.layFrom ? new Date(ui.layFrom + 'T00:00:00Z') : null;
  const tolMs = (parseFloat(ui.tolDays) || 0) * 86400000;
  const extra = (parseFloat(ui.extraDays) || 0) * 86400000;

  const rows = [];
  for (const v of d.vessels) {
    const region = (v.region || '').toUpperCase();
    if (!ui.includeGone && EXCLUDED_REGIONS.includes(region)) continue;
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

    const key = (v.dely_port || '').toLowerCase();
    const dist = (d.distances[key] && d.distances[key][ui.port]) || (v.pre_dist && v.pre_dist[ui.port]) || null;
    const speed = v.ballast_speed || 13;

    let eta = null, ballastDays = null, departs = null, clamped = false;
    if (dist && v.lay) {
      ballastDays = dist / speed / 24 * SEA_MARGIN;
      departs = new Date(v.lay + 'T00:00:00Z');
      if (ui.clampToday && departs < today) { departs = today; clamped = true; }
      eta = new Date(departs.getTime() + ballastDays * 86400000 + extra);
    }

    let status = 'NODATA', marginDays = null, waitDays = null;
    if (eta && layTo) {
      marginDays = (layTo - eta) / 86400000;
      if (eta <= layTo) status = 'MAKES';
      else if (eta - layTo <= tolMs) status = 'TIGHT';
      else status = 'MISSES';
      if (layFrom && eta < layFrom) waitDays = (layFrom - eta) / 86400000;
    } else if (eta) status = 'ETA';

    rows.push({ v, dist, speed, ballastDays, eta, clamped, status, marginDays, waitDays });
  }

  const dir = ui.sortDir;
  const key = ui.sortKey;
  rows.sort((a, b) => {
    const val = r => {
      switch (key) {
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

const BADGE = {
  MAKES: ['MAKES', 'var(--green)', 'var(--green-light)'],
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
    root.querySelector('#lm_tbody').innerHTML = '<tr><td colspan="12" style="padding:20px;color:var(--text-dim)">No position data. Drop the NORTH ATLANTIC TONNAGE xlsx above.</td></tr>';
    return;
  }

  const rows = computeRows();
  const hasLaycan = !!ui.layTo;
  const visible = rows.filter(r => {
    if (!hasLaycan) return true;
    if (ui.showAll) return true;
    return r.status === 'MAKES' || r.status === 'TIGHT';
  });

  // Stats
  const cnt = st => rows.filter(r => r.status === st).length;
  const statEl = document.getElementById('lm_stats');
  statEl.innerHTML = [
    ['Candidates', rows.length],
    ['Make laycan', hasLaycan ? cnt('MAKES') : '—'],
    ['Tight (+' + (ui.tolDays || 0) + 'd)', hasLaycan ? cnt('TIGHT') : '—'],
    ['Miss', hasLaycan ? cnt('MISSES') : '—'],
    ['No distance', cnt('NODATA')],
  ].map(([l, v]) => `<div class="stat" style="min-width:90px;padding:8px 16px"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px">${v}</div></div>`).join('');

  // Table
  const tb = root.querySelector('#lm_tbody');
  if (!visible.length) {
    tb.innerHTML = `<tr><td colspan="12" style="padding:20px;color:var(--text-dim)">No vessels ${hasLaycan ? 'make this laycan — toggle "Show all" to see the misses.' : 'match the current filters.'}</td></tr>`;
  } else {
    tb.innerHTML = visible.map(r => {
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
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${r.dist ? r.dist.toLocaleString() : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${r.speed ? r.speed.toFixed(1) : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${r.ballastDays != null ? r.ballastDays.toFixed(1) : '—'}</td>
        <td style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text-bright)">${fmtD(r.eta)}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;color:${marginColor}">${marginTxt} ${waitTxt}</td>
      </tr>`;
    }).join('');
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
  `;
  document.head.appendChild(style);

  const portOpts = () => {
    const ports = (LM.data && LM.data.ports) || PORT_ORDER;
    const ordered = PORT_ORDER.filter(p => ports.includes(p)).concat(ports.filter(p => !PORT_ORDER.includes(p)));
    return ordered.map(p => `<option value="${esc(p)}"${p === ui.port ? ' selected' : ''}>${esc(p)}</option>`).join('');
  };

  root.innerHTML = `
    <div style="padding:20px 28px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">Laycan Matcher</h2>
          <div style="font-size:12px;color:var(--text-dim)">Which North Atlantic ships make your cargo's laycan · ETA = open date + ballast @ 8% sea margin (sheet convention)</div>
        </div>
        <div class="spacer" style="flex:1"></div>
        <span id="lm_source" style="font-size:11px;color:var(--text-dim)"></span>
        <div class="lm-drop" id="lm_drop">⬆ Drop / click to import fresh NORTH ATLANTIC TONNAGE.xlsx</div>
        <input type="file" id="lm_file" accept=".xlsx,.xlsm" style="display:none">
      </div>
      <div id="lm_importNote" style="font-size:11px;margin-bottom:8px"></div>

      <div class="lm-controls">
        <div class="lm-field"><label>Cargo (from Cargo Book)</label>
          <select id="lm_cargoPick" style="max-width:260px"><option value="">— manual entry —</option></select></div>
        <div class="lm-field"><label>Load port</label><select id="lm_port">${portOpts()}</select></div>
        <div class="lm-field"><label>Laycan from</label><input type="date" id="lm_layFrom" value="${esc(ui.layFrom)}"></div>
        <div class="lm-field"><label>Cancelling</label><input type="date" id="lm_layTo" value="${esc(ui.layTo)}"></div>
        <div class="lm-field"><label title="One-off port: extra steaming days vs the selected base port (+/-)">± days (one-off port)</label>
          <input type="number" id="lm_extra" step="0.5" style="width:80px" value="${ui.extraDays || 0}"></div>
        <div class="lm-field"><label>Tight tolerance (d)</label>
          <input type="number" id="lm_tol" step="0.5" min="0" style="width:70px" value="${ui.tolDays}"></div>
        <div class="lm-field"><label>Search</label><input type="text" id="lm_search" placeholder="vessel / owner / port" value="${esc(ui.search)}" style="width:170px"></div>
      </div>
      <div id="lm_pickNote" style="display:none;font-size:12px;font-weight:500;margin:-4px 0 10px"></div>

      <div class="lm-controls" style="gap:6px">
        <span class="lm-check" id="lm_grain">Grain clean</span>
        <span class="lm-check" id="lm_scrub">Scrubber</span>
        <span class="lm-check" id="lm_fh">FH candidates</span>
        <span class="lm-check" id="lm_clamp" title="If a vessel's open date is in the past, ballast is counted from today">Depart ≥ today</span>
        <span class="lm-check" id="lm_gone" title="Include vessels marked GONE / FIXED / ONSUB">Incl. gone/fixed/onsub</span>
        <span class="lm-check" id="lm_all" title="Show vessels that miss the laycan too">Show all</span>
        <div class="spacer" style="flex:1"></div>
        <div class="lm-field"><label>DWT min</label><input type="number" id="lm_minDwt" style="width:80px" value="${esc(ui.minDwt)}"></div>
        <div class="lm-field"><label>DWT max</label><input type="number" id="lm_maxDwt" style="width:80px" value="${esc(ui.maxDwt)}"></div>
        <div class="lm-field"><label>Max age</label><input type="number" id="lm_maxAge" style="width:70px" value="${esc(ui.maxAge)}"></div>
      </div>

      <div id="lm_stats" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap"></div>

      <div style="overflow:auto;max-height:calc(100vh - 380px);border:1px solid var(--border);border-radius:var(--radius)">
        <table class="lm-table">
          <thead><tr>
            <th data-sort="margin">Status</th><th data-sort="name">Vessel</th><th data-sort="dwt">DWT/Blt</th><th></th>
            <th>Dely port</th><th data-sort="open">Open</th><th>Owner</th>
            <th style="text-align:right">Dist NM</th><th style="text-align:right">Spd</th>
            <th style="text-align:right">Ballast d</th><th data-sort="eta">ETA ▾</th><th data-sort="margin" style="text-align:right">vs Canc.</th>
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

  // Import: click + drag-drop
  const drop = document.getElementById('lm_drop');
  const file = document.getElementById('lm_file');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  populateCargoPicker();
}

function populateCargoPicker() {
  const sel = document.getElementById('lm_cargoPick');
  if (!sel) return;
  if (typeof cargoHistory === 'undefined' || typeof cargoCurrent === 'undefined') return;
  const live = cargoHistory.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
  sel.innerHTML = '<option value="">— manual entry —</option>' + live.map(c =>
    `<option value="${esc(c.id)}">${esc(c.charterer || '?')} · ${esc(c.load || '?')} · ${esc(c.laycan || 'no laycan')}</option>`).join('');
  sel.onchange = () => {
    const note = document.getElementById('lm_pickNote');
    if (note) { note.style.display = 'none'; note.textContent = ''; }
    const c = live.find(x => x.id === sel.value);
    if (!c) return;
    const msgs = [];
    const w = parseLaycanWindow(c.laycan);
    if (w) {
      ui.layFrom = w.from; ui.layTo = w.to;
      document.getElementById('lm_layFrom').value = w.from;
      document.getElementById('lm_layTo').value = w.to;
    } else if (c.laycan) {
      msgs.push(`Couldn't parse laycan "${c.laycan}" — enter dates manually.`);
    }
    const p = matchPortName(c.load);
    if (p) {
      ui.port = p; document.getElementById('lm_port').value = p;
      if (p.toLowerCase() !== (c.load || '').toLowerCase().trim()) msgs.push(`Load "${c.load}" mapped to ${p}.`);
    } else if (c.load) {
      msgs.push(`⚠ No distances for load port "${c.load}" — pick the nearest base port and use ± days (e.g. Tubarao ≈ Santos + 1d). Load port left at ${ui.port}.`);
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
}

// Expose internals for Node tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseLaycanWindow, SEA_MARGIN,
    _test: {
      setData: d => { LM.data = d; },
      setUi: u => { Object.assign(ui, u); },
      computeRows,
    },
  };
}

})();
