// ─── App State ────────────────────────────────────────────────────────────────
let vessels = []; // loaded async from API on init
let pendingParsed = null;
let activeFilters = new Set(['ALL']); // multi-select status filters
let p6OfferOnly = localStorage.getItem('pt_p6_offer_only') === '1';
let currentSort = { key: 'eta_ecsa', dir: 'asc' };

// Column visibility AND order — stored in localStorage
const ALL_COLUMNS = ['laycan','vessel','owner','dwt','built','draft','yard','origin','scr','delivery','laycan_date','eta','hire_offer','bb_offer','bki_eqvt','rate_pmt','arrow_eqvt','bunker','p6_bid','bidding_charterer','p6_offer','spread','fixed','route','charterer','date_fixed','last_updated','notes','status','actions'];
const DEFAULT_ORDER = ['laycan','vessel','owner','dwt','built','delivery','eta','p6_bid','bidding_charterer','p6_offer','spread','fixed','route','charterer','date_fixed','last_updated','notes','status','actions'];
let columnOrder = JSON.parse(localStorage.getItem('pt_col_order') || 'null') || [...DEFAULT_ORDER];
let hiddenColumns = new Set(JSON.parse(localStorage.getItem('pt_col_hidden') || '[]'));

// Migrate combined 'specs' column → separate 'dwt' + 'built' columns
const _specsIdx = columnOrder.indexOf('specs');
if (_specsIdx !== -1) {
  const specsHidden = hiddenColumns.has('specs');
  columnOrder.splice(_specsIdx, 1, 'dwt', 'built');
  hiddenColumns.delete('specs');
  if (specsHidden) { hiddenColumns.add('dwt'); hiddenColumns.add('built'); }
}

// Hide new columns by default (existing users won't suddenly see them)
const NEW_HIDDEN_BY_DEFAULT = ['draft','yard','origin','laycan_date','hire_offer','bb_offer','bki_eqvt','rate_pmt','arrow_eqvt','bunker','bidding_charterer','route'];
NEW_HIDDEN_BY_DEFAULT.forEach(c => {
  if (!columnOrder.includes(c)) {
    columnOrder.push(c);
    hiddenColumns.add(c);
  }
});

// Migrate old format
const oldVisible = JSON.parse(localStorage.getItem('pt_columns') || 'null');
if (oldVisible && !localStorage.getItem('pt_col_order')) {
  columnOrder = oldVisible;
  hiddenColumns = new Set(ALL_COLUMNS.filter(c => !oldVisible.includes(c)));
  // Add any columns missing from old order
  ALL_COLUMNS.forEach(c => { if (!columnOrder.includes(c)) columnOrder.push(c); });
  saveColumns();
}

let _saveTimer = null;
let lastSyncStatus = null; // 'ok', 'error', 'pending'

// ─── World clocks ────────────────────────────────────────────────────────────
const WORLD_CLOCKS = [
  { label: 'NY',  tz: 'America/New_York' },
  { label: 'LON', tz: 'Europe/London' },
  { label: 'DXB', tz: 'Asia/Dubai' },
  { label: 'SG',  tz: 'Asia/Singapore' },
];
function updateWorldClocks() {
  const now = new Date();
  for (const { label, tz } of WORLD_CLOCKS) {
    const el = document.getElementById('clock-' + label);
    if (!el) continue;
    try {
      el.textContent = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(now);
    } catch { /* unsupported timezone */ }
  }
}
setInterval(updateWorldClocks, 1000);
document.addEventListener('DOMContentLoaded', updateWorldClocks);

function updateSyncBadge(status, detail) {
  lastSyncStatus = status;
  const badge = document.getElementById('syncBadge');
  if (!badge) return;
  if (status === 'ok') {
    badge.textContent = 'Synced';
    badge.style.cssText = 'font-size:10px;padding:3px 8px;border-radius:10px;background:#EAF3DE;color:#3B6D11;font-weight:500;cursor:pointer';
  } else if (status === 'error') {
    badge.textContent = 'Sync failed';
    badge.title = detail || 'Click to retry';
    badge.style.cssText = 'font-size:10px;padding:3px 8px;border-radius:10px;background:#FAEAEA;color:#A32D2D;font-weight:500;cursor:pointer';
  } else {
    badge.textContent = 'Syncing...';
    badge.style.cssText = 'font-size:10px;padding:3px 8px;border-radius:10px;background:#FAEEDA;color:#BA7517;font-weight:500;cursor:pointer';
  }
}

function save() {
  localStorage.setItem('pt_vessels', JSON.stringify(vessels));
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    updateSyncBadge('pending');
    fetch('/api/vessels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vessels),
    }).then(resp => {
      if (resp.ok) updateSyncBadge('ok');
      else updateSyncBadge('error', `Server returned ${resp.status}`);
    }).catch(err => {
      updateSyncBadge('error', err.message);
    });
  }, 500);
}

function forceSync() {
  updateSyncBadge('pending');
  fetch('/api/vessels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(vessels),
  }).then(resp => {
    if (resp.ok) {
      updateSyncBadge('ok');
      alert('Sync successful — ' + vessels.length + ' vessels pushed to server.');
    } else {
      updateSyncBadge('error', `Server returned ${resp.status}`);
      alert('Sync failed — server returned ' + resp.status + '. Check your Vercel deployment and KV setup.');
    }
  }).catch(err => {
    updateSyncBadge('error', err.message);
    alert('Sync failed — ' + err.message);
  });
}
function touchVessel(idx) { vessels[idx].last_updated = new Date().toISOString(); }
function saveColumns() {
  localStorage.setItem('pt_col_order', JSON.stringify(columnOrder));
  localStorage.setItem('pt_col_hidden', JSON.stringify([...hiddenColumns]));
}
function colVis(col) { return !hiddenColumns.has(col); }

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['','JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${parseInt(d,10)} ${months[parseInt(m,10)]}`;
}

function fmtNum(n) {
  if (n == null) return '';
  return n.toLocaleString();
}

function fmtTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = d.getDate();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = d.getHours().toString().padStart(2,'0');
  const m = d.getMinutes().toString().padStart(2,'0');
  return `${day} ${months[d.getMonth()]} ${h}:${m}`;
}

const STALE_HOURS = 48;
function hoursAgo(isoTs) {
  if (!isoTs) return null;
  return (Date.now() - new Date(isoTs).getTime()) / 36e5;
}
function stalenessTag(isoTs, label) {
  const h = hoursAgo(isoTs);
  if (h === null) return '';
  if (h > STALE_HOURS) {
    const d = h > 48 ? `${Math.floor(h/24)}d` : `${Math.round(h)}h`;
    return `<span class="stale-tag" title="${label} last updated ${d} ago">↻ ${d}</span>`;
  }
  return '';
}

function getP6Values(v) {
  const mc = v.market_colour && v.market_colour[0];
  return { bid: mc ? mc.p6_bid : null, offer: mc ? mc.p6_offer : null };
}

// ─── Multiple bidders ────────────────────────────────────────────────────────
// v.bids = [{ charterer, p6_bid, t }] — canonical source when present.
// Legacy single-bid data (v.market_colour[0].p6_bid + v.bidding_charterer)
// is synthesized on first popup open. getBestBid returns the highest-priced
// entry; that flows through to the existing p6_bid + bidding_charterer fields
// so reports / market / charts keep working unchanged.
function getAllBids(v) {
  if (v.bids && v.bids.length > 0) return v.bids;
  const legacy = getP6Values(v).bid;
  if (legacy != null) {
    return [{ charterer: v.bidding_charterer || '', p6_bid: legacy, t: v.last_updated || null }];
  }
  return [];
}

function getBestBid(v) {
  const bids = getAllBids(v);
  if (bids.length === 0) return null;
  return bids.slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0))[0];
}

// Save a bids array to a vessel and sync derived fields + price_history.
function setVesselBids(idx, bids) {
  const v = vessels[idx];
  if (!v) return;
  v.bids = (bids || []).filter(b => b && b.p6_bid != null);
  const best = getBestBid(v);
  const newBestBid = best ? best.p6_bid : null;
  const newBestBidder = best ? (best.charterer || null) : null;
  const beforeBid = getP6Values(v).bid;

  // Sync derived fields used by everything else
  if (!v.market_colour || !v.market_colour[0]) {
    v.market_colour = [{ route: 'ECSA FH', p6_bid: newBestBid, p6_offer: null, bid_usd: null, offer_usd: null }];
  } else {
    v.market_colour[0].p6_bid = newBestBid;
  }
  v.bidding_charterer = newBestBidder;

  // Log price-history entry if best bid value changed
  if (newBestBid != null && newBestBid !== beforeBid) {
    logPriceChange(v, 'p6_bid', newBestBid, newBestBidder);
  }
  touchVessel(idx);
  save();
}

// Effective route for a vessel: user override (e.g. fixed for TA after being
// quoted on FH) wins; otherwise fall back to the parsed market-colour route;
// final fallback is 'ECSA FH' since that's the desk's primary book.
function getEffectiveRoute(v) {
  if (v.route) return v.route;
  const mc = v.market_colour && v.market_colour[0];
  if (mc && mc.route) return mc.route;
  return 'ECSA FH';
}

function getSpread(v) {
  const p6 = getP6Values(v);
  if (p6.offer != null && p6.bid != null) return p6.offer - p6.bid;
  return null;
}

// ─── Inline Editing ──────────────────────────────────────────────────────────

function startEdit(el, vesselIdx, field, isMono) {
  if (el.querySelector('input')) return; // already editing
  const current = el.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current === '—' || current === '' ? '' : current;
  input.className = 'edit-input' + (isMono ? ' mono' : '');
  input.style.width = Math.max(el.offsetWidth - 8, 50) + 'px';

  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    applyEdit(vesselIdx, field, val);
    renderTable();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { renderTable(); }
  });
}

function currentPriceFor(v, field) {
  if (field === 'p6_bid') return getP6Values(v).bid;
  if (field === 'p6_offer') return getP6Values(v).offer;
  if (field === 'fixed_price') return v.fixed_price;
  return null;
}

function logPriceChange(v, field, value, counterparty) {
  if (value == null) return;
  v.price_history = v.price_history || [];
  v.price_history.push({
    t: new Date().toISOString(),
    field,
    value,
    counterparty: counterparty || null,
  });
  // Cap to most recent 50 entries to keep payloads reasonable
  if (v.price_history.length > 50) v.price_history = v.price_history.slice(-50);
}

function applyEdit(idx, field, val) {
  const v = vessels[idx];
  if (!v) return;
  const isPriceChange = ['p6_bid','p6_offer','fixed_price'].includes(field);
  const beforePrice = isPriceChange ? currentPriceFor(v, field) : null;
  if (isPriceChange) touchVessel(idx);

  switch (field) {
    case 'vessel_name': v.vessel_name = val || null; break;
    case 'owner': v.owner = val || null; break;
    case 'bidding_charterer': v.bidding_charterer = val || null; break;
    case 'route': v.route = val ? val.toUpperCase() : null; break;
    case 'source': v.source = val || null; break;
    case 'dwt': {
      const n = parseFloat(val.replace(/[kK]/g, '').replace(/,/g, ''));
      if (!isNaN(n)) v.dwt = n < 1000 ? n * 1000 : n;
      break;
    }
    case 'build_year': {
      const y = parseInt(val, 10);
      if (!isNaN(y)) v.build_year = y < 100 ? 2000 + y : y;
      break;
    }
    case 'scrubber':
      v.scrubber = val.toLowerCase() === 'yes' || val.toLowerCase() === 'scr' || val === '1' ? true : (val === '' ? null : false);
      break;
    case 'delivery_basis': v.delivery_basis = val ? val.toUpperCase() : null; break;
    case 'eta_ecsa': {
      // Accept "21 APR", "2026-04-21", etc.
      if (val.includes('-')) { v.eta_ecsa = val; }
      else { const d = parseDate(val); if (d) v.eta_ecsa = d; }
      break;
    }
    case 'p6_bid': {
      const n = parseRate(val, 'tc');
      if (v.market_colour && v.market_colour[0]) v.market_colour[0].p6_bid = n;
      else v.market_colour = [{ route: 'ECSA FH', p6_bid: n, p6_offer: null, bid_usd: null, offer_usd: null }];
      break;
    }
    case 'p6_offer': {
      const n = parseRate(val, 'tc');
      if (v.market_colour && v.market_colour[0]) v.market_colour[0].p6_offer = n;
      else v.market_colour = [{ route: 'ECSA FH', p6_bid: null, p6_offer: n, bid_usd: null, offer_usd: null }];
      break;
    }
    case 'fixed_price': {
      const n = parseRate(val, 'tc');
      v.fixed_price = n;
      break;
    }
    case 'charterer': v.charterer = val || null; break;
    case 'date_fixed': {
      if (val.includes('-')) v.date_fixed = val;
      else { const d = parseDate(val); if (d) v.date_fixed = d; }
      break;
    }
    case 'notes': v.notes = val || null; break;
    case 'dwt': {
      const n = parseFloat(val.replace(/[kK]/g, '').replace(/,/g, ''));
      if (!isNaN(n)) v.dwt = n < 1000 ? n * 1000 : n;
      break;
    }
    case 'build_year': {
      const y = parseInt(val, 10);
      if (!isNaN(y)) v.build_year = y < 100 ? 2000 + y : y;
      break;
    }
    case 'draft': {
      const n = parseFloat(val);
      v.draft = isNaN(n) ? null : n;
      break;
    }
    case 'yard': v.yard = val || null; break;
    case 'origin': v.origin = val || null; break;
    case 'laycan_date': v.laycan_date = val || null; break;
    case 'hire_offer': {
      const n = parseFloat((val || '').replace(/[$,]/g, ''));
      v.hire_offer = isNaN(n) ? null : n;
      break;
    }
    case 'bb_offer': {
      const n = parseFloat((val || '').replace(/[$,]/g, ''));
      v.bb_offer = isNaN(n) ? null : n;
      break;
    }
    case 'bki_eqvt': {
      const n = parseFloat((val || '').replace(/[$,]/g, ''));
      v.bki_eqvt = isNaN(n) ? null : n;
      break;
    }
    case 'rate_pmt': {
      const n = parseFloat((val || '').replace(/[$,]/g, ''));
      v.rate_pmt = isNaN(n) ? null : n;
      break;
    }
    case 'arrow_eqvt': {
      const n = parseFloat((val || '').replace(/[$,]/g, ''));
      v.arrow_eqvt = isNaN(n) ? null : n;
      break;
    }
    case 'bunker': v.bunker = val || null; break;
  }

  if (isPriceChange) {
    const after = currentPriceFor(v, field);
    if (after != null && after !== beforePrice) {
      const cp = field === 'p6_bid' ? v.bidding_charterer : v.charterer;
      logPriceChange(v, field, after, cp);
    }
  }

  save();
}

// ─── Bids popup (multiple bidders per vessel) ───────────────────────────────

let _bidsPopupIdx = null;

function openBidsPopup(idx) {
  _bidsPopupIdx = idx;
  const overlay = document.getElementById('bidsPopupOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  renderBidsPopup();
  setTimeout(() => {
    const firstInput = document.querySelector('#bidsPopupBody .bids-row input');
    if (firstInput) firstInput.focus();
  }, 50);
}

function closeBidsPopup() {
  _bidsPopupIdx = null;
  const overlay = document.getElementById('bidsPopupOverlay');
  if (overlay) overlay.classList.remove('open');
}

function renderBidsPopup() {
  if (_bidsPopupIdx == null) return;
  const v = vessels[_bidsPopupIdx];
  if (!v) return;
  const title = document.getElementById('bidsPopupTitle');
  if (title) {
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
    title.textContent = `Bids on ${v.vessel_name || '?'} (${specs})`;
  }
  const body = document.getElementById('bidsPopupBody');
  if (!body) return;
  const bids = getAllBids(v).slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0));
  // Always show one empty row at the end for adding a new bidder
  let html = `<div class="bids-row bids-head">
    <span>Charterer</span><span>P6 Bid</span><span>Updated</span><span></span>
  </div>`;
  bids.forEach((b, i) => {
    const ts = b.t ? fmtTimestamp(b.t) : '—';
    html += `<div class="bids-row" data-i="${i}">
      <input class="bid-cp" value="${(b.charterer || '').replace(/"/g, '&quot;')}" placeholder="(charterer)">
      <input class="bid-px mono" value="${b.p6_bid != null ? b.p6_bid : ''}" type="number" placeholder="0">
      <span class="bid-ts">${ts}</span>
      <button class="bid-remove" onclick="popupRemoveBid(${i})" title="Remove">×</button>
    </div>`;
  });
  // Add-new row
  html += `<div class="bids-row bids-add" data-i="-1">
    <input class="bid-cp" placeholder="(new bidder)">
    <input class="bid-px mono" type="number" placeholder="0">
    <span class="bid-ts">—</span>
    <span></span>
  </div>`;
  body.innerHTML = html;
}

function popupRemoveBid(i) {
  if (_bidsPopupIdx == null) return;
  const v = vessels[_bidsPopupIdx];
  const bids = getAllBids(v).slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0));
  bids.splice(i, 1);
  // Persist v.bids in-place so re-render works, then re-render
  v.bids = bids;
  renderBidsPopup();
}

function popupSaveBids() {
  if (_bidsPopupIdx == null) return;
  const v = vessels[_bidsPopupIdx];
  const existing = getAllBids(v).slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0));
  const rows = document.querySelectorAll('#bidsPopupBody .bids-row');
  const collected = [];
  const nowIso = new Date().toISOString();
  rows.forEach(row => {
    if (row.classList.contains('bids-head')) return;
    const i = parseInt(row.dataset.i, 10);
    const cpInput = row.querySelector('.bid-cp');
    const pxInput = row.querySelector('.bid-px');
    if (!cpInput || !pxInput) return;
    const cp = (cpInput.value || '').trim();
    const px = parseFloat(pxInput.value);
    if (!isFinite(px) || px <= 0) return;
    // Preserve existing timestamp if the bid hasn't changed; otherwise stamp now
    let t = nowIso;
    if (i >= 0 && existing[i]) {
      const prev = existing[i];
      if (prev.p6_bid === px && (prev.charterer || '') === cp) t = prev.t || nowIso;
    }
    collected.push({ charterer: cp || null, p6_bid: px, t });
  });
  setVesselBids(_bidsPopupIdx, collected);
  renderTable();
  closeBidsPopup();
}

// ─── Mode Toggle ─────────────────────────────────────────────────────────────

function setMode(mode) {
  const isManual = mode === 'manual';
  document.getElementById('parsePanel').style.display = isManual ? 'none' : 'flex';
  document.getElementById('manualPanel').style.display = isManual ? 'flex' : 'none';
  document.getElementById('modeParseBtn').classList.toggle('active', !isManual);
  document.getElementById('modeManualBtn').classList.toggle('active', isManual);
  document.getElementById('panelTitleText').textContent = isManual ? 'Manual Entry' : 'WhatsApp Inbox';
}

// ─── Manual Entry ─────────────────────────────────────────────────────────────

function handleManualAdd() {
  const g = id => document.getElementById(id).value.trim();

  const dwtRaw = parseFloat(g('mf_dwt'));
  const dwt = isNaN(dwtRaw) ? null : (dwtRaw < 1000 ? dwtRaw * 1000 : dwtRaw);

  const p6Bid = g('mf_p6_bid') ? parseFloat(g('mf_p6_bid')) : null;
  const p6Offer = g('mf_p6_offer') ? parseFloat(g('mf_p6_offer')) : null;
  const scrubberVal = g('mf_scrubber');

  const vessel = {
    vessel_name: g('mf_vessel_name') || null,
    owner: g('mf_owner') || null,
    source: g('mf_owner') || null,
    dwt,
    build_year: g('mf_build_year') ? parseInt(g('mf_build_year'), 10) : null,
    scrubber: scrubberVal === 'yes' ? true : scrubberVal === 'no' ? false : null,
    current_position: g('mf_current_position') || null,
    delivery_basis: g('mf_delivery_basis') || null,
    open_date: g('mf_open_date') || null,
    eta_ecsa: g('mf_eta_ecsa') || null,
    eta_ecsa_end: null,
    eta_type: g('mf_eta_type') || 'EXACT',
    market_colour: (p6Bid || p6Offer) ? [{
      route: g('mf_route') || 'ECSA FH',
      p6_bid: p6Bid,
      p6_offer: p6Offer,
      bid_usd: null,
      offer_usd: null,
    }] : [],
    status: g('mf_status') || 'OPEN',
    notes: g('mf_notes') || null,
    raw: null,
    parsed_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    parse_warnings: [],
  };

  if (!vessel.vessel_name) {
    alert('Vessel name is required.');
    return;
  }

  const existIdx = vessels.findIndex(v =>
    v.vessel_name && vessel.vessel_name &&
    v.vessel_name.toUpperCase() === vessel.vessel_name.toUpperCase()
  );
  if (existIdx !== -1) {
    vessels[existIdx] = { ...vessels[existIdx], ...vessel };
  } else {
    vessels.push(vessel);
  }

  save(); renderTable(); updateStats();
  handleManualClear();
  setMode('parse');
}

function handleManualClear() {
  ['mf_vessel_name','mf_owner','mf_dwt','mf_build_year','mf_current_position',
   'mf_delivery_basis','mf_open_date','mf_eta_ecsa','mf_p6_bid','mf_p6_offer','mf_notes']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('mf_eta_type').value = 'EXACT';
  document.getElementById('mf_scrubber').value = '';
  document.getElementById('mf_route').value = 'ECSA FH';
  document.getElementById('mf_status').value = 'OPEN';
}

// ─── API Key Management ──────────────────────────────────────────────────────

function saveApiKey(key) {
  localStorage.setItem('pt_api_key', key.trim());
}

function getApiKey() {
  return localStorage.getItem('pt_api_key') || '';
}

function toggleKeyVisibility() {
  const input = document.getElementById('apiKeyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// Load saved key on init
document.addEventListener('DOMContentLoaded', () => {
  const saved = getApiKey();
  if (saved) document.getElementById('apiKeyInput').value = saved;
});

// ─── Claude API Parser ──────────────────────────────────────────────────────

const PARSE_SYSTEM_PROMPT = `You are a dry bulk shipping message parser. Extract vessel tonnage data from WhatsApp messages into structured JSON.

FIELD DEFINITIONS:
- source: The broker who sent the message (before " - " or after "WITH"). This is NOT the owner.
- owner: The vessel owner/operator. The name before " - " is usually the OWNER, not a broker. "CENTROFIN - MV NIRIIS" means CENTROFIN is the owner. "WITH QUADRA MV..." means QUADRA is the broker. If the source appears to be an owner (marketing their own vessel), put the same name in both source and owner.
- vessel_name: Ship name (after MV/MT, without the MV/MT prefix)
- dwt: Deadweight tonnage (number, e.g. 81688). (81/17) means 81,000 DWT built 2017. (81'688DWT) means 81,688 DWT.
- build_year: Year built (4-digit)
- draft: Maximum draft in meters if provided
- scrubber: true if SCR/scrubber/+S mentioned, null if unknown
- current_position: Current port/location
- open_date: Date vessel is open (ISO format YYYY-MM-DD). If range like "10-15 APR", use earliest date.
- eta_ecsa: ETA to ECSA/loading area (ISO format). If range, use earliest.
- eta_ecsa_end: End of ETA range if given (ISO format), null if single date.
- eta_type: "ONW" if onwards/approximate, "EXACT" if firm date
- delivery_basis: Delivery terms (APS ECSA, SANTOS, PARANAGUA, DLOSP, etc.)
- bod_ifo: Bunkers on delivery - IFO/LSFO/HFO quantity in MT
- bod_mdo: Bunkers on delivery - MDO/LSMGO quantity in MT
- bod_basis: BOD basis port (e.g. SANTOS, ENNORE)
- bod_fuel_type: "LSFO/LSMGO" if low-sulphur, null for standard IFO/MDO
- market_colour: Array of rate/offer objects, each with:
  - route: "ECSA FH", "ECSA TA", "USG FH", etc. FEAST = Far East = FH (fronthaul)
  - bid_usd: Bid/market side rate ($/day)
  - offer_usd: Owner's asking rate ($/day). "Rating", "Ideas", "Offers" all mean the offer.
  - bb_usd: Ballast bonus lump sum ($). "19k + 900k" means 19,000/day TC + $900,000 BB.
  - p6_bid: P6 equivalent of bid
  - p6_offer: P6 equivalent of offer. Parse from (p6: X) or (p6 bss X = Y) where Y is the p6 equiv.
- status: "OPEN", "FIXED", "FAILED", "WITHDRAWN". "OFF-MKT" or "EX-OUR CP" = WITHDRAWN. "On subs" or "FXD" or "FIXED" = FIXED.
- notes: The raw offer/rate line verbatim (e.g. "Ideas 21k try less (p6: 17,750 vs 19,200)") plus any extra context (CP notes, cargo details, route preferences). Always include the original rate/offer text here.

IMPORTANT:
- Use current year (${new Date().getFullYear()}) for dates without a year
- Return an array of vessel objects, one per vessel in the input
- Multiple messages may be separated by blank lines
- "RATING 21500" means offer of $21,500/day
- "Ideas 18k" means offer of $18,000/day
- "try 18k infront" means the bid side is $18,000/day
- "ECSA OPT NCSA/FEAST" means route options are ECSA FH or NCSA FH
- If a line contains "(CP ON THIS VSL)" note it but still parse the vessel

Return ONLY valid JSON array. No markdown, no explanation.`;

async function parseWithAPI(rawText) {
  // Try server-side endpoint first (Sonnet, no key needed per device)
  const serverResp = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: rawText }),
  });
  if (serverResp.ok) {
    const vessels = await serverResp.json();
    return vessels.map(v => ({
      ...v,
      raw: rawText,
      parsed_at: new Date().toISOString(),
      parse_warnings: [],
      status: v.status || 'OPEN',
      market_colour: v.market_colour || [],
    }));
  }
  // Surface the actual server error so we can diagnose
  const errBody = await serverResp.json().catch(() => ({}));
  throw new Error(`Server parse failed (${serverResp.status}): ${errBody.error || serverResp.statusText}`);

  // Browser-direct fallback: uses per-device API key + Haiku (existing behaviour)
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set. Enter your Anthropic API key below.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Parse these vessel tonnage messages into JSON:\n\n${rawText}`
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`API error ${response.status}: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const text = data.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No response from API');

  const parsed = JSON.parse(text);
  const vessels = Array.isArray(parsed) ? parsed : [parsed];

  // Add metadata
  return vessels.map(v => ({
    ...v,
    raw: rawText,
    parsed_at: new Date().toISOString(),
    parse_warnings: [],
    status: v.status || 'OPEN',
    market_colour: v.market_colour || []
  }));
}

// ─── Ask the Board (AI Chat) ─────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are Tyler's tonnage board assistant. He is a charterers' broker for Koch on Arrow Shipbroking's Geneva Atlantic desk, focused on Panamax tonnage for ECSA fronthaul (Santos→China soybeans, primarily).

You have read access to his current tonnage board state, attached as text below. Answer his questions directly and concisely with concrete data. Always cite vessel names and key specs (DWT/built) when listing ships. Use markdown tables when comparing multiple vessels.

Conventions you should know:
- "P6" = Baltic P6 (now P8) route benchmark; the universal comparator across vessels
- "Bid" = what charterer/market offers to the vessel; "Offer" = owner's ask
- "Spread" = offer − bid (positive means owner above market)
- ECSA = East Coast South America (Santos / Paranagua)
- TC = time charter; BB = ballast bonus (lump sum to ballast to load port)
- Laycan tags are decade buckets per month: "1-10 May", "11-20 May", "21+ May"
- Status: OPEN, FIXED, FAILED, WITHDRAWN
- Dollar values: format with $ and commas, e.g. $18,500
- Be terse; Tyler reads fast.`;

let chatHistory = []; // [{role, displayText, content}]

function buildBoardSnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  const open = vessels.filter(v => v.status === 'OPEN');
  const fixed = vessels.filter(v => v.status === 'FIXED');
  const onSubs = vessels.filter(v => v.status === 'ON SUBS');
  const failed = vessels.filter(v => v.status === 'FAILED');
  const withdrawn = vessels.filter(v => v.status === 'WITHDRAWN');

  let snap = `BOARD SNAPSHOT (as of ${today})\n`;
  snap += `Total: ${vessels.length} | Open: ${open.length} | On subs: ${onSubs.length} | Fixed: ${fixed.length} | Failed: ${failed.length} | Withdrawn: ${withdrawn.length}\n\n`;

  function rowFor(v) {
    const p6 = getP6Values(v);
    const dwt = v.dwt ? (v.dwt / 1000).toFixed(0) + 'K' : '?';
    const built = v.build_year || '?';
    const eta = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) + (v.eta_type === 'ONW' ? ' ONW' : '') : '';
    const tag = getLaycanPeriod(v.eta_ecsa) || '';
    const owner = v.owner || '';
    const dely = v.delivery_basis || v.current_position || '';
    const bid = p6.bid ? p6.bid.toLocaleString() : '';
    const offer = p6.offer ? p6.offer.toLocaleString() : '';
    const spread = (p6.offer != null && p6.bid != null) ? (p6.offer - p6.bid).toLocaleString() : '';
    const hire = v.hire_offer ? '$' + v.hire_offer.toLocaleString() : '';
    const bb = v.bb_offer ? '$' + v.bb_offer.toLocaleString() : '';
    const charterer = v.charterer || '';
    const fixedPx = v.fixed_price ? v.fixed_price.toLocaleString() : '';
    const dateFixed = v.date_fixed || '';
    const notes = (v.notes || '').replace(/\s+/g, ' ').slice(0, 100);
    return `${v.vessel_name || '?'} | ${dwt}/${built} | ${owner} | ${dely} | ETA ${eta} (${tag}) | bid ${bid} | offer ${offer} | spread ${spread} | hire ${hire} | bb ${bb} | charterer ${charterer} | fixed ${fixedPx} ${dateFixed} | ${notes}`;
  }

  snap += `OPEN VESSELS (${open.length}):\n`;
  open.forEach((v, i) => { snap += `${i + 1}. ${rowFor(v)}\n`; });

  if (fixed.length) {
    snap += `\nFIXED (${fixed.length}):\n`;
    fixed.forEach((v, i) => { snap += `${i + 1}. ${rowFor(v)}\n`; });
  }
  if (onSubs.length) {
    snap += `\nON SUBS (${onSubs.length}):\n`;
    onSubs.forEach((v, i) => { snap += `${i + 1}. ${rowFor(v)}\n`; });
  }

  return snap;
}

function openChat() {
  document.getElementById('chatOverlay').classList.add('open');
  renderChat();
  setTimeout(() => document.getElementById('chatInput').focus(), 50);
}

function closeChat() {
  document.getElementById('chatOverlay').classList.remove('open');
}

function clearChat() {
  chatHistory = [];
  renderChat();
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

function escapeChatHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdownLite(text) {
  return escapeChatHTML(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderChat() {
  const box = document.getElementById('chatMessages');
  if (chatHistory.length === 0) {
    box.innerHTML = `<div class="chat-empty">
      Ask anything about the current board state.
      <div class="chat-suggestions">
        <div class="chat-suggestion" onclick="seedChat(this.textContent)">Cheapest 3 offers in the 11–20 May window</div>
        <div class="chat-suggestion" onclick="seedChat(this.textContent)">Which owners have the widest spreads right now?</div>
        <div class="chat-suggestion" onclick="seedChat(this.textContent)">Summarize fixtures from the last 7 days</div>
        <div class="chat-suggestion" onclick="seedChat(this.textContent)">List vessels with no P6 offer yet</div>
      </div>
    </div>`;
    return;
  }
  box.innerHTML = chatHistory.map(m => `
    <div class="chat-msg ${m.role}${m.error ? ' error' : ''}">
      <div class="chat-msg-role">${m.role === 'user' ? 'You' : m.error ? 'Error' : 'Claude'}</div>
      <div class="chat-msg-body">${renderMarkdownLite(m.displayText)}</div>
    </div>
  `).join('');
  box.scrollTop = box.scrollHeight;
}

function seedChat(text) {
  document.getElementById('chatInput').value = text;
  document.getElementById('chatInput').focus();
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');
  const question = input.value.trim();
  if (!question) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    chatHistory.push({ role: 'assistant', error: true, displayText: 'No Anthropic API key set. Open the Inbox tab and save a key first.' });
    renderChat();
    return;
  }

  // Push user turn (display text only)
  chatHistory.push({ role: 'user', displayText: question });
  input.value = '';
  sendBtn.disabled = true;
  renderChat();

  // Push placeholder assistant turn
  chatHistory.push({ role: 'assistant', displayText: 'Thinking…', pending: true });
  renderChat();

  // Build API messages: attach board snapshot only to the latest user turn
  const snapshot = buildBoardSnapshot();
  const apiMessages = [];
  const userTurns = chatHistory.filter(m => m.role === 'user');
  for (let i = 0; i < chatHistory.length; i++) {
    const m = chatHistory[i];
    if (m.pending) continue;
    if (m.role === 'user') {
      const isLast = m === userTurns[userTurns.length - 1];
      apiMessages.push({
        role: 'user',
        content: isLast ? `${snapshot}\n\n---\n\nQuestion: ${m.displayText}` : m.displayText,
      });
    } else if (m.role === 'assistant' && !m.error) {
      apiMessages.push({ role: 'assistant', content: m.displayText });
    }
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: CHAT_SYSTEM_PROMPT,
        messages: apiMessages,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`API ${resp.status}: ${err.error?.message || resp.statusText}`);
    }
    const data = await resp.json();
    const text = data.content.find(b => b.type === 'text')?.text || '(no response)';
    // Replace pending placeholder with real answer
    const last = chatHistory[chatHistory.length - 1];
    last.displayText = text;
    last.pending = false;
  } catch (e) {
    const last = chatHistory[chatHistory.length - 1];
    last.displayText = e.message || 'Request failed';
    last.error = true;
    last.pending = false;
  } finally {
    sendBtn.disabled = false;
    renderChat();
  }
}

// ─── CSV/TSV Paste Parser ───────────────────────────────────────────────────
// Paste from spreadsheet (tab-separated) or CSV. First row must be headers.
// Known headers (case-insensitive, flexible whitespace/punctuation):
//   vessel, dwt, age, draft, yard, origin, dely (delivery), layday, hire (offer),
//   bb (offer), eta, owner, bki eqvt, rate $/pmt, arrow eqvt, comments, bunker

const CSV_HEADER_MAP = {
  'vessel': 'vessel_name',
  'vessel name': 'vessel_name',
  'name': 'vessel_name',
  'dwt': 'dwt',
  'age': 'build_year_raw', // special parsing
  'built': 'build_year_raw',
  'year': 'build_year_raw',
  'draft': 'draft',
  'yard': 'yard',
  'origin': 'origin',
  'flag': 'origin',
  'dely': 'delivery_basis',
  'delivery': 'delivery_basis',
  'layday': 'laycan_date',
  'laycan': 'laycan_date',
  'open': 'open_date_raw',
  'hire': 'hire_offer',
  'hire (offer)': 'hire_offer',
  'hire offer': 'hire_offer',
  'bb': 'bb_offer',
  'bb (offer)': 'bb_offer',
  'bb offer': 'bb_offer',
  'ballast bonus': 'bb_offer',
  'eta': 'eta_ecsa_raw',
  'owner': 'owner',
  'bki eqvt': 'bki_eqvt',
  'bki equivalent': 'bki_eqvt',
  'bki': 'bki_eqvt',
  'rate $/pmt': 'rate_pmt',
  'rate': 'rate_pmt',
  'rate $': 'rate_pmt',
  '$/pmt': 'rate_pmt',
  'arrow eqvt': 'arrow_eqvt',
  'arrow equivalent': 'arrow_eqvt',
  'arrow': 'arrow_eqvt',
  'comments': 'notes',
  'comment': 'notes',
  'bunker': 'bunker',
  'bunkers': 'bunker',
  'scrubber': 'scrubber_raw',
  'scr': 'scrubber_raw',
};

function normalizeHeader(h) {
  return (h || '')
    .toLowerCase()
    .replace(/[\n\r]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectDelimiter(line) {
  // Prefer tabs; fall back to comma if no tabs
  if (line.indexOf('\t') !== -1) return '\t';
  return ',';
}

// Proper CSV/TSV tokenizer that respects quoted fields spanning multiple lines.
// Returns a 2D array: rows of cells. This is the fix for multi-line headers
// like "HIRE\n(offer)" that would otherwise break a naive line split.
function tokenizeCSV(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && c === delim) {
      row.push(field);
      field = '';
      continue;
    }
    if (!inQuotes && (c === '\n' || c === '\r')) {
      // Handle \r\n as a single line break
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Skip entirely-empty rows
      if (row.some(f => f && f.trim())) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  // Flush last field/row
  if (field || row.length) {
    row.push(field);
    if (row.some(f => f && f.trim())) rows.push(row);
  }
  return rows;
}

// Simple CSV splitter that respects double-quoted fields (for single-line usage)
function splitCSVRow(line, delim) {
  if (delim === '\t') return line.split('\t');
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === delim && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(s.toString().replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function parseAgeField(s) {
  // "Jan-2006" → 2006;  "2016" → 2016;  "16" → 2016
  // Reject "1-Jan" etc. where Excel has dropped the year — would otherwise be misread as 2001.
  if (!s) return null;
  const trimmed = s.trim();
  const m = trimmed.match(/(19|20)\d{2}/);
  if (m) return parseInt(m[0], 10);
  if (/^\d{1,2}$/.test(trimmed)) return 2000 + parseInt(trimmed, 10);
  return null;
}

function parseLaydayDate(s) {
  if (!s) return null;
  // Accept "15-Apr", "15 Apr", "15-Apr-26", "2026-04-15"
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{1,2})[\s-]+([A-Za-z]{3,})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthMap = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const monthKey = m[2].slice(0, 3).toLowerCase();
  const month = monthMap[monthKey];
  if (!month) return null;
  const year = new Date().getFullYear();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Detect if the input looks like tabular data (CSV/TSV with a header row)
function looksLikeCSV(raw) {
  const firstLine = raw.split('\n')[0];
  if (!firstLine) return false;
  const delim = detectDelimiter(firstLine);
  // Use tokenizer so multi-line headers don't break detection
  const rows = tokenizeCSV(raw, delim);
  if (rows.length < 2) return false;
  const headerCells = rows[0].map(c => normalizeHeader(c));
  const vesselHit = headerCells.some(c => CSV_HEADER_MAP[c] === 'vessel_name');
  const others = headerCells.filter(c => CSV_HEADER_MAP[c] && CSV_HEADER_MAP[c] !== 'vessel_name').length;
  return vesselHit && others >= 2;
}

function parseCSVVessels(raw) {
  const firstLine = raw.split('\n')[0];
  const delim = detectDelimiter(firstLine);
  const rows = tokenizeCSV(raw, delim);
  if (rows.length < 2) return { vessels: [], headers: [], mapping: {} };

  // Build column map from header row
  const headerCells = rows[0].map(normalizeHeader);
  const colMap = headerCells.map(h => CSV_HEADER_MAP[h] || null);
  const mapping = {};
  headerCells.forEach((h, i) => { mapping[h || `col${i}`] = colMap[i] || '(skipped)'; });

  const vessels = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].map(c => (c || '').trim());
    if (cells.every(c => !c)) continue;

    const v = {
      vessel_name: null, dwt: null, build_year: null, draft: null, yard: null,
      origin: null, delivery_basis: null, laycan_date: null,
      hire_offer: null, bb_offer: null, eta_ecsa: null, eta_type: null,
      owner: null, bki_eqvt: null, rate_pmt: null, arrow_eqvt: null,
      notes: null, bunker: null, scrubber: null,
      market_colour: [],
      status: 'OPEN',
      raw: cells.join('\t'),
      parsed_at: new Date().toISOString(),
      parse_warnings: [],
    };

    for (let j = 0; j < cells.length; j++) {
      const field = colMap[j];
      const val = cells[j];
      if (!field || !val) continue;

      switch (field) {
        case 'vessel_name':
          v.vessel_name = val.replace(/\s+\d+\s*dwt$/i, '').trim();
          break;
        case 'dwt': {
          const n = parseFloat(val.replace(/[,\s]/g, ''));
          if (!isNaN(n)) v.dwt = n < 1000 ? n * 1000 : n;
          break;
        }
        case 'build_year_raw':
          v.build_year = parseAgeField(val);
          break;
        case 'draft': {
          const n = parseFloat(val);
          if (!isNaN(n)) v.draft = n;
          break;
        }
        case 'yard': v.yard = val; break;
        case 'origin': v.origin = val; break;
        case 'delivery_basis': v.delivery_basis = val.toUpperCase(); break;
        case 'laycan_date': {
          v.laycan_date = val;
          const d = parseLaydayDate(val);
          if (d) v.open_date = d;
          break;
        }
        case 'open_date_raw': {
          const d = parseLaydayDate(val);
          if (d) v.open_date = d;
          break;
        }
        case 'hire_offer': v.hire_offer = parseMoney(val); break;
        case 'bb_offer': v.bb_offer = parseMoney(val); break;
        case 'eta_ecsa_raw': {
          const d = parseLaydayDate(val);
          if (d) { v.eta_ecsa = d; v.eta_type = 'EXACT'; }
          else { v.notes = (v.notes ? v.notes + ' · ' : '') + 'ETA: ' + val; }
          break;
        }
        case 'owner': v.owner = val; break;
        case 'bki_eqvt': v.bki_eqvt = parseMoney(val); break;
        case 'rate_pmt': v.rate_pmt = parseMoney(val); break;
        case 'arrow_eqvt': v.arrow_eqvt = parseMoney(val); break;
        case 'notes': v.notes = val; break;
        case 'bunker': v.bunker = val; break;
        case 'scrubber_raw': {
          const s = val.toLowerCase();
          if (/yes|true|scr|fitted/.test(s)) v.scrubber = true;
          else if (/no|false|none/.test(s)) v.scrubber = false;
          break;
        }
      }
    }

    if (v.hire_offer || v.bki_eqvt) {
      v.market_colour = [{
        route: 'ECSA FH',
        bid_usd: null, offer_usd: v.hire_offer, bb_usd: v.bb_offer,
        p6_bid: null, p6_offer: v.bki_eqvt || null,
        bid_multiple_claims: false, is_bid: false, is_idea: false,
        collecting: false, notes: null,
      }];
    }

    if (v.vessel_name) vessels.push(v);
  }

  return { vessels, headers: headerCells, mapping };
}

// Reconcile CSV upload against the board.
// - New vessel names → added
// - Existing vessels → LEFT UNTOUCHED (manual edits preserved)
// - Existing OPEN vessels NOT in the CSV → marked WITHDRAWN (still on board for history,
//   but filtered out of the active view). FIXED / FAILED / ON SUBS / already-WITHDRAWN
//   ships are not touched, since the user's internal CSV only tracks the live market.
function mergeCSVVessels(newVessels) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const csvNames = new Set(newVessels.map(v => norm(v.vessel_name)).filter(Boolean));
  let added = 0, skipped = 0, withdrawn = 0;

  for (const nv of newVessels) {
    const exists = vessels.some(v => norm(v.vessel_name) === norm(nv.vessel_name));
    if (exists) {
      skipped++;
    } else {
      vessels.push(nv);
      added++;
    }
  }

  const nowIso = new Date().toISOString();
  for (const v of vessels) {
    if (v.status !== 'OPEN') continue;
    if (csvNames.has(norm(v.vessel_name))) continue;
    v.status = 'WITHDRAWN';
    v.last_updated = nowIso;
    withdrawn++;
  }

  return { added, skipped, withdrawn };
}

// ─── Fixture Message Parser ──────────────────────────────────────────────────
// Detects fixture reports (FXD/FIXED) and updates matching vessels on the board

function looksLikeFixtures(raw) {
  // At least one line has FXD or FIXED
  return /\b(?:FXD|FIXED)\b/i.test(raw);
}

function parseFixtureMessages(raw) {
  // Split on double newline (multiple fixtures) or single newline
  const blocks = raw.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  // If only single-line messages, split by single newline
  let messages = blocks;
  if (blocks.length === 1 && blocks[0].split('\n').length > 1) {
    // Each line might be a separate fixture
    messages = blocks[0].split('\n').map(l => l.trim()).filter(Boolean);
  }

  const results = [];
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const today = new Date().toISOString().split('T')[0];

  for (const msg of messages) {
    if (!/\b(?:FXD|FIXED)\b/i.test(msg)) continue;

    // Extract vessel name — look for "MV NAME" or just the first recognizable name
    let vesselName = null;
    const mvMatch = msg.match(/M[VT]\s+([A-Z][A-Z0-9\s]+?)(?:\s*\(|\s+\d|\s+-|\s+PSD|\s+SAILED)/i);
    if (mvMatch) {
      vesselName = mvMatch[1].trim();
    } else {
      // Try: "A/C CHARTERER PMX/KMX ROUTE..." — this is a cargo fixture, vessel unknown
      // Try: first few capitalized words before any numbers/parens
      const firstWords = msg.match(/^([A-Z][A-Z\s]+?)(?:\s*\(|\s+\d|\s+-)/i);
      if (firstWords) vesselName = firstWords[1].trim();
    }

    // Build fixture notes from the full message
    const fixNotes = [];
    if (/\bNFD\b/i.test(msg)) fixNotes.push('NFD');
    if (/\bCNR\b/i.test(msg)) fixNotes.push('CNR');
    if (/\bRNR\b/i.test(msg)) fixNotes.push('RNR');

    // Extract charterer if mentioned: "A/C CHARTERER" or "FXD CHARTERER"
    const acMatch = msg.match(/A\/C\s+([A-Z][A-Z0-9\s]+?)(?:\s+PMX|\s+KMX|\s+\d|\s*$)/i);
    if (acMatch) fixNotes.push('Charterer: ' + acMatch[1].trim());

    // Extract route/cargo details after FXD/FIXED
    const fxdMatch = msg.match(/\b(?:FXD|FIXED)\b\s*(.*)/i);
    if (fxdMatch) {
      let detail = fxdMatch[1].replace(/^[-–—\s]+/, '').trim();
      // Remove NFD/CNR/RNR since we track separately
      detail = detail.replace(/\b(?:NFD|CNR|RNR)\b\s*[,/]?\s*/gi, '').trim();
      // Remove trailing punctuation
      detail = detail.replace(/^[,\s-]+|[,\s-]+$/g, '').trim();
      if (detail) fixNotes.push(detail);
    }

    // Also capture anything before FIXED as context
    const beforeFxd = msg.match(/(.*?)\s*(?:CLEAN\s+)?(?:FXD|FIXED)/i);
    let posInfo = '';
    if (beforeFxd) {
      // Extract ETA/position info
      const etaInfo = beforeFxd[1].match(/ETA\s+\w+\s+\S+/i);
      if (etaInfo) posInfo = etaInfo[0];
    }

    const noteText = fixNotes.filter(Boolean).join(' · ') || 'Fixed';

    // Try to match to existing vessel on the board
    let matched = false;
    if (vesselName) {
      const normName = norm(vesselName);
      const idx = vessels.findIndex(v => norm(v.vessel_name) === normName);
      if (idx !== -1) {
        vessels[idx].status = 'FIXED';
        vessels[idx].date_fixed = vessels[idx].date_fixed || today;
        // Append fixture details to notes
        const existingNotes = vessels[idx].notes || '';
        vessels[idx].notes = existingNotes ? existingNotes + ' · FXD: ' + noteText : 'FXD: ' + noteText;
        vessels[idx].last_updated = new Date().toISOString();
        matched = true;
        results.push({ vessel: vesselName, matched: true, detail: 'Updated to FIXED — ' + noteText });
      } else {
        results.push({ vessel: vesselName, matched: false, detail: 'Not on board — ' + noteText });
      }
    } else {
      // Cargo fixture (no vessel name) — just log it
      const snippet = msg.substring(0, 60) + (msg.length > 60 ? '...' : '');
      results.push({ vessel: '(cargo fixture)', matched: false, detail: snippet });
    }
  }

  return results;
}

// ─── CSV File Upload ─────────────────────────────────────────────────────────

function handleCSVFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    document.getElementById('rawInput').value = text;
    handleParse();
    // Clear the file input so re-uploading the same file works
    event.target.value = '';
  };
  reader.onerror = () => {
    const preview = document.getElementById('previewBox');
    preview.textContent = 'Failed to read file: ' + file.name;
    preview.className = 'preview-box has-error';
  };
  reader.readAsText(file);
}

// ─── Inbox Handlers ──────────────────────────────────────────────────────────

async function handleParse() {
  const raw = document.getElementById('rawInput').value.trim();
  if (!raw) return;
  const preview = document.getElementById('previewBox');
  const btnAdd = document.getElementById('btnAdd');
  const btnParse = document.getElementById('btnParse');

  // Check if this looks like fixture reports (contains FXD or FIXED)
  if (looksLikeFixtures(raw)) {
    const results = parseFixtureMessages(raw);
    if (results.length > 0) {
      save();
      renderTable();
      updateStats();
      const summary = results.map(r => `${r.matched ? '✓' : '?'} ${r.vessel} — ${r.detail}`).join('\n');
      preview.textContent = `Fixtures processed: ${results.length}\n\n${summary}`;
      preview.className = 'preview-box has-content';
      document.getElementById('rawInput').value = '';
      pendingParsed = null;
      btnAdd.disabled = true;
      return;
    }
  }

  // If the paste looks like CSV/TSV with a header row, parse + merge directly (no API)
  if (looksLikeCSV(raw)) {
    try {
      const { vessels: parsed, headers, mapping } = parseCSVVessels(raw);
      if (parsed.length === 0) {
        preview.textContent = 'CSV detected but no valid rows parsed.\n\nHeaders seen: ' + headers.join(' | ');
        preview.className = 'preview-box has-error';
        return;
      }
      const { added, skipped: skippedExisting, withdrawn } = mergeCSVVessels(parsed);
      save();
      renderTable();
      updateStats();

      // Build column mapping debug summary
      const mapped = Object.entries(mapping).filter(([_, v]) => v && v !== '(skipped)');
      const unmapped = Object.entries(mapping).filter(([_, v]) => v === '(skipped)');
      let mapSummary = `Column mapping (${mapped.length} mapped, ${unmapped.length} skipped):\n`;
      mapped.forEach(([h, f]) => { mapSummary += `  ✓ ${h} → ${f}\n`; });
      if (unmapped.length) {
        mapSummary += '\nUnmapped columns (not imported):\n';
        unmapped.forEach(([h]) => { mapSummary += `  • ${h}\n`; });
      }

      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      preview.textContent =
        `CSV parsed: ${parsed.length} row(s) → ${plural(added, 'new vessel added', 'new vessels added')}, ` +
        `${skippedExisting} already on board (left untouched), ` +
        `${plural(withdrawn, 'open ship marked WITHDRAWN', 'open ships marked WITHDRAWN')} (no longer in CSV).\n\n` +
        mapSummary;
      preview.className = 'preview-box has-content';
      document.getElementById('rawInput').value = '';
      pendingParsed = null;
      btnAdd.disabled = true;
    } catch (e) {
      preview.textContent = 'CSV parse error: ' + e.message;
      preview.className = 'preview-box has-error';
    }
    return;
  }

  btnParse.disabled = true;
  btnParse.textContent = 'Parsing...';
  preview.textContent = 'Sending to Claude API...';
  preview.className = 'preview-box';

  try {
    const parsed = await parseWithAPI(raw);
    pendingParsed = parsed;
    const summary = parsed.map(v =>
      `${v.vessel_name || '?'} (${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '?'}/${v.build_year || '?'}) ETA: ${fmtDate(v.eta_ecsa)} ${v.eta_type === 'ONW' ? 'ONW' : ''} [${v.status}]`
    ).join('\n');
    preview.textContent = `AI parsed ${parsed.length} vessel(s):\n${summary}`;
    preview.className = 'preview-box has-content';
    btnAdd.disabled = false;
  } catch (e) {
    preview.textContent = 'Parse error: ' + e.message;
    preview.className = 'preview-box has-error';
    btnAdd.disabled = true;
  } finally {
    btnParse.disabled = false;
    btnParse.textContent = 'Parse (AI)';
  }
}

function handleParseRegex() {
  const raw = document.getElementById('rawInput').value.trim();
  if (!raw) return;
  const preview = document.getElementById('previewBox');
  const btnAdd = document.getElementById('btnAdd');
  try {
    const parsed = parseMultipleMessages(raw);
    pendingParsed = parsed;
    const summary = parsed.map(v =>
      `${v.vessel_name || '?'} (${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '?'}/${v.build_year || '?'}) ETA: ${fmtDate(v.eta_ecsa)} ${v.eta_type === 'ONW' ? 'ONW' : ''} [${v.status}]`
    ).join('\n');
    preview.textContent = `Regex parsed ${parsed.length} vessel(s):\n${summary}`;
    preview.className = 'preview-box has-content';
    btnAdd.disabled = false;
  } catch (e) {
    preview.textContent = 'Regex parse error: ' + e.message;
    preview.className = 'preview-box has-error';
    btnAdd.disabled = true;
  }
}

function mergeMarketColour(existing, incoming, now) {
  // Offers: always take the latest (owner has updated their ask)
  // Bids: keep highest, unless a fresh offer accompanies this message (means market has moved)
  const exMC = existing.market_colour && existing.market_colour[0];
  const inMC = incoming.market_colour && incoming.market_colour[0];
  if (!inMC) return; // nothing to merge

  const hasNewOffer = inMC.offer_usd != null || inMC.p6_offer != null;
  const hasNewBid   = inMC.bid_usd  != null || inMC.p6_bid   != null;

  if (!exMC) {
    existing.market_colour = incoming.market_colour;
    if (hasNewOffer) existing.offer_updated_at = now;
    if (hasNewBid)   existing.bid_updated_at   = now;
    return;
  }

  // Offer — always overwrite with latest
  if (hasNewOffer) {
    exMC.offer_usd  = inMC.offer_usd  ?? exMC.offer_usd;
    exMC.p6_offer   = inMC.p6_offer   ?? exMC.p6_offer;
    exMC.bb_usd     = inMC.bb_usd     ?? exMC.bb_usd;
    // Sync hire_offer top-level field (what the board displays)
    if (inMC.offer_usd != null) existing.hire_offer = inMC.offer_usd;
    if (inMC.bb_usd != null) existing.bb_offer = inMC.bb_usd;
    existing.offer_updated_at = now;
  }

  // Bid — update if: new bid is higher, OR a fresh offer came with this message (market moved)
  if (hasNewBid) {
    const newBid = inMC.p6_bid ?? inMC.bid_usd ?? 0;
    const oldBid = exMC.p6_bid ?? exMC.bid_usd ?? 0;
    if (newBid >= oldBid || hasNewOffer) {
      exMC.bid_usd = inMC.bid_usd ?? exMC.bid_usd;
      exMC.p6_bid  = inMC.p6_bid  ?? exMC.p6_bid;
      existing.bid_updated_at = now;
    }
  }

  // Route — update if incoming has one
  if (inMC.route) exMC.route = inMC.route;
}

function handleAdd() {
  if (!pendingParsed) return;
  const now = new Date().toISOString();
  for (const pv of pendingParsed) {
    const existIdx = vessels.findIndex(v =>
      v.vessel_name && pv.vessel_name &&
      v.vessel_name.toUpperCase() === pv.vessel_name.toUpperCase()
    );
    if (existIdx !== -1) {
      const existing = vessels[existIdx];
      // Smart merge: rates handled separately, non-rate fields overwrite
      mergeMarketColour(existing, pv, now);
      vessels[existIdx] = {
        ...existing,
        ...pv,
        // Rates: mergeMarketColour already handled these — don't let pv clobber them
        market_colour: existing.market_colour,
        hire_offer: existing.hire_offer,
        bb_offer: existing.bb_offer,
        offer_updated_at: existing.offer_updated_at,
        bid_updated_at: existing.bid_updated_at,
        // Preserve owner/notes/status unless incoming has better data
        owner: pv.owner || existing.owner,
        notes: pv.notes || existing.notes,
        status: pv.status !== 'OPEN' ? pv.status : existing.status,
        last_updated: now,
      };
    } else {
      // New vessel — stamp timestamps and sync top-level fields
      const mc = pv.market_colour && pv.market_colour[0];
      if (mc) {
        if (mc.offer_usd != null || mc.p6_offer != null) pv.offer_updated_at = now;
        if (mc.bid_usd  != null || mc.p6_bid   != null) pv.bid_updated_at   = now;
        if (mc.offer_usd != null && !pv.hire_offer) pv.hire_offer = mc.offer_usd;
        if (mc.bb_usd   != null && !pv.bb_offer)   pv.bb_offer   = mc.bb_usd;
      }
      vessels.push(pv);
    }
  }
  save(); renderTable(); updateStats();
  document.getElementById('rawInput').value = '';
  document.getElementById('previewBox').textContent = `Added ${pendingParsed.length} vessel(s).`;
  document.getElementById('previewBox').className = 'preview-box has-content';
  document.getElementById('btnAdd').disabled = true;
  pendingParsed = null;
}

function handleClear() {
  document.getElementById('rawInput').value = '';
  document.getElementById('previewBox').textContent = 'Parsed output will appear here';
  document.getElementById('previewBox').className = 'preview-box';
  document.getElementById('btnAdd').disabled = true;
  pendingParsed = null;
}

async function loadSample() {
  try {
    const resp = await fetch('sample_vessels.json');
    const data = await resp.json();
    vessels = data;
    save(); renderTable(); updateStats();
    document.getElementById('previewBox').textContent = `Loaded ${data.length} sample vessels.`;
    document.getElementById('previewBox').className = 'preview-box has-content';
  } catch (e) {
    // Try embedded data (standalone version)
    if (typeof SAMPLE_DATA !== 'undefined') {
      vessels = SAMPLE_DATA;
      save(); renderTable(); updateStats();
      document.getElementById('previewBox').textContent = `Loaded ${SAMPLE_DATA.length} sample vessels.`;
      document.getElementById('previewBox').className = 'preview-box has-content';
    } else {
      document.getElementById('previewBox').textContent = 'Could not load sample data. Paste messages manually.';
      document.getElementById('previewBox').className = 'preview-box has-error';
    }
  }
}

// ─── Filters ─────────────────────────────────────────────────────────────────

function toggleFilter(f) {
  if (f === 'ALL') {
    // Clicking ALL clears everything and selects ALL
    activeFilters = new Set(['ALL']);
  } else {
    // Remove ALL if it was active
    activeFilters.delete('ALL');
    // Toggle the clicked filter
    if (activeFilters.has(f)) activeFilters.delete(f);
    else activeFilters.add(f);
    // If nothing selected, revert to ALL
    if (activeFilters.size === 0) activeFilters = new Set(['ALL']);
  }
  document.querySelectorAll('#statusFilters .filter-pill').forEach(p => {
    p.classList.toggle('active', activeFilters.has(p.dataset.filter));
  });
  renderTable();
}

function toggleP6OfferFilter() {
  p6OfferOnly = !p6OfferOnly;
  localStorage.setItem('pt_p6_offer_only', p6OfferOnly ? '1' : '0');
  const btn = document.getElementById('p6OfferToggle');
  if (btn) btn.classList.toggle('active', p6OfferOnly);
  renderTable();
}

function clearDateFilter() {
  document.getElementById('etaFrom').value = '';
  document.getElementById('etaTo').value = '';
  renderTable();
}

// ─── Column Visibility & Reordering ──────────────────────────────────────────

const COL_LABELS = {laycan:'Laycan',vessel:'Vessel',owner:'Owner',dwt:'DWT',built:'Built',draft:'Draft',yard:'Yard',origin:'Origin',scr:'SCR',delivery:'Delivery',laycan_date:'Layday',eta:'ETA',hire_offer:'Hire Offer',bb_offer:'BB Offer',bki_eqvt:'BKI Eqvt',rate_pmt:'Rate $/PMT',arrow_eqvt:'Arrow Eqvt',bunker:'Bunker',p6_bid:'P6 Bid',bidding_charterer:'Bidder',p6_offer:'P6 Offer',spread:'Spread',fixed:'Fixed',route:'Route',charterer:'Charterer',date_fixed:'Date Fixed',last_updated:'Updated',notes:'Notes',status:'Status',actions:'Actions'};

function toggleColumnMenu() {
  const menu = document.getElementById('columnMenu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function toggleColumn(col) {
  if (hiddenColumns.has(col)) hiddenColumns.delete(col);
  else hiddenColumns.add(col);
  saveColumns();
  renderTable();
  renderColumnMenu();
}

function renderColumnMenu() {
  const menu = document.getElementById('columnMenu');
  menu.innerHTML = columnOrder.map(c =>
    `<label style="display:block;padding:3px 0;cursor:pointer;font-size:11px"><input type="checkbox" ${!hiddenColumns.has(c)?'checked':''} onchange="toggleColumn('${c}')" style="margin-right:6px">${COL_LABELS[c]||c}</label>`
  ).join('');
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

function sortBy(key) {
  if (currentSort.key === key) {
    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.key = key;
    currentSort.dir = key === 'p6_offer' || key === 'p6_bid' || key === 'spread' || key === 'dwt' ? 'desc' : 'asc';
  }
  renderTable();
}

function getSortValue(v, key) {
  switch (key) {
    case 'laycan': return v.eta_ecsa || '9999-99-99';
    case 'eta_ecsa': return v.eta_ecsa || '9999-99-99';
    case 'p6_bid': return getP6Values(v).bid || 0;
    case 'p6_offer': return getP6Values(v).offer || 0;
    case 'spread': return getSpread(v) || 0;
    case 'fixed_price': return v.fixed_price || 0;
    case 'date_fixed': return v.date_fixed || '9999-99-99';
    case 'last_updated': return v.last_updated || '';
    case 'dwt': return v.dwt || 0;
    case 'build_year': return v.build_year || 0;
    case 'vessel_name': return (v.vessel_name || '').toUpperCase();
    case 'owner': return (v.owner || '').toUpperCase();
    case 'bidding_charterer': return (v.bidding_charterer || '').toUpperCase();
    case 'route': return getEffectiveRoute(v);
    case 'source': return (v.source || '').toUpperCase();
    case 'delivery_basis': return (v.delivery_basis || '').toUpperCase();
    case 'status': return v.status || '';
    case 'draft': return v.draft || 0;
    case 'yard': return (v.yard || '').toUpperCase();
    case 'origin': return (v.origin || '').toUpperCase();
    case 'hire_offer': return v.hire_offer || 0;
    case 'bb_offer': return v.bb_offer || 0;
    case 'bki_eqvt': return v.bki_eqvt || 0;
    case 'rate_pmt': return v.rate_pmt || 0;
    case 'arrow_eqvt': return v.arrow_eqvt || 0;
    case 'bunker': return (v.bunker || '').toUpperCase();
    case 'laycan_date': return v.laycan_date || '';
    default: return '';
  }
}

// ─── Status & Actions ────────────────────────────────────────────────────────

function cycleStatus(idx) {
  const states = ['OPEN', 'FIXED', 'IN HOUSE', 'FAILED', 'WITHDRAWN'];
  const cur = vessels[idx].status || 'OPEN';
  const next = states[(states.indexOf(cur) + 1) % states.length];
  const v = vessels[idx];
  v.status = next;
  touchVessel(idx);

  // Prompt for fixed price and charterer when moving to FIXED
  if (next === 'FIXED' && !v.fixed_price) {
    if (!v.date_fixed) v.date_fixed = new Date().toISOString().split('T')[0];
    const price = prompt(`${v.vessel_name} on subs — enter fixed P6 price:`);
    if (price) {
      const val = parseRate(price, 'tc');
      if (val) v.fixed_price = val;
    }
    const charterer = prompt(`${v.vessel_name} — enter charterer:`);
    if (charterer) v.charterer = charterer.trim();
  }

  // Moving to IN HOUSE = disponent owner pulled it to cover their own cargo.
  // Capture the date and log as a participant activity event (counterparty = owner).
  if (next === 'IN HOUSE') {
    if (!v.date_fixed) v.date_fixed = new Date().toISOString().split('T')[0];
    v.charterer = v.owner ? `${v.owner} (in house)` : 'in house';
    v.price_history = v.price_history || [];
    v.price_history.push({
      t: new Date().toISOString(),
      field: 'in_house',
      value: v.fixed_price || null,
      counterparty: v.owner || null,
    });
    if (v.price_history.length > 50) v.price_history = v.price_history.slice(-50);
  }

  save(); renderTable(); updateStats();
}

// Copy a single vessel's details to the clipboard in WhatsApp format,
// picking the right shape based on its current status.
function copyVesselRow(idx) {
  const v = vessels[idx];
  if (!v) return;
  let text;
  if (v.status === 'FIXED' || v.status === 'IN HOUSE') {
    text = (typeof fixtureToWhatsApp === 'function')
      ? fixtureToWhatsApp(v)
      : (v.vessel_name || '?') + ' — FIXED ' + (v.fixed_price ? '$' + v.fixed_price.toLocaleString() : '');
  } else {
    const p6 = getP6Values(v);
    const type = (p6.offer != null) ? 'offer' : 'bid';
    text = (typeof vesselToWhatsApp === 'function')
      ? vesselToWhatsApp(v, type)
      : (v.vessel_name || '?');
  }
  if (typeof copyToClipboard === 'function') {
    copyToClipboard(text);
  } else {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

// Mark a fixed/in-house vessel as having FAILED and put it back to market.
// - Logs a 'failed' event in price_history so charterer + price are kept for
//   market intelligence (the "we saw $X" memory).
// - Clears bid-side residue (bidding_charterer, p6_bid, charterer, fixed_price,
//   date_fixed). Keeps p6_offer / hire_offer / bb_offer untouched — an owner's
//   ask typically doesn't change just because subs were lifted.
// - Flips status straight to OPEN; appends a "Failed X $Y" note for lineage.
function failVessel(idx) {
  const v = vessels[idx];
  if (!v) return;
  if (v.status !== 'FIXED' && v.status !== 'IN HOUSE') {
    alert('Failed & relist only applies to fixed / in-house vessels.');
    return;
  }
  const counterpartyName = v.charterer || v.bidding_charterer || '(unknown)';
  const priceForNote = v.fixed_price || getP6Values(v).bid;
  const priceTxt = priceForNote ? '$' + priceForNote.toLocaleString() : '';
  if (!confirm(`Mark ${v.vessel_name} as FAILED with ${counterpartyName} ${priceTxt} and put back on market?`)) return;

  // Log the failure to price_history (counterparty = who would have taken it)
  v.price_history = v.price_history || [];
  v.price_history.push({
    t: new Date().toISOString(),
    field: 'failed',
    value: priceForNote || null,
    counterparty: counterpartyName === '(unknown)' ? null : counterpartyName,
  });
  if (v.price_history.length > 50) v.price_history = v.price_history.slice(-50);

  // Snapshot the prior negotiation for the note
  const priorChart = v.charterer || v.bidding_charterer;

  // Flip back to OPEN and wipe stale bid-side fields
  v.status = 'OPEN';
  v.charterer = null;
  v.fixed_price = null;
  v.date_fixed = null;
  v.bidding_charterer = null;
  if (v.market_colour && v.market_colour[0]) {
    v.market_colour[0].p6_bid = null;
    v.market_colour[0].bid_usd = null;
  }
  // p6_offer / hire_offer / bb_offer intentionally kept — owner's ask stands

  const failNote = `Failed ${priorChart || ''}${priceTxt ? ' ' + priceTxt : ''}`.trim();
  v.notes = v.notes ? `${v.notes} · ${failNote}` : failNote;

  touchVessel(idx);
  save(); renderTable(); updateStats();
}

// Bring a fixed/in-house vessel back to the market as a relet.
// - Preserves the original fixture in price_history (synthesises an entry for
//   legacy vessels with no history) so the original charterer keeps credit.
// - Clears stale quote-side fields (p6_bid/offer, hire_offer, bb_offer,
//   bidding_charterer) since they belonged to the previous cycle.
// - Flips status to OPEN and prompts for the new disponent owner (defaulting
//   to the previous charterer — common case in a relet).
function reletVessel(idx) {
  const v = vessels[idx];
  if (!v) return;
  if (v.status !== 'FIXED' && v.status !== 'IN HOUSE') {
    alert('Relet only applies to fixed / in-house vessels.');
    return;
  }
  const suggested = v.charterer || v.owner || '';
  const newOwner = prompt(
    `Relet ${v.vessel_name} back to market.\n\n` +
    `New disponent owner (typically the previous charterer):`,
    suggested
  );
  if (newOwner === null) return; // cancelled

  // 1. Ensure the prior fixture is captured in price_history (so charterer
  //    credit doesn't depend on the soon-to-be-cleared current fields).
  const hist = v.price_history || [];
  const priorField = v.status === 'IN HOUSE' ? 'in_house' : 'fixed_price';
  const priorCp = v.status === 'IN HOUSE' ? v.owner : v.charterer;
  const alreadyLogged = hist.some(h =>
    h.field === priorField && h.value === v.fixed_price && (h.counterparty || '') === (priorCp || '')
  );
  if (!alreadyLogged && v.fixed_price != null) {
    v.price_history = hist.concat({
      t: v.date_fixed ? v.date_fixed + 'T12:00:00' : new Date().toISOString(),
      field: priorField,
      value: v.fixed_price,
      counterparty: priorCp || null,
    });
    if (v.price_history.length > 50) v.price_history = v.price_history.slice(-50);
  }

  // 2. Add an explicit relet event so it shows up in the Activity feed.
  v.price_history = (v.price_history || []).concat({
    t: new Date().toISOString(),
    field: 'relet',
    value: null,
    counterparty: (newOwner || '').trim() || null,
  });
  if (v.price_history.length > 50) v.price_history = v.price_history.slice(-50);

  // 3. Move to OPEN and update owner.
  const priorOwner = v.owner;
  const priorChart = v.charterer;
  v.status = 'OPEN';
  v.owner = (newOwner || '').trim() || v.owner;

  // 4. Clear stale fields from the prior cycle.
  if (v.market_colour && v.market_colour[0]) {
    v.market_colour[0].p6_bid = null;
    v.market_colour[0].p6_offer = null;
    v.market_colour[0].bid_usd = null;
    v.market_colour[0].offer_usd = null;
  }
  v.hire_offer = null;
  v.bb_offer = null;
  v.bidding_charterer = null;
  v.charterer = null;
  v.fixed_price = null;
  v.date_fixed = null;

  // 5. Append a tracking note.
  const reletNote = `Relet ${priorChart ? `from ${priorChart}` : ''}${priorOwner && priorOwner !== v.owner ? ` (prev owner ${priorOwner})` : ''}`.trim();
  v.notes = v.notes ? `${v.notes} · ${reletNote}` : reletNote;

  touchVessel(idx);
  save(); renderTable(); updateStats();
}

function removeVessel(idx) {
  if (!confirm(`Remove ${vessels[idx].vessel_name}?`)) return;
  vessels.splice(idx, 1);
  save(); renderTable(); updateStats();
}

// ─── Render ──────────────────────────────────────────────────────────────────

function updateStats() {
  const open = vessels.filter(v => v.status === 'OPEN').length;
  const fixed = vessels.filter(v => v.status === 'FIXED').length;
  const inhouse = vessels.filter(v => v.status === 'IN HOUSE').length;
  const failed = vessels.filter(v => v.status === 'FAILED').length;
  const withdrawn = vessels.filter(v => v.status === 'WITHDRAWN').length;
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statFixed').textContent = fixed;
  document.getElementById('statTotal').textContent = vessels.length;
  // Filter pill counts
  const ce = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = `(${val})`; };
  ce('cntAll', vessels.length); ce('cntOpen', open);
  ce('cntFixed', fixed); ce('cntInHouse', inhouse); ce('cntFailed', failed); ce('cntWithdrawn', withdrawn);
}

function renderTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const etaFrom = document.getElementById('etaFrom').value;
  const etaTo = document.getElementById('etaTo').value;
  const tbody = document.getElementById('vesselBody');
  const empty = document.getElementById('emptyState');

  let filtered = vessels.filter(v => {
    if (!activeFilters.has('ALL') && !activeFilters.has(v.status)) return false;
    if (etaFrom && (!v.eta_ecsa || v.eta_ecsa < etaFrom)) return false;
    if (etaTo && (!v.eta_ecsa || v.eta_ecsa > etaTo)) return false;
    if (p6OfferOnly) {
      const p6 = getP6Values(v);
      if (p6.offer == null) return false;
    }
    if (search) {
      const hay = `${v.vessel_name||''} ${v.owner||''} ${v.source||''} ${v.current_position||''} ${v.delivery_basis||''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    // ETA/laycan sort: bucket by laycan tag (1-10/11-20/21+ per month),
    // then within each bucket sort by P6 offer ascending. Vessels missing
    // a P6 offer sort to the bottom of the bucket.
    if (currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan') {
      const ka = laycanBucketKey(a.eta_ecsa);
      const kb = laycanBucketKey(b.eta_ecsa);
      if (ka !== kb) {
        const cmp = ka.localeCompare(kb);
        return currentSort.dir === 'desc' ? -cmp : cmp;
      }
      const oa = getP6Values(a).offer;
      const ob = getP6Values(b).offer;
      if (oa == null && ob == null) return 0;
      if (oa == null) return 1;
      if (ob == null) return -1;
      return oa - ob;
    }
    const va = getSortValue(a, currentSort.key);
    const vb = getSortValue(b, currentSort.key);
    let cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    if (currentSort.dir === 'desc') cmp = -cmp;
    return cmp;
  });

  empty.style.display = filtered.length === 0 ? 'block' : 'none';
  document.getElementById('vesselTable').style.display = filtered.length === 0 ? 'none' : '';

  // Build headers dynamically from columnOrder
  const sortKeys = {laycan:'laycan',vessel:'vessel_name',owner:'owner',dwt:'dwt',built:'build_year',scr:null,delivery:'delivery_basis',eta:'eta_ecsa',p6_bid:'p6_bid',bidding_charterer:'bidding_charterer',p6_offer:'p6_offer',spread:'spread',fixed:'fixed_price',route:'route',charterer:'charterer',date_fixed:'date_fixed',last_updated:'last_updated',notes:null,status:'status',actions:null};
  const thClasses = {p6_bid:'col-p6',p6_offer:'col-p6',fixed:'col-fixed'};
  const visCols = columnOrder.filter(c => !hiddenColumns.has(c));
  const headRow = document.querySelector('#vesselHead tr');
  headRow.innerHTML = visCols.map(c => {
    const sk = sortKeys[c];
    const cls = thClasses[c] ? ` class="${thClasses[c]}"` : '';
    const onclick = sk ? ` onclick="sortBy('${sk}')"` : '';
    return `<th${cls}${onclick} draggable="true" data-col="${c}">${COL_LABELS[c]||c}</th>`;
  }).join('');

  let lastLaycan = null;
  const rows = [];

  // Laycan color map — rotating distinct colors per period (3 tiers per month)
  const laycanColors = {
    '1-10 Jan':'0','11-20 Jan':'0','21+ Jan':'0',
    '1-10 Feb':'1','11-20 Feb':'1','21+ Feb':'1',
    '1-10 Mar':'2','11-20 Mar':'2','21+ Mar':'2',
    '1-10 Apr':'3','11-20 Apr':'3','21+ Apr':'3',
    '1-10 May':'4','11-20 May':'4','21+ May':'4',
    '1-10 Jun':'5','11-20 Jun':'5','21+ Jun':'5',
    '1-10 Jul':'0','11-20 Jul':'0','21+ Jul':'0',
    '1-10 Aug':'1','11-20 Aug':'1','21+ Aug':'1',
    '1-10 Sep':'2','11-20 Sep':'2','21+ Sep':'2',
    '1-10 Oct':'3','11-20 Oct':'3','21+ Oct':'3',
    '1-10 Nov':'4','11-20 Nov':'4','21+ Nov':'4',
    '1-10 Dec':'5','11-20 Dec':'5','21+ Dec':'5',
  };

  // Cell renderer map — each column key maps to a function returning HTML
  function cellHTML(col, v, gi) {
    const p6 = getP6Values(v);
    const spread = getSpread(v);
    const laycan = getLaycanPeriod(v.eta_ecsa);
    const lcIdx = laycan ? (laycanColors[laycan] || '0') : null;
    const warnDot = v.parse_warnings && v.parse_warnings.length > 0
      ? `<span class="warn-dot" title="${v.parse_warnings.join('; ')}"></span>` : '';
    const notesText = v.notes || '';
    const notesTrunc = notesText.length > 40 ? notesText.substring(0, 40) + '...' : notesText;
    const statusCls = (v.status || 'OPEN').replace(/\s+/g, '_');

    switch (col) {
      case 'laycan': return laycan ? `<span class="td-laycan laycan-color-${lcIdx}">${laycan}</span>` : '<span style="color:var(--text-dim)">—</span>';
      case 'vessel': {
        const quietH = hoursAgo(v.last_updated);
        const quietBadge = v.status === 'OPEN' && quietH !== null && quietH > 96
          ? `<span class="quiet-badge" title="No update in ${Math.floor(quietH/24)}d — may have gone quiet">?</span>` : '';
        return `<td class="td-vessel editable" onclick="startEdit(this,${gi},'vessel_name',true)">${v.vessel_name || '—'}${warnDot}${quietBadge}</td>`;
      }
      case 'owner': return `<td class="td-owner editable" onclick="startEdit(this,${gi},'owner',false)">${v.owner || '—'}</td>`;
      case 'dwt': return `<td class="td-specs editable" onclick="startEdit(this,${gi},'dwt',true)">${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '—'}</td>`;
      case 'built': return `<td class="td-specs editable" onclick="startEdit(this,${gi},'build_year',true)">${v.build_year || '—'}</td>`;
      case 'scr': return `<td class="editable" onclick="startEdit(this,${gi},'scrubber',false)">${v.scrubber === true ? '<span class="scrubber-yes">SCR</span>' : '<span class="scrubber-unk">—</span>'}</td>`;
      case 'delivery': return `<td class="td-port editable" onclick="startEdit(this,${gi},'delivery_basis',false)">${v.delivery_basis || v.current_position || '—'}</td>`;
      case 'eta': {
        const etaText = v.eta_ecsa ? `${fmtDate(v.eta_ecsa)}${v.eta_ecsa_end ? '–' + fmtDate(v.eta_ecsa_end).split(' ')[0] : ''}${v.eta_type === 'ONW' ? ' <span class="onw-badge">ONW</span>' : ''}` : '—';
        return `<td class="td-eta editable" onclick="startEdit(this,${gi},'eta_ecsa',true)">${etaText}</td>`;
      }
      case 'p6_bid': {
        const all = getAllBids(v);
        const extra = all.length > 1 ? ` <span class="bid-extra-chip" title="${all.length} bidders — click to manage">+${all.length - 1}</span>` : '';
        const tooltip = all.length > 1
          ? all.slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0))
              .map(b => `${b.charterer || '?'} ${fmtNum(b.p6_bid)}`).join(' · ')
          : 'Click to manage bidders';
        const bidStale = stalenessTag(v.bid_updated_at, 'Bid');
        const bidCls = bidStale ? ' stale' : '';
        return `<td class="td-p6 editable${bidCls}" onclick="openBidsPopup(${gi})" title="${tooltip.replace(/"/g,'&quot;')}"><span class="bid">${p6.bid ? fmtNum(p6.bid) : '—'}</span>${extra}${bidStale}</td>`;
      }
      case 'bidding_charterer': {
        const all = getAllBids(v);
        const extra = all.length > 1 ? ` <span class="bid-extra-chip" title="${all.length} bidders">+${all.length - 1}</span>` : '';
        const tooltip = all.length > 1
          ? all.slice().sort((a, b) => (b.p6_bid || 0) - (a.p6_bid || 0))
              .map(b => `${b.charterer || '?'} ${fmtNum(b.p6_bid)}`).join(' · ')
          : 'Click to manage bidders';
        return `<td class="td-owner editable" onclick="openBidsPopup(${gi})" title="${tooltip.replace(/"/g,'&quot;')}">${v.bidding_charterer || '—'}${extra}</td>`;
      }
      case 'route': {
        const eff = getEffectiveRoute(v);
        const isOverride = !!v.route;
        return `<td class="td-port editable" onclick="startEdit(this,${gi},'route',false)" title="Effective route (override of quoted route if set)"><span${isOverride ? ' style="font-weight:600"' : ''}>${eff}</span></td>`;
      }
      case 'p6_offer': {
        const offerStale = stalenessTag(v.offer_updated_at, 'Offer');
        const offerCls = offerStale ? ' stale' : '';
        return `<td class="td-p6 editable${offerCls}" onclick="startEdit(this,${gi},'p6_offer',true)"><span class="offer">${p6.offer ? fmtNum(p6.offer) : '—'}</span>${offerStale}</td>`;
      }
      case 'spread': {
        if (spread == null) return `<td>—</td>`;
        const cls = spread > 0 ? 'spread-pos' : spread < 0 ? 'spread-neg' : 'spread-zero';
        return `<td><span class="td-spread ${cls}">${spread > 0 ? '+' : ''}${fmtNum(spread)}</span></td>`;
      }
      case 'fixed': return `<td class="td-fixed editable" onclick="startEdit(this,${gi},'fixed_price',true)">${v.fixed_price ? fmtNum(v.fixed_price) : '—'}</td>`;
      case 'charterer': return `<td class="td-owner editable" onclick="startEdit(this,${gi},'charterer',false)">${v.charterer || '—'}</td>`;
      case 'date_fixed': return `<td class="td-date editable" onclick="startEdit(this,${gi},'date_fixed',true)">${v.date_fixed ? fmtDate(v.date_fixed) : '—'}</td>`;
      case 'last_updated': return `<td class="td-source">${fmtTimestamp(v.last_updated)}</td>`;
      case 'notes': return `<td class="td-source editable" onclick="startEdit(this,${gi},'notes',false)" title="${notesText.replace(/"/g,'&quot;')}">${notesTrunc || '—'}</td>`;
      case 'status': return `<td><span class="status-badge status-${statusCls}" onclick="cycleStatus(${gi})">${v.status || 'OPEN'}</span></td>`;
      case 'actions': {
        const onSubs = v.status === 'FIXED' || v.status === 'IN HOUSE';
        const reletBtn = onSubs
          ? `<button class="btn-relet" onclick="reletVessel(${gi})" title="Bring back to market as relet">↺</button>`
          : '';
        const failBtn = onSubs
          ? `<button class="btn-fail" onclick="failVessel(${gi})" title="Failed &amp; relist (subs lifted, back to market)">✗</button>`
          : '';
        return `<td class="td-actions">${failBtn}${reletBtn}<button class="btn-copy-row" onclick="copyVesselRow(${gi})" title="Copy vessel details">⧉</button><button class="btn-remove" onclick="removeVessel(${gi})" title="Remove">x</button></td>`;
      }
      // New CSV columns
      case 'draft': return `<td class="td-specs editable" onclick="startEdit(this,${gi},'draft',true)">${v.draft != null ? v.draft : '—'}</td>`;
      case 'yard': return `<td class="td-source editable" onclick="startEdit(this,${gi},'yard',false)">${v.yard || '—'}</td>`;
      case 'origin': return `<td class="td-source editable" onclick="startEdit(this,${gi},'origin',false)">${v.origin || '—'}</td>`;
      case 'laycan_date': return `<td class="td-date editable" onclick="startEdit(this,${gi},'laycan_date',false)">${v.laycan_date || '—'}</td>`;
      case 'hire_offer': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'hire_offer',true)"><span class="offer">${v.hire_offer ? '$' + fmtNum(v.hire_offer) : '—'}</span></td>`;
      case 'bb_offer': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'bb_offer',true)">${v.bb_offer ? '$' + fmtNum(v.bb_offer) : '—'}</td>`;
      case 'bki_eqvt': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'bki_eqvt',true)">${v.bki_eqvt ? '$' + fmtNum(v.bki_eqvt) : '—'}</td>`;
      case 'rate_pmt': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'rate_pmt',true)">${v.rate_pmt ? '$' + v.rate_pmt.toFixed(2) : '—'}</td>`;
      case 'arrow_eqvt': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'arrow_eqvt',true)">${v.arrow_eqvt ? '$' + fmtNum(v.arrow_eqvt) : '—'}</td>`;
      case 'bunker': return `<td class="td-source editable" onclick="startEdit(this,${gi},'bunker',false)">${v.bunker || '—'}</td>`;
      default: return '<td>—</td>';
    }
  }

  for (const v of filtered) {
    const gi = vessels.indexOf(v);
    const laycan = getLaycanPeriod(v.eta_ecsa);

    if ((currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan') && laycan !== lastLaycan) {
      const colorIdx = laycan ? (laycanColors[laycan] || '0') : '0';
      rows.push(`<tr class="group-header group-color-${colorIdx}"><td colspan="99">${laycan || 'NO ETA'}</td></tr>`);
      lastLaycan = laycan;
    }

    const laycanClass = laycan ? 'laycan-' + laycan.toLowerCase().replace(/\s+/g, '-') : '';
    const quietHours = hoursAgo(v.last_updated);
    const isQuiet = v.status === 'OPEN' && quietHours !== null && quietHours > 96;

    // Build cells in column order
    const cells = visCols.map(col => {
      const html = cellHTML(col, v, gi);
      if (col === 'laycan') return `<td>${html}</td>`;
      return html;
    }).join('');

    rows.push(`<tr class="${laycanClass}${isQuiet ? ' row-quiet' : ''}">${cells}</tr>`);
  }

  tbody.innerHTML = rows.join('');

  // Attach drag-and-drop to header cells
  initHeaderDrag();
  updateStats();
}

// ─── Column Drag-and-Drop Reorder ────────────────────────────────────────────

function initHeaderDrag() {
  let dragCol = null;
  document.querySelectorAll('#vesselHead th[draggable]').forEach(th => {
    th.addEventListener('dragstart', e => {
      dragCol = th.dataset.col;
      th.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragend', () => {
      th.classList.remove('dragging');
      document.querySelectorAll('#vesselHead th').forEach(t => t.classList.remove('drag-over'));
      dragCol = null;
    });
    th.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      th.classList.add('drag-over');
    });
    th.addEventListener('dragleave', () => th.classList.remove('drag-over'));
    th.addEventListener('drop', e => {
      e.preventDefault();
      th.classList.remove('drag-over');
      const targetCol = th.dataset.col;
      if (!dragCol || dragCol === targetCol) return;
      // Reorder columnOrder
      const fromIdx = columnOrder.indexOf(dragCol);
      const toIdx = columnOrder.indexOf(targetCol);
      if (fromIdx === -1 || toIdx === -1) return;
      columnOrder.splice(fromIdx, 1);
      columnOrder.splice(toIdx, 0, dragCol);
      saveColumns();
      renderTable();
    });
  });
}

// ─── Draggable Divider ───────────────────────────────────────────────────────

(function initDivider() {
  const divider = document.getElementById('divider');
  const layout = document.querySelector('.layout');
  if (!divider || !layout) return;

  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    let w = e.clientX - rect.left;
    w = Math.max(240, Math.min(w, rect.width - 300));
    layout.style.setProperty('--inbox-width', w + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Always start with localStorage as the baseline so we don't lose data
  const localVessels = JSON.parse(localStorage.getItem('pt_vessels') || '[]');
  vessels = localVessels;

  try {
    updateSyncBadge('pending');
    const resp = await fetch('/api/vessels');
    if (resp.ok) {
      const serverVessels = await resp.json();
      if (Array.isArray(serverVessels) && (serverVessels.length > localVessels.length || localVessels.length === 0)) {
        vessels = serverVessels;
        localStorage.setItem('pt_vessels', JSON.stringify(vessels));
        updateSyncBadge('ok');
      } else if (localVessels.length > (serverVessels?.length || 0)) {
        save(); // pushes local to server, updateSyncBadge happens inside save()
      } else {
        updateSyncBadge('ok');
      }
    } else {
      updateSyncBadge('error', 'Server returned ' + resp.status);
    }
  } catch (e) {
    updateSyncBadge('error', e.message || 'Offline');
  }
  // Restore persisted filter toggle states
  const p6Btn = document.getElementById('p6OfferToggle');
  if (p6Btn && p6OfferOnly) p6Btn.classList.add('active');
  renderTable();
  updateStats();
  renderColumnMenu();
}
init();
