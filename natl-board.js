/* ============================================================
   natl-board.js — "NATL Board" tab
   Global view of the North Atlantic tonnage list — the same
   at-a-glance grid the ECSA board gives, fed by the same data
   the Laycan Matcher uses (Sheets feed / xlsx drag-drop / seed,
   localStorage key lm_data).

   Read-mostly by design: the NATL list is maintained in the
   source sheet, so edits belong there (or in a fresh feed run),
   not here. Matching workflows live in the Laycan Matcher.
   ============================================================ */

(function () {
'use strict';

const LS_UI = 'nb_ui';
const LS_DATA = 'lm_data';                 // shared with laycan-matcher
const EXCLUDED = ['GONE', 'FIXED', 'ONSUB'];
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const ZN = (typeof Zones !== 'undefined') ? Zones
  : (typeof require === 'function' ? require('./zones.js') : null);
function vesselZone(v) { return ZN.zoneOfVessel(v) || '—'; }

let NB = { initialised: false };
let ui = Object.assign({
  region: 'ALL', search: '', includeGone: false,
  grainOnly: false, scrubOnly: false, offersOnly: false,
  sortKey: 'open', sortDir: 1,
}, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

function data() {
  try {
    const stored = localStorage.getItem(LS_DATA);
    if (stored) return JSON.parse(stored);
  } catch (e) { /* fall through */ }
  return (typeof window !== 'undefined' && window.NA_SEED) ? window.NA_SEED : null;
}

function computeRows() {
  const d = data();
  if (!d) return { rows: [], regions: [] };
  const counts = {};
  const rows = [];
  for (const v of d.vessels) {
    const rawRegion = (v.region || '—').toUpperCase();
    const isExcluded = EXCLUDED.includes(rawRegion);
    // Geographic zone from the dely port (sheet tag fallback); excluded
    // statuses stay grouped under their status label
    const region = isExcluded ? rawRegion : vesselZone(v);
    counts[region] = (counts[region] || 0) + 1;
    if (!ui.includeGone && isExcluded) continue;
    if (ui.region !== 'ALL' && region !== ui.region) continue;
    if (ui.grainOnly && !v.grain_clean) continue;
    if (ui.scrubOnly && !v.scrubber) continue;
    if (ui.offersOnly && v.rate_ta == null && v.rate_fh == null) continue;
    if (ui.search) {
      const hay = [v.name, v.owner, v.dely_port, v.comments, v.user].join(' ').toLowerCase();
      if (!hay.includes(ui.search.toLowerCase())) continue;
    }
    rows.push(v);
  }
  const dir = ui.sortDir;
  const val = v => {
    switch (ui.sortKey) {
      case 'open': return v.lay || '9999';
      case 'updated': return v.updated || '';
      case 'name': return (v.name || '').toLowerCase();
      case 'dwt': return v.dwt || 0;
      case 'built': return v.built || 0;
      case 'dely': return (v.dely_port || '').toLowerCase();
      case 'region': return displayZone(v).toLowerCase();
      case 'ta': return v.rate_ta != null ? v.rate_ta : Infinity;
      case 'fh': return v.rate_fh != null ? v.rate_fh : Infinity;
      default: return v.lay || '9999';
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });

  const regions = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { rows, regions, imported: d.imported_at, source: d.source };
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function esc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtD(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
function fmtRate(rate, bb) {
  if (rate == null) return '—';
  return '$' + Math.round(rate).toLocaleString() + (bb ? `<span style="color:var(--text-dim)" title="+ BB $${Math.round(bb).toLocaleString()}">+bb</span>` : '');
}
const REGION_COLORS = {
  'N CONT': 'var(--accent)', 'ARAG/CONTI': 'var(--accent)', 'BALTIC': '#5B8DB8',
  'W MED': 'var(--green)', 'WMED': 'var(--green)', 'E MED': '#6d8f11', 'EMED': '#6d8f11',
  'RSEA': 'var(--amber)', 'NWA': '#8a6db8', 'EC CAN': '#b86d9e', 'ECCAN': '#b86d9e',
  'NCSA': '#b8866d', 'ECSA': '#3d8f8a', 'USG': '#8f5f3d', 'USEC': '#5f3d8f',
  'BSEA': '#8f3d5f', 'WAFR': '#3d5f8f',
  'GONE': 'var(--text-dim)', 'FIXED': 'var(--text-dim)', 'ONSUB': 'var(--amber)', 'IN HOUSE': 'var(--text-bright)',
};
function displayZone(v) {
  const raw = (v.region || '').toUpperCase();
  return EXCLUDED.includes(raw) ? raw : vesselZone(v);
}

function render() {
  const root = document.getElementById('nb_root');
  if (!root || !NB.initialised) return;
  const { rows, regions, imported, source } = computeRows();

  // Region pills
  const pills = document.getElementById('nb_regions');
  pills.innerHTML = [['ALL', rows.length]].concat(regions.filter(([r]) => ui.includeGone || !EXCLUDED.includes(r)))
    .map(([r, c]) => `<button class="filter-pill ${ui.region === r ? 'active' : ''}" data-region="${esc(r)}">${esc(r)} <span class="filter-count">${c}</span></button>`).join('');
  pills.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    ui.region = ui.region === b.dataset.region ? 'ALL' : b.dataset.region;
    saveUi(); render();
  }));

  // Stats
  const offers = rows.filter(v => v.rate_ta != null || v.rate_fh != null).length;
  const grain = rows.filter(v => v.grain_clean).length;
  document.getElementById('nb_stats').innerHTML = [
    ['Ships', rows.length], ['With offers', offers], ['Grain clean', grain],
    ['Scrubbers', rows.filter(v => v.scrubber).length],
  ].map(([l, v]) => `<div class="stat" style="min-width:86px;padding:8px 14px"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px">${v}</div></div>`).join('');
  document.getElementById('nb_source').textContent = `data as of ${imported || '?'}${/feed/.test(source || '') ? ' (live feed)' : ''}`;

  const tb = document.getElementById('nb_tbody');
  tb.innerHTML = rows.length ? rows.map(v => {
    const zone = displayZone(v);
    const rc = REGION_COLORS[zone] || 'var(--text)';
    const openTxt = v.lay ? fmtD(v.lay) + (v.can ? '–' + fmtD(v.can) : '') : esc(v.laycan_str || '—');
    const flags = [
      v.grain_clean ? '<span class="nb-flag" title="Grain clean">G</span>' : '',
      v.scrubber ? '<span class="nb-flag" title="Scrubber fitted">S</span>' : '',
      v.fh_candidate ? '<span class="nb-flag" title="FH candidate">FH</span>' : '',
    ].join('');
    return `<tr>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">${fmtD(v.updated)}</td>
      <td style="font-weight:600;color:var(--text-bright)">${esc(v.name)}${v.comments ? ` <span style="cursor:help;color:var(--text-dim);font-size:11px" title="${esc(v.comments)}">ⓘ</span>` : ''}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(v.dwt_yr || (Math.round((v.dwt || 0) / 1000) + 'k/' + (v.built || '?')))}</td>
      <td>${flags}</td>
      <td>${esc(v.dely_port || '—')}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:600">${openTxt}</td>
      <td><span style="color:${rc};font-weight:600;font-size:11px" title="${esc(v.region || '')}">${esc(zone)}</span></td>
      <td>${esc(v.owner || '—')}</td>
      <td style="text-align:right;font-family:var(--mono);font-size:12px">${fmtRate(v.rate_ta, v.bb_ta)}</td>
      <td style="text-align:right;font-family:var(--mono);font-size:12px">${fmtRate(v.rate_fh, v.bb_fh)}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">${esc(v.user || '')}</td>
      <td><button class="nb-mini" data-match="${esc(v.name)}" title="Open the Laycan Matcher filtered to this ship">match</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="12" style="padding:18px;color:var(--text-dim)">No ships match the filters.</td></tr>';

  // Cross-link: jump to Laycan Matcher pre-searched on this vessel
  tb.querySelectorAll('[data-match]').forEach(b => b.addEventListener('click', () => {
    try {
      const lmUi = JSON.parse(localStorage.getItem('lm_ui') || '{}');
      lmUi.search = b.dataset.match;
      localStorage.setItem('lm_ui', JSON.stringify(lmUi));
    } catch (e) { /* non-fatal */ }
    localStorage.removeItem('lm_ui_applied');
    window.switchTab('matcher');
    // matcher caches its UI at init — nudge its search box if already built
    const inp = document.getElementById('lm_search');
    if (inp) { inp.value = b.dataset.match; inp.dispatchEvent(new Event('input')); }
  }));
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function buildUI() {
  const root = document.getElementById('nb_root');
  if (!root) return;

  const style = document.createElement('style');
  style.textContent = `
    .nb-flag{display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--accent-light);color:var(--accent);margin-right:3px}
    .nb-mini{border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;font-size:10px;padding:3px 8px;color:var(--text-dim)}
    .nb-mini:hover{border-color:var(--accent);color:var(--accent)}
    .nb-table{width:100%;border-collapse:collapse}
    .nb-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;position:sticky;top:0;background:var(--bg2);z-index:1}
    .nb-table td{padding:7px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
    .nb-table tr:hover td{background:var(--bg-hover)}
  `;
  document.head.appendChild(style);

  root.innerHTML = `
    <div style="padding:20px 28px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">North Atlantic Board</h2>
          <div style="font-size:12px;color:var(--text-dim)">Same data as the Laycan Matcher · maintained in the source sheet, refreshed by the feed</div>
        </div>
        <div style="flex:1"></div>
        <span id="nb_source" style="font-size:11px;color:var(--text-dim)"></span>
      </div>

      <div id="nb_regions" class="filter-row" style="margin-bottom:8px"></div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <span class="pr-check" id="nb_grain">Grain clean</span>
        <span class="pr-check" id="nb_scrub">Scrubber</span>
        <span class="pr-check" id="nb_offers">Offers only</span>
        <span class="pr-check" id="nb_gone" title="Include GONE / FIXED / ONSUB">Incl. gone/fixed/onsub</span>
        <div style="flex:1"></div>
        <input type="text" id="nb_search" class="search-input" placeholder="vessel / owner / port / comment" value="${esc(ui.search)}">
      </div>

      <div id="nb_stats" style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap"></div>

      <div style="overflow:auto;max-height:calc(100vh - 320px);border:1px solid var(--border);border-radius:var(--radius)">
        <table class="nb-table">
          <thead><tr>
            <th data-sort="updated">Upd</th><th data-sort="name">Vessel</th><th data-sort="dwt">DWT/Blt</th><th></th>
            <th data-sort="dely">Dely port</th><th data-sort="open">Open ▾</th><th data-sort="region">Region</th><th>Owner</th>
            <th data-sort="ta" style="text-align:right">Rate TA</th><th data-sort="fh" style="text-align:right">Rate FH</th>
            <th>By</th><th></th>
          </tr></thead>
          <tbody id="nb_tbody"></tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('nb_search').addEventListener('input', e => { ui.search = e.target.value; saveUi(); render(); });
  for (const [id, key] of [['nb_grain', 'grainOnly'], ['nb_scrub', 'scrubOnly'], ['nb_offers', 'offersOnly'], ['nb_gone', 'includeGone']]) {
    const el = document.getElementById(id);
    const sync = () => el.classList.toggle('on', !!ui[key]);
    sync();
    el.addEventListener('click', () => { ui[key] = !ui[key]; saveUi(); sync(); render(); });
  }
  root.querySelectorAll('.nb-table th[data-sort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (ui.sortKey === k) ui.sortDir = -ui.sortDir; else { ui.sortKey = k; ui.sortDir = 1; }
    saveUi(); render();
  }));
}

function nbInit() {
  if (!NB.initialised) { buildUI(); NB.initialised = true; }
  render();
}

if (IS_BROWSER) {
  const _origSwitchTabNb = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabNb) _origSwitchTabNb(tab);
    if (tab === 'natlboard') nbInit();
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _test: { setUi: u => Object.assign(ui, u), computeRows } };
}

})();
