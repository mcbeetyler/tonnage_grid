/* ============================================================
   pairings.js — "Pairings" tab
   Match Tonnage Board ships against Cargo Book stems, both ways:

     Cargo → Ships   pick a live cargo; open board ships whose
                     declared ETA (eta_ecsa) fits the laycan,
                     tiered FIT/EARLY/TIGHT, then sorted by best
                     price (lowest P6-equivalent offer) in tier.
     Ship → Cargoes  pick an open ship; live cargoes whose laycan
                     her ETA fits, tightest fit first.

   This is a *pairer*, not a calculator: no distances, no speeds.
   The board ETA is owner-declared. Rows missing data are shown
   greyed with a reason — never guessed.

   Fit semantics shared with the Laycan Matcher via fit-utils.js.
   ============================================================ */

(function () {
'use strict';

const FU = (typeof FitUtils !== 'undefined') ? FitUtils
  : (typeof require === 'function' ? require('./fit-utils.js') : null);

const LS_UI = 'pr_ui';
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

let PR = { initialised: false };
let ui = Object.assign({
  mode: 'cargo2ship',       // or 'ship2cargo'
  cargoId: '', shipName: '',
  waitTolDays: 2, tightTolDays: 2, etaAdjDays: 0,
  ecsaOnly: true, showAll: false,
}, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

// ─── Data access (globals from app.js / cargo.js) ────────────────────────────
function boardVessels() {
  return (typeof vessels !== 'undefined' && Array.isArray(vessels)) ? vessels : [];
}
function openShips() {
  return boardVessels().filter(v => v.status === 'OPEN' && v.vessel_name);
}
function liveCargoes() {
  if (typeof cargoHistory === 'undefined' || typeof cargoCurrent === 'undefined') return [];
  return cargoHistory.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
}
function p6Of(v) {
  if (typeof getP6Values === 'function') return getP6Values(v);
  const mc = v.market_colour && v.market_colour[0];
  return { bid: mc ? mc.p6_bid : null, offer: mc ? mc.p6_offer : null };
}
function rawOfferOf(v) {
  const mc = v.market_colour && v.market_colour[0];
  return mc ? mc.offer_usd : null;
}

// ─── Core ────────────────────────────────────────────────────────────────────
function shipEta(v) {
  if (!v || !v.eta_ecsa) return null;
  const d = new Date(String(v.eta_ecsa).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const adj = parseFloat(ui.etaAdjDays) || 0;
  return new Date(d.getTime() + adj * FU.DAY);
}
function cargoWindow(c) {
  const w = FU.parseLaycanWindow(c && c.laycan);
  if (!w) return null;
  return {
    from: new Date(w.from + 'T00:00:00Z'),
    to: new Date(w.to + 'T23:59:59Z'),
    onw: !!w.onw,
  };
}
function isEcsa(c) {
  const s = ((c.stem || '') + ' ' + (c.load || '')).toLowerCase();
  return /ecsa|santos|itaqui|paranagua|rio grande|san lorenzo|up ?river|recalada|bahia blanca|necochea|vitoria|tubarao|sao francisco/.test(s);
}

function computeCargo2Ship() {
  const cargo = liveCargoes().find(c => c.id === ui.cargoId) || null;
  const w = cargo ? cargoWindow(cargo) : null;
  const opts = { waitTolDays: ui.waitTolDays, tightTolDays: ui.tightTolDays };
  const rows = openShips().map(v => {
    const eta = shipEta(v);
    const fit = FU.fitStatus(eta, w && w.from, w && w.to, opts);
    const p6 = p6Of(v);
    return { v, eta, p6offer: p6.offer, p6bid: p6.bid, rawOffer: rawOfferOf(v),
      spread: (p6.offer != null && p6.bid != null) ? p6.offer - p6.bid : null,
      reason: !v.eta_ecsa ? 'no ETA on board' : (!w && cargo ? 'laycan unparsed' : null),
      ...fit };
  });
  // tier → priced before unpriced → cheapest P6 offer → earliest ETA
  rows.sort((a, b) =>
    (FU.FIT_ORDER[a.status] - FU.FIT_ORDER[b.status])
    || ((a.p6offer == null) - (b.p6offer == null))
    || ((a.p6offer ?? 0) - (b.p6offer ?? 0))
    || ((a.eta ? a.eta.getTime() : Infinity) - (b.eta ? b.eta.getTime() : Infinity)));
  return { cargo, window: w, rows };
}

function computeShip2Cargo() {
  const ship = openShips().find(v => v.vessel_name === ui.shipName) || null;
  const eta = ship ? shipEta(ship) : null;
  const opts = { waitTolDays: ui.waitTolDays, tightTolDays: ui.tightTolDays };
  let cs = liveCargoes();
  if (ui.ecsaOnly) cs = cs.filter(isEcsa);
  const rows = cs.map(c => {
    const w = cargoWindow(c);
    const fit = FU.fitStatus(eta, w && w.from, w && w.to, opts);
    return { c, window: w,
      reason: !w ? 'laycan unparsed' : (ship && !ship.eta_ecsa ? 'ship has no ETA' : null),
      ...fit };
  });
  rows.sort((a, b) =>
    (FU.FIT_ORDER[a.status] - FU.FIT_ORDER[b.status])
    || ((a.window ? a.window.from.getTime() : Infinity) - (b.window ? b.window.from.getTime() : Infinity)));
  return { ship, eta, rows };
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function esc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtD(dt) {
  return dt ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : '—';
}
function fmtK(n) {
  return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
const BADGE = {
  FIT: ['FITS', '#fff', 'var(--green)'],
  EARLY: ['EARLY', 'var(--blue)', 'var(--blue-light)'],
  TIGHT: ['TIGHT', 'var(--amber)', 'var(--amber-light)'],
  MISSES: ['MISSES', 'var(--red)', 'var(--red-light)'],
  ETA: ['ETA', 'var(--accent)', 'var(--accent-light)'],
  NODATA: ['NO DATA', 'var(--text-dim)', 'var(--bg3)'],
};
function badge(st) {
  const [l, fg, bg] = BADGE[st] || BADGE.NODATA;
  return `<span class="pr-badge" style="color:${fg};background:${bg}">${l}</span>`;
}
function fitCells(r) {
  const marginTxt = r.marginDays == null ? '—' : (r.marginDays >= 0 ? '+' : '') + r.marginDays.toFixed(1) + 'd';
  const marginColor = r.marginDays == null ? 'var(--text-dim)' : r.marginDays >= 0 ? 'var(--green)' : 'var(--red)';
  const waitTxt = r.waitDays ? ` <span style="color:var(--text-dim)" title="Idle days before layfrom">wait ${r.waitDays.toFixed(1)}d</span>` : '';
  return `<td style="text-align:right;font-family:var(--mono);font-size:12px;color:${marginColor}">${marginTxt}${waitTxt}</td>`;
}

function render() {
  const root = document.getElementById('pr_root');
  if (!root || !PR.initialised) return;
  const tb = root.querySelector('#pr_tbody');
  const thead = root.querySelector('#pr_thead');
  const note = root.querySelector('#pr_note');
  note.textContent = '';

  const visible = r => ui.showAll || r.status === 'FIT' || r.status === 'EARLY' || r.status === 'TIGHT'
    || r.status === 'ETA' || r.status === 'NODATA' && false;

  if (ui.mode === 'cargo2ship') {
    const { cargo, window: w, rows } = computeCargo2Ship();
    if (!cargo) note.textContent = 'Pick a cargo — open board ships will be tiered on her laycan and sorted cheapest-first.';
    else if (!w) note.textContent = `Couldn't parse laycan "${cargo.laycan || '—'}" — fix it in the Cargo Book.`;
    else if (w.onw) note.textContent = `Laycan "${cargo.laycan}" is open-ended — assumed a 20-day window.`;
    const shown = rows.filter(r => !w ? true : visible(r));
    thead.innerHTML = `<tr><th>Status</th><th>Vessel</th><th>DWT/Blt</th><th>Dely</th><th>ETA ECSA</th><th>Owner</th>
      <th style="text-align:right" title="P6-equivalent offer — the universal comparator">Offer P6</th>
      <th style="text-align:right">Bid P6</th><th style="text-align:right">Spread</th><th style="text-align:right">vs Canc.</th></tr>`;
    tb.innerHTML = shown.length ? shown.map(r => {
      const v = r.v;
      const onw = v.eta_type === 'ONW' ? ' <span style="color:var(--amber)" title="ONW — owner says onwards, could slip later">›</span>' : '';
      const grey = r.reason ? 'opacity:.55' : '';
      return `<tr style="${grey}">
        <td>${badge(r.status)}${r.reason ? ` <span style="font-size:10px;color:var(--text-dim)">${esc(r.reason)}</span>` : ''}</td>
        <td style="font-weight:600;color:var(--text-bright)">${esc(v.vessel_name)}${v.notes ? ` <span class="pr-info" title="${esc(v.notes)}">ⓘ</span>` : ''}</td>
        <td style="font-family:var(--mono);font-size:12px">${v.dwt ? Math.round(v.dwt / 1000) + 'k' : '?'}/${v.build_year || '?'}</td>
        <td>${esc(v.delivery_basis || '—')}</td>
        <td style="font-family:var(--mono);font-size:12px;font-weight:600">${v.eta_ecsa ? fmtD(shipEta(v)) : '—'}${onw}</td>
        <td>${esc(v.owner || v.source || '—')}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;font-weight:600">${fmtK(r.p6offer)}${r.rawOffer != null && r.p6offer != null ? `<span style="color:var(--text-dim);font-weight:400" title="raw offer"> (${fmtK(r.rawOffer)})</span>` : ''}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${fmtK(r.p6bid)}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;color:${r.spread != null && r.spread <= 1000 ? 'var(--green)' : 'var(--text)'}"
            title="Offer minus bid — how far apart the two sides are">${r.spread == null ? '—' : fmtK(r.spread)}</td>
        ${fitCells(r)}</tr>`;
    }).join('') : `<tr><td colspan="10" style="padding:18px;color:var(--text-dim)">${cargo ? 'No ships fit — toggle "Show all" to see the misses.' : 'No open ships on the board.'}</td></tr>`;
    renderStats(w ? rows : []);
  } else {
    const { ship, eta, rows } = computeShip2Cargo();
    if (!ship) note.textContent = 'Pick a ship — live cargoes whose laycan her ETA fits, tightest first.';
    else if (!eta) note.textContent = `${ship.vessel_name} has no ETA on the board — add one on the Tonnage Board.`;
    else note.textContent = `${ship.vessel_name} — ETA ${fmtD(eta)}${ship.eta_type === 'ONW' ? ' (ONW, could slip)' : ''}${(parseFloat(ui.etaAdjDays) || 0) !== 0 ? `, adjusted ${ui.etaAdjDays > 0 ? '+' : ''}${ui.etaAdjDays}d` : ''}`;
    const shown = rows.filter(r => !eta ? true : visible(r));
    thead.innerHTML = `<tr><th>Status</th><th>Charterer</th><th>Stem</th><th>Cargo</th><th>Size</th>
      <th>Load</th><th>Disch</th><th>Laycan</th><th style="text-align:right">vs Canc.</th></tr>`;
    tb.innerHTML = shown.length ? shown.map(r => {
      const c = r.c;
      const grey = r.reason ? 'opacity:.55' : '';
      return `<tr style="${grey}">
        <td>${badge(r.status)}${r.reason ? ` <span style="font-size:10px;color:var(--text-dim)">${esc(r.reason)}</span>` : ''}</td>
        <td style="font-weight:600;color:var(--text-bright)">${esc(c.charterer || '?')}</td>
        <td style="color:var(--text-dim)">${esc(c.stem || '—')}</td>
        <td>${esc(c.cargo || '—')}</td>
        <td style="font-family:var(--mono);font-size:12px">${esc(c.size || '—')}</td>
        <td>${esc(c.load || '—')}</td>
        <td>${esc(c.disch || '—')}</td>
        <td style="font-family:var(--mono);font-size:12px">${esc(c.laycan || '—')}</td>
        ${fitCells(r)}</tr>`;
    }).join('') : `<tr><td colspan="9" style="padding:18px;color:var(--text-dim)">${ship ? 'No cargoes fit — toggle "Show all", widen Max wait, or untick ECSA-only.' : 'No live cargoes in the book.'}</td></tr>`;
    renderStats(eta ? rows : []);
  }
}

function renderStats(rows) {
  const el = document.getElementById('pr_stats');
  if (!el) return;
  if (!rows.length) { el.innerHTML = ''; return; }
  const cnt = st => rows.filter(r => r.status === st).length;
  el.innerHTML = [
    ['Fits', cnt('FIT')], ['Early', cnt('EARLY')], ['Tight', cnt('TIGHT')],
    ['Miss', cnt('MISSES')], ['No data', cnt('NODATA')],
  ].map(([l, v]) => `<div class="stat" style="min-width:80px;padding:8px 16px"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:22px">${v}</div></div>`).join('');
}

// ─── UI ──────────────────────────────────────────────────────────────────────
let cargoLabelMap = new Map();   // display label → cargo id

function cargoLabel(c) {
  return `${c.charterer || '?'} · ${c.load || '?'}${c.disch ? '→' + c.disch : ''} · ${c.laycan || 'no laycan'}`;
}

function populatePickers() {
  const cs = document.getElementById('pr_cargoPick');
  const ss = document.getElementById('pr_shipPick');
  if (cs) {
    cargoLabelMap = new Map();
    const cargoes = liveCargoes();
    document.getElementById('pr_cargoList').innerHTML = cargoes.map(c => {
      const label = cargoLabel(c);
      cargoLabelMap.set(label.toLowerCase(), c.id);
      return `<option value="${esc(label)}"></option>`;
    }).join('');
    const sel = cargoes.find(c => c.id === ui.cargoId);
    if (sel && !cs.value) cs.value = cargoLabel(sel);
  }
  if (ss) {
    const ships = openShips().slice().sort((a, b) => String(a.eta_ecsa || '9').localeCompare(String(b.eta_ecsa || '9')));
    document.getElementById('pr_shipList').innerHTML = ships.map(v =>
      `<option value="${esc(v.vessel_name)}" label="${v.dwt ? Math.round(v.dwt / 1000) + 'k' : '?'}/${v.build_year || '?'} · ETA ${esc(v.eta_ecsa || '?')}"></option>`).join('');
    if (ui.shipName && !ss.value) ss.value = ui.shipName;
  }
}

function syncModeUI() {
  document.querySelectorAll('#pr_modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === ui.mode));
  document.getElementById('pr_cargoField').style.display = ui.mode === 'cargo2ship' ? '' : 'none';
  document.getElementById('pr_shipField').style.display = ui.mode === 'ship2cargo' ? '' : 'none';
  document.getElementById('pr_ecsaWrap').style.display = ui.mode === 'ship2cargo' ? '' : 'none';
}

function buildUI() {
  const root = document.getElementById('pr_root');
  if (!root) return;

  const style = document.createElement('style');
  style.textContent = `
    .pr-badge{font-size:10px;font-weight:700;letter-spacing:.5px;padding:3px 8px;border-radius:10px;white-space:nowrap}
    .pr-info{cursor:help;color:var(--text-dim);font-size:11px}
    .pr-seg{display:inline-flex;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden}
    .pr-seg button{border:none;background:var(--bg2);font-size:12px;padding:8px 16px;cursor:pointer;border-right:1px solid var(--border)}
    .pr-seg button:last-child{border-right:none}
    .pr-seg button.active{background:var(--accent);color:#fff;font-weight:600}
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
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">Pairings</h2>
          <div style="font-size:12px;color:var(--text-dim)">Tonnage Board ↔ Cargo Book · board ETAs are owner-declared, no distance math · same FIT/EARLY/TIGHT tiers as the Laycan Matcher</div>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px">
        <div class="pr-seg" id="pr_modeSeg">
          <button data-mode="cargo2ship">Cargo → Ships</button>
          <button data-mode="ship2cargo">Ship → Cargoes</button>
        </div>
        <div class="pr-field" id="pr_cargoField"><label>Cargo — type to search</label>
          <input id="pr_cargoPick" list="pr_cargoList" placeholder="charterer / load / laycan…" style="width:300px" autocomplete="off">
          <datalist id="pr_cargoList"></datalist></div>
        <div class="pr-field" id="pr_shipField"><label>Ship — type to search</label>
          <input id="pr_shipPick" list="pr_shipList" placeholder="vessel name…" style="width:300px" autocomplete="off">
          <datalist id="pr_shipList"></datalist></div>
        <div class="pr-field"><label title="Max idle days before layfrom to still count as FITS">Max wait (d)</label>
          <input type="number" id="pr_waitTol" step="0.5" min="0" style="width:70px" value="${ui.waitTolDays}"></div>
        <div class="pr-field"><label>Tight tolerance (d)</label>
          <input type="number" id="pr_tightTol" step="0.5" min="0" style="width:70px" value="${ui.tightTolDays}"></div>
        <div class="pr-field"><label title="Adjust board ETAs for load basis, e.g. upriver +2, north Brazil -1. ETAs are usually quoted bss Santos">ETA ± d</label>
          <input type="number" id="pr_etaAdj" step="0.5" style="width:70px" value="${ui.etaAdjDays}"></div>
        <span class="pr-check" id="pr_ecsaWrap" title="Only cargoes loading ECSA">ECSA only</span>
        <span class="pr-check" id="pr_showAll" title="Include misses and rows missing data">Show all</span>
      </div>

      <div id="pr_note" style="font-size:12px;color:var(--text-dim);margin-bottom:10px"></div>
      <div id="pr_stats" style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap"></div>

      <div style="overflow:auto;max-height:calc(100vh - 340px);border:1px solid var(--border);border-radius:var(--radius)">
        <table class="pr-table"><thead id="pr_thead"></thead><tbody id="pr_tbody"></tbody></table>
      </div>
    </div>`;

  document.querySelectorAll('#pr_modeSeg button').forEach(b => b.addEventListener('click', () => {
    ui.mode = b.dataset.mode; saveUi(); syncModeUI(); render();
  }));
  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  on('pr_cargoPick', 'input', e => {
    const id = cargoLabelMap.get(e.target.value.toLowerCase().trim());
    if (id !== undefined || e.target.value === '') { ui.cargoId = id || ''; saveUi(); render(); }
  });
  on('pr_shipPick', 'input', e => {
    const t = e.target.value.trim();
    const hit = openShips().find(v => (v.vessel_name || '').toLowerCase() === t.toLowerCase());
    if (hit || t === '') { ui.shipName = hit ? hit.vessel_name : ''; saveUi(); render(); }
  });
  on('pr_waitTol', 'input', e => { ui.waitTolDays = e.target.value; saveUi(); render(); });
  on('pr_tightTol', 'input', e => { ui.tightTolDays = e.target.value; saveUi(); render(); });
  on('pr_etaAdj', 'input', e => { ui.etaAdjDays = e.target.value; saveUi(); render(); });
  for (const [id, key] of [['pr_ecsaWrap', 'ecsaOnly'], ['pr_showAll', 'showAll']]) {
    const el = document.getElementById(id);
    const sync = () => el.classList.toggle('on', !!ui[key]);
    sync();
    el.addEventListener('click', () => { ui[key] = !ui[key]; saveUi(); sync(); render(); });
  }
  syncModeUI();
}

function prInit() {
  if (!PR.initialised) { buildUI(); PR.initialised = true; }
  populatePickers();
  render();
}

if (IS_BROWSER) {
  const _origSwitchTabPairings = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabPairings) _origSwitchTabPairings(tab);
    if (tab === 'pairings') prInit();
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _test: {
      setUi: u => Object.assign(ui, u),
      setGlobals: g => {
        if (g.vessels) global.vessels = g.vessels;
        if (g.cargoHistory) global.cargoHistory = g.cargoHistory;
        if (g.cargoCurrent) global.cargoCurrent = g.cargoCurrent;
      },
      computeCargo2Ship, computeShip2Cargo, isEcsa,
    },
  };
}

})();
