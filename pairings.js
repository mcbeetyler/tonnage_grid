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
const ZN = (typeof Zones !== 'undefined') ? Zones
  : (typeof require === 'function' ? require('./zones.js') : null);

// ─── Load-basis ETA adjustment ───────────────────────────────────────────────
// Board ETAs are declared bss Santos (ECSA convention). A ship bound for
// NCSA forks off the Santos track after the Cape, so the honest correction
// is the LEG DIFFERENCE from the fork — not Santos→NCSA steaming.
// Days vs a Santos-basis ETA, ~13 kn:
const BASIS_PORT_ADJ = {
  // ECSA proper — same track, small deltas
  'santos': 0, 'paranagua': 0.5, 'rio grande': 1, 'sao francisco do sul': 0.5,
  'itaguai': 0.5, 'tubarao': 0.5, 'vitoria': 0.5, 'praia mole': 0.5, 'porto sudeste': 0.5,
  'recalada': 1.5, 'bahia blanca': 2, 'necochea': 2, 'quequen': 2,
  'san lorenzo': 2, 'rosario': 2, 'up river': 2, 'upriver': 2, 'buenos aires': 1.5, 'montevideo': 1.5,
  // North Brazil — forks earlier, modest add
  'salvador': 0.5, 'aratu': 0.5, 'suape': 1, 'recife': 1, 'fortaleza': 1.5,
  'pecem': 2, 'itaqui': 2, 'sao luis': 2, 'ponta da madeira': 2,
  'belem': 2.5, 'vila do conde': 2.5, 'barcarena': 2.5, 'santarem': 3, 'macapa': 3,
  // Caribbean rim NCSA
  'georgetown': 5, 'paramaribo': 4.5, 'point lisas': 5.5, 'port of spain': 5.5,
  'puerto ordaz': 5.5, 'palua': 5.5, 'matanzas': 5.5, 'guanta': 6, 'jose': 6,
  'la guaira': 6, 'puerto cabello': 6, 'puerto drummond': 6.5, 'santa marta': 6.5,
  'barranquilla': 6.5, 'cartagena (col)': 6.5, 'puerto bolivar': 6,
  // Panama
  'cristobal': 7.5, 'colon': 7.5, 'balboa': 8.5, 'panama': 7.5,
  // Desk shorthand seen in the cargo book
  'pdm': 2, 'up river arg': 2, 'north brazil': 2, 'n brazil': 2, 'amazon': 2.5,   // pdm ≡ ponta da madeira ≡ itaqui
};
const BASIS_ZONE_ADJ = { 'ECSA': 0.5, 'NCSA': 3 };   // NCSA = desk figure: ~3d extra vs Santos

function basisNorm(p) {
  return String(p || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
// → { days, label } or { days: null, warn } when the load is outside reach
function loadBasisAdj(cargo) {
  if (!cargo || !cargo.load) return { days: 0, label: null };
  const n = basisNorm(cargo.load);
  for (const [port, d] of Object.entries(BASIS_PORT_ADJ)) {
    const pn = basisNorm(port);
    if (n === pn || n.includes(pn)) return { days: d, label: `${cargo.load.trim()} ≈ Santos ${d >= 0 ? '+' : ''}${d}d` };
  }
  // Zone from the port name, or a zone token written straight into the load
  // field ("ncsa (int amazon)", "ecsa")
  let zone = ZN ? ZN.zoneOfPort(cargo.load) : null;
  if (!zone) {
    if (/\bncsa\b/.test(n)) zone = 'NCSA';
    else if (/\becsa\b/.test(n)) zone = 'ECSA';
  }
  if (zone && BASIS_ZONE_ADJ[zone] != null) {
    return { days: BASIS_ZONE_ADJ[zone], label: `${zone} zone ≈ Santos +${BASIS_ZONE_ADJ[zone]}d` };
  }
  if (zone && !(zone in BASIS_ZONE_ADJ)) {
    return { days: null, warn: `load "${cargo.load.trim()}" is ${zone} — Santos-basis ETAs aren't comparable; use the NATL Matcher or a manual ± adj` };
  }
  return { days: 0, label: null };   // unknown port: no auto adj, manual field still applies
}

const LS_UI = 'pr_ui';
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

let PR = { initialised: false };
let ui = Object.assign({
  mode: 'cargo2ship',       // or 'ship2cargo'
  cargoId: '', shipName: '',
  manFrom: '', manTo: '', manBasis: '',   // manual date window + load basis — search ships with no cargo attached
  minDwt: '', maxDwt: '', maxAge: '',
  waitTolDays: 2, tightTolDays: 2, etaAdjDays: 0, autoBasis: true,
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
function shipEta(v, extraDays) {
  if (!v || !v.eta_ecsa) return null;
  const d = new Date(String(v.eta_ecsa).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const adj = (parseFloat(ui.etaAdjDays) || 0) + (extraDays || 0);
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
  // No cargo? A manual date window works standalone — "who's around 5-15 Aug"
  let w = cargo ? cargoWindow(cargo) : null;
  if (!w && (ui.manFrom || ui.manTo)) {
    w = {
      from: ui.manFrom ? new Date(ui.manFrom + 'T00:00:00Z') : null,
      to: ui.manTo ? new Date(ui.manTo + 'T23:59:59Z') : null,
      manual: true,
    };
  }
  // Basis: cargo selected → auto from her load port. Manual window → the
  // Load basis dropdown (e.g. NCSA loader ≈ Santos +3d, desk figure).
  const manDays = parseFloat(ui.manBasis) || 0;
  const basis = (ui.autoBasis && cargo) ? loadBasisAdj(cargo)
    : (!cargo && manDays) ? { days: manDays, label: `manual basis +${manDays}d vs Santos` }
    : { days: 0, label: null };
  const opts = { waitTolDays: ui.waitTolDays, tightTolDays: ui.tightTolDays };
  const minDwt = parseFloat(ui.minDwt) || 0;
  const maxDwt = parseFloat(ui.maxDwt) || Infinity;
  const maxAge = parseFloat(ui.maxAge) || Infinity;
  const yearNow = new Date().getFullYear();
  // TA cargo? Then the TA quote is the price that matters — a ship quoting
  // TA is declaring interest in going that way.
  const isTa = !!(cargo && /\bta\b/i.test(cargo.stem || ''));
  const rows = openShips().filter(v => (v.dwt || 0) >= minDwt && (v.dwt || 0) <= maxDwt
    // Age filter: ships with unknown build year stay visible (no false drops)
    && (!isFinite(maxAge) || !v.build_year || (yearNow - v.build_year) <= maxAge)).map(v => {
    const eta = shipEta(v, basis.days || 0);
    const fit = FU.fitStatus(eta, w && w.from, w && w.to, opts);
    const p6 = p6Of(v);
    return { v, eta, p6offer: p6.offer, p6bid: p6.bid, rawOffer: rawOfferOf(v),
      hireTa: v.hire_ta != null ? v.hire_ta : null,
      spread: (p6.offer != null && p6.bid != null) ? p6.offer - p6.bid : null,
      reason: !v.eta_ecsa ? 'no ETA on board' : (!w && cargo ? 'laycan unparsed' : null),
      ...fit };
  });
  // tier → priced before unpriced → cheapest → earliest ETA.
  // Price basis: TA quote for TA cargoes, P6 offer otherwise.
  const px = r => isTa ? r.hireTa : r.p6offer;
  rows.sort((a, b) =>
    (FU.FIT_ORDER[a.status] - FU.FIT_ORDER[b.status])
    || ((px(a) == null) - (px(b) == null))
    || ((px(a) ?? 0) - (px(b) ?? 0))
    || ((a.eta ? a.eta.getTime() : Infinity) - (b.eta ? b.eta.getTime() : Infinity)));
  return { cargo, window: w, rows, basis, isTa };
}

// ─── WhatsApp export ─────────────────────────────────────────────────────────
// Principal-facing: ships that make the laycan (FIT/EARLY, TIGHT tagged) AND
// have an offer. *bold* = title + ship blocks, _italic_ = context lines,
// facts plain. Internal comments/notes are NEVER included.
function buildPairingsText() {
  const { cargo, window: w, rows, basis, isTa } = computeCargo2Ship();
  if (!w) return null;
  const px = r => isTa ? r.hireTa : r.p6offer;
  const picks = rows.filter(r =>
    (r.status === 'FIT' || r.status === 'EARLY' || r.status === 'TIGHT')
    && !r.reason && px(r) != null);
  if (!picks.length) return null;

  // Header: the laycan window (cargo's own string when we have it) + load
  const lay = cargo && cargo.laycan ? cargo.laycan.trim()
    : `${w.from ? fmtD(w.from) : '…'} - ${w.to ? fmtD(w.to) : '…'}`;
  const where = cargo && cargo.load ? ` — ${cargo.load.trim().toUpperCase()}` : '';
  let text = `*${lay}${where}*\n`;
  if (basis && basis.days) text += `_ETAs at the load area (+${basis.days}d vs Santos)_\n`;

  for (const r of picks) {
    const v = r.v;
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
    let line1 = `*${v.vessel_name || '?'} ${specs}${v.scrubber === true ? ' SCR' : ''}*${r.status === 'TIGHT' ? ' [TIGHT]' : ''}`;
    if (v.owner) line1 += ` — ${v.owner.toUpperCase()}`;
    const delivery = v.delivery_basis || v.current_position || '';
    if (delivery) line1 += ` — ${delivery}`;
    if (r.eta) line1 += ` — ETA: ${fmtD(r.eta)}${v.eta_type === 'ONW' ? ' (ONW)' : ''}`;

    const parts = [];
    if (r.p6offer != null) parts.push(`P6: $${r.p6offer.toLocaleString()}`);
    if (isTa && r.hireTa != null) parts.push(`TA: $${r.hireTa.toLocaleString()}`);
    if (v.hire_offer) parts.push(`Hire: $${v.hire_offer.toLocaleString()}`);
    if (v.bb_offer) parts.push(`BB: $${v.bb_offer.toLocaleString()}`);
    text += line1 + '\n' + parts.join(' | ') + '\n';
  }
  return text;
}

function prCopy() {
  if (ui.mode !== 'cargo2ship') { alert('Switch to Cargo → Ships to export a tonnage list.'); return; }
  const text = buildPairingsText();
  if (!text) { alert('Nothing to export — need a laycan (cargo or manual window) and at least one fitting ship with an offer.'); return; }
  const done = () => {
    const b = document.getElementById('pr_copy');
    if (b) { const t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = t; }, 1500); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => prompt('Copy manually:', text));
  } else prompt('Copy manually:', text);
}

function computeShip2Cargo() {
  const ship = openShips().find(v => v.vessel_name === ui.shipName) || null;
  const eta = ship ? shipEta(ship) : null;
  const opts = { waitTolDays: ui.waitTolDays, tightTolDays: ui.tightTolDays };
  let cs = liveCargoes();
  if (ui.ecsaOnly) cs = cs.filter(isEcsa);
  const rows = cs.map(c => {
    const w = cargoWindow(c);
    // Per-cargo basis correction: each cargo's load may sit off the Santos track
    const basis = ui.autoBasis ? loadBasisAdj(c) : { days: 0 };
    const effEta = (basis.days != null && basis.days !== 0 && eta)
      ? new Date(eta.getTime() + basis.days * FU.DAY) : eta;
    const fit = FU.fitStatus(basis.days == null ? null : effEta, w && w.from, w && w.to, opts);
    return { c, window: w, basisDays: basis.days, basisWarn: basis.warn || null,
      reason: !w ? 'laycan unparsed'
        : (ship && !ship.eta_ecsa ? 'ship has no ETA'
        : (basis.days == null ? 'load outside Santos-basis reach' : null)),
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
    const { cargo, window: w, rows, basis, isTa } = computeCargo2Ship();
    // A selected cargo's laycan outranks the manual window — grey the manual
    // inputs so a leftover window can't look like it's still driving
    for (const id of ['pr_manFrom', 'pr_manTo', 'pr_manBasis']) {
      const el = document.getElementById(id);
      if (el) { el.style.opacity = cargo ? '.4' : '1'; el.title = cargo ? 'Inactive — the selected cargo’s laycan is driving. Clear the cargo to use this window.' : ''; }
    }
    if (!cargo && w && w.manual) {
      const f = w.from ? fmtD(w.from) : '…', t = w.to ? fmtD(w.to) : '…';
      note.textContent = `Manual window ${f} – ${t}, no cargo attached — ${basis && basis.days ? `ETAs adjusted +${basis.days}d for load basis.` : 'raw declared ETAs (Santos basis, no adjustment).'}`;
      note.style.color = 'var(--text-dim)';
    }
    else if (!cargo) note.textContent = 'Pick a cargo — or just set a date window and/or DWT range to browse ships.';
    else if (!w) note.textContent = `Couldn't parse laycan "${cargo.laycan || '—'}" — fix it in the Cargo Book.`;
    else {
      const bits = [];
      if (w.onw) bits.push(`laycan "${cargo.laycan}" open-ended — assumed 20 days`);
      if (basis && basis.warn) bits.push(`⚠ ${basis.warn}`);
      else if (basis && basis.days) bits.push(`ETAs adjusted for load basis: ${basis.label}`);
      note.textContent = bits.join(' · ');
      note.style.color = basis && basis.warn ? 'var(--amber)' : 'var(--text-dim)';
    }
    const shown = rows.filter(r => !w ? true : visible(r));
    const taHot = !!isTa;
    const basisDays = basis && basis.days ? basis.days : 0;
    const etaHead = basisDays
      ? `ETA load (+${basisDays}d)`
      : 'ETA ECSA';
    thead.innerHTML = `<tr><th>Status</th><th>Vessel</th><th>DWT/Blt</th><th>Dely</th><th title="${basisDays ? `Santos-basis ETA shifted +${basisDays}d for the load area — this is her ETA at the load port` : 'Owner-declared ETA bss Santos'}">${etaHead}</th><th>Owner</th>
      <th title="Bunkers on delivery (IFO/MDO) from the grid">BOD</th>
      <th style="text-align:right" title="P6-equivalent offer — the universal comparator">Offer P6</th>
      <th style="text-align:right${taHot ? ';color:var(--accent)' : ''}" title="TA offer from the grid — a ship quoting TA has declared interest in going that way${taHot ? '. TA cargo selected: sorted on this column' : ''}">Hire TA${taHot ? ' ▾' : ''}</th>
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
        <td style="font-family:var(--mono);font-size:12px;font-weight:600" title="${basisDays ? `board ETA ${v.eta_ecsa ? fmtD(shipEta(v)) : '—'} bss Santos, +${basisDays}d to the load` : ''}">${r.eta ? fmtD(r.eta) : '—'}${onw}</td>
        <td>${esc(v.owner || v.source || '—')}</td>
        <td style="font-family:var(--mono);font-size:11px" title="Bunkers on delivery (IFO/MDO)">${esc(v.bunker || (v.bod_ifo != null ? `${v.bod_ifo}/${v.bod_mdo ?? '?'}` : '—'))}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;font-weight:600">${fmtK(r.p6offer)}${r.rawOffer != null && r.p6offer != null ? `<span style="color:var(--text-dim);font-weight:400" title="raw offer"> (${fmtK(r.rawOffer)})</span>` : ''}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px${taHot ? ';font-weight:700;color:var(--accent)' : ''}">${fmtK(r.hireTa)}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px">${fmtK(r.p6bid)}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:12px;color:${r.spread != null && r.spread <= 1000 ? 'var(--green)' : 'var(--text)'}"
            title="Offer minus bid — how far apart the two sides are">${r.spread == null ? '—' : fmtK(r.spread)}</td>
        ${fitCells(r)}</tr>`;
    }).join('') : `<tr><td colspan="12" style="padding:18px;color:var(--text-dim)">${cargo ? 'No ships fit — toggle "Show all" to see the misses.' : 'No open ships on the board.'}</td></tr>`;
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
        <td style="font-family:var(--mono);font-size:12px">${esc(c.laycan || '—')}${r.basisDays ? ` <span style="color:var(--text-dim)" title="ETA adjusted for load basis vs Santos">+${r.basisDays}d bss</span>` : ''}</td>
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
  const c2s = ui.mode === 'cargo2ship';
  document.getElementById('pr_cargoField').style.display = c2s ? '' : 'none';
  document.getElementById('pr_shipField').style.display = c2s ? 'none' : '';
  document.getElementById('pr_ecsaWrap').style.display = c2s ? 'none' : '';
  document.getElementById('pr_manWrap').style.display = c2s ? '' : 'none';
  document.getElementById('pr_dwtWrap').style.display = c2s ? '' : 'none';
  document.getElementById('pr_ageWrap').style.display = c2s ? '' : 'none';
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
          <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">ECSA Pairings</h2>
          <div style="font-size:12px;color:var(--text-dim)">ECSA board ↔ Cargo Book · ETAs are owner-<b>declared</b>, ranked by price — no distance math · for NATL positions (computed ETAs) use the NATL Matcher</div>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px">
        <div class="pr-seg" id="pr_modeSeg">
          <button data-mode="cargo2ship">Cargo → Ships</button>
          <button data-mode="ship2cargo">Ship → Cargoes</button>
        </div>
        <div class="pr-field" id="pr_cargoField"><label>Cargo — type to search</label>
          <div style="display:flex;gap:4px">
            <input id="pr_cargoPick" list="pr_cargoList" placeholder="charterer / load / laycan…" style="width:300px" autocomplete="off">
            <button id="pr_toMatcher" style="display:none;white-space:nowrap;border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;font-size:11px;padding:4px 10px" title="Check the same cargo against NATL positions (computed ETAs from dely port)">NATL ⇢</button>
          </div>
          <datalist id="pr_cargoList"></datalist></div>
        <div class="pr-field" id="pr_shipField"><label>Ship — type to search</label>
          <input id="pr_shipPick" list="pr_shipList" placeholder="vessel name…" style="width:300px" autocomplete="off">
          <datalist id="pr_shipList"></datalist></div>
        <div class="pr-field" id="pr_manWrap" title="Works without a cargo: show ships whose ETA falls in this window. A selected cargo's laycan takes precedence — clear the cargo box to use this.">
          <label>ETA window (no cargo needed)</label>
          <div style="display:flex;gap:4px">
            <input type="date" id="pr_manFrom" value="${esc(ui.manFrom)}">
            <input type="date" id="pr_manTo" value="${esc(ui.manTo)}">
          </div></div>
        <div class="pr-field" id="pr_manBasisWrap" title="Where is she actually loading? Board ETAs are bss Santos — pick the load area and every ship's ETA shifts by the extra steaming. Only applies with a manual window; a selected cargo uses auto basis from her load port.">
          <label>Load basis</label>
          <select id="pr_manBasis" style="width:130px">
            <option value=""${!ui.manBasis ? ' selected' : ''}>Santos (bss)</option>
            <option value="2"${ui.manBasis === '2' ? ' selected' : ''}>N Brazil +2d</option>
            <option value="3"${ui.manBasis === '3' ? ' selected' : ''}>NCSA +3d</option>
            <option value="6.5"${ui.manBasis === '6.5' ? ' selected' : ''}>Carib rim +6.5d</option>
            <option value="7.5"${ui.manBasis === '7.5' ? ' selected' : ''}>Panama +7.5d</option>
          </select></div>
        <div class="pr-field" id="pr_dwtWrap"><label>DWT range</label>
          <div style="display:flex;gap:4px">
            <input type="number" id="pr_minDwt" placeholder="min" style="width:80px" value="${esc(ui.minDwt)}">
            <input type="number" id="pr_maxDwt" placeholder="max" style="width:80px" value="${esc(ui.maxDwt)}">
          </div></div>
        <div class="pr-field" id="pr_ageWrap" title="Ships older than this drop out; unknown build years stay visible"><label>Max age (yrs)</label>
          <input type="number" id="pr_maxAge" placeholder="any" style="width:70px" value="${esc(ui.maxAge)}"></div>
        <button id="pr_clear" title="Clear the cargo, ETA window, DWT range and ± adj — back to a blank search"
          style="align-self:flex-end;border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;padding:7px 14px;color:var(--text-dim)">Clear</button>
        <button id="pr_copy" title="Copy a WhatsApp-ready tonnage list: ships fitting the laycan WITH an offer. ETAs at the load area, no internal comments."
          style="align-self:flex-end;border:1px solid var(--border);background:var(--bg2);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;padding:7px 14px">WhatsApp ⧉</button>
        <div class="pr-field"><label title="Max idle days before layfrom to still count as FITS">Max wait (d)</label>
          <input type="number" id="pr_waitTol" step="0.5" min="0" style="width:70px" value="${ui.waitTolDays}"></div>
        <div class="pr-field"><label>Tight tolerance (d)</label>
          <input type="number" id="pr_tightTol" step="0.5" min="0" style="width:70px" value="${ui.tightTolDays}"></div>
        <div class="pr-field"><label title="Adjust board ETAs for load basis, e.g. upriver +2, north Brazil -1. ETAs are usually quoted bss Santos">ETA ± d</label>
          <input type="number" id="pr_etaAdj" step="0.5" style="width:70px" value="${ui.etaAdjDays}"></div>
        <span class="pr-check" id="pr_autoBasis" title="Correct Santos-basis ETAs for the cargo's actual load area (leg difference from the Cape fork: N Brazil +2d, Caribbean NCSA +6.5d, Balboa +8.5d...)">Auto basis adj</span>
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
    const btn = document.getElementById('pr_toMatcher');
    if (btn) btn.style.display = ui.cargoId ? '' : 'none';
  });
  document.getElementById('pr_toMatcher').addEventListener('click', () => {
    if (ui.cargoId && window.LaycanMatcherSelectCargo) window.LaycanMatcherSelectCargo(ui.cargoId);
  });
  document.getElementById('pr_clear').addEventListener('click', () => {
    ui.cargoId = ''; ui.manFrom = ''; ui.manTo = ''; ui.manBasis = ''; ui.minDwt = ''; ui.maxDwt = ''; ui.maxAge = ''; ui.etaAdjDays = 0;
    saveUi();
    for (const [id, val] of [['pr_cargoPick', ''], ['pr_manFrom', ''], ['pr_manTo', ''], ['pr_manBasis', ''], ['pr_minDwt', ''], ['pr_maxDwt', ''], ['pr_maxAge', ''], ['pr_etaAdj', 0]]) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }
    const b = document.getElementById('pr_toMatcher');
    if (b) b.style.display = 'none';
    render();
  });
  if (ui.cargoId) { const b = document.getElementById('pr_toMatcher'); if (b) b.style.display = ''; }
  on('pr_copy', 'click', prCopy);
  on('pr_shipPick', 'input', e => {
    const t = e.target.value.trim();
    const hit = openShips().find(v => (v.vessel_name || '').toLowerCase() === t.toLowerCase());
    if (hit || t === '') { ui.shipName = hit ? hit.vessel_name : ''; saveUi(); render(); }
  });
  on('pr_manFrom', 'change', e => { ui.manFrom = e.target.value; saveUi(); render(); });
  on('pr_manBasis', 'change', e => { ui.manBasis = e.target.value; saveUi(); render(); });
  on('pr_manTo', 'change', e => { ui.manTo = e.target.value; saveUi(); render(); });
  on('pr_minDwt', 'input', e => { ui.minDwt = e.target.value; saveUi(); render(); });
  on('pr_maxDwt', 'input', e => { ui.maxDwt = e.target.value; saveUi(); render(); });
  on('pr_maxAge', 'input', e => { ui.maxAge = e.target.value; saveUi(); render(); });
  on('pr_waitTol', 'input', e => { ui.waitTolDays = e.target.value; saveUi(); render(); });
  on('pr_tightTol', 'input', e => { ui.tightTolDays = e.target.value; saveUi(); render(); });
  on('pr_etaAdj', 'input', e => { ui.etaAdjDays = e.target.value; saveUi(); render(); });
  for (const [id, key] of [['pr_autoBasis', 'autoBasis'], ['pr_ecsaWrap', 'ecsaOnly'], ['pr_showAll', 'showAll']]) {
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

  // Cross-link hook: NATL Matcher hands a cargo over to check ECSA board ships
  window.PairingsSelectCargo = function (cargoId) {
    window.switchTab('pairings');
    ui.mode = 'cargo2ship';
    ui.cargoId = cargoId;
    saveUi();
    const c = liveCargoes().find(x => x.id === cargoId);
    const inp = document.getElementById('pr_cargoPick');
    if (inp && c) inp.value = cargoLabel(c);
    syncModeUI();
    render();
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
      computeCargo2Ship, computeShip2Cargo, isEcsa, loadBasisAdj, buildPairingsText,
    },
  };
}

})();
