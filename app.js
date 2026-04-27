// ─── App State ────────────────────────────────────────────────────────────────
let vessels = []; // loaded async from API on init
let pendingParsed = null;
let activeFilters = new Set(['ALL']); // multi-select status filters
let p6OfferOnly = localStorage.getItem('pt_p6_offer_only') === '1';
let currentSort = { key: 'eta_ecsa', dir: 'asc' };

// Column visibility AND order — stored in localStorage
const ALL_COLUMNS = ['laycan','vessel','owner','dwt','built','draft','yard','origin','scr','delivery','laycan_date','eta','hire_offer','bb_offer','bki_eqvt','rate_pmt','arrow_eqvt','bunker','p6_bid','p6_offer','spread','fixed','charterer','date_fixed','last_updated','notes','status','actions'];
const DEFAULT_ORDER = ['laycan','vessel','owner','dwt','built','delivery','eta','p6_bid','p6_offer','spread','fixed','charterer','date_fixed','last_updated','notes','status','actions'];
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
const NEW_HIDDEN_BY_DEFAULT = ['draft','yard','origin','laycan_date','hire_offer','bb_offer','bki_eqvt','rate_pmt','arrow_eqvt','bunker'];
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

function getP6Values(v) {
  const mc = v.market_colour && v.market_colour[0];
  return { bid: mc ? mc.p6_bid : null, offer: mc ? mc.p6_offer : null };
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

function applyEdit(idx, field, val) {
  const v = vessels[idx];
  if (!v) return;
  // Timestamp on bid/offer/fixed price changes
  if (['p6_bid','p6_offer','fixed_price'].includes(field)) touchVessel(idx);

  switch (field) {
    case 'vessel_name': v.vessel_name = val || null; break;
    case 'owner': v.owner = val || null; break;
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
  save();
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

// Add CSV-parsed vessels into the main vessels array (add-only).
// Dedup: match on normalized vessel_name (case-insensitive, ignoring punctuation).
// Existing vessels are LEFT UNTOUCHED so manual edits aren't clobbered on re-upload.
function mergeCSVVessels(newVessels) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let added = 0, skipped = 0;

  for (const nv of newVessels) {
    const exists = vessels.some(v => norm(v.vessel_name) === norm(nv.vessel_name));
    if (exists) {
      skipped++;
    } else {
      vessels.push(nv);
      added++;
    }
  }

  return { added, skipped };
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
      const { added, skipped: skippedExisting } = mergeCSVVessels(parsed);
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

      preview.textContent = `CSV parsed: ${parsed.length} row(s) → ${added} new vessel${added === 1 ? '' : 's'} added, ${skippedExisting} already on board (left untouched).\n\n` + mapSummary;
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

  const apiKey = getApiKey();
  if (!apiKey) {
    // Fall back to regex if no API key
    handleParseRegex();
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
    preview.textContent = 'AI parse error: ' + e.message + '\n\nTrying regex fallback...';
    preview.className = 'preview-box has-error';
    // Auto-fallback to regex
    try {
      const parsed = parseMultipleMessages(raw);
      pendingParsed = parsed;
      const summary = parsed.map(v =>
        `${v.vessel_name || '?'} (${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '?'}/${v.build_year || '?'}) ETA: ${fmtDate(v.eta_ecsa)} ${v.eta_type === 'ONW' ? 'ONW' : ''} [${v.status}]`
      ).join('\n');
      preview.textContent = `Regex fallback parsed ${parsed.length} vessel(s):\n${summary}`;
      preview.className = 'preview-box has-content';
      btnAdd.disabled = false;
    } catch (e2) {
      preview.textContent = 'Both AI and regex parsing failed:\n' + e.message + '\n' + e2.message;
      preview.className = 'preview-box has-error';
      btnAdd.disabled = true;
    }
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

function handleAdd() {
  if (!pendingParsed) return;
  for (const pv of pendingParsed) {
    const existIdx = vessels.findIndex(v =>
      v.vessel_name && pv.vessel_name &&
      v.vessel_name.toUpperCase() === pv.vessel_name.toUpperCase()
    );
    if (existIdx !== -1) {
      const existing = vessels[existIdx];
      vessels[existIdx] = { ...existing, ...pv, owner: pv.owner || existing.owner, notes: pv.notes || existing.notes, status: pv.status !== 'OPEN' ? pv.status : existing.status };
    } else {
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

const COL_LABELS = {laycan:'Laycan',vessel:'Vessel',owner:'Owner',dwt:'DWT',built:'Built',draft:'Draft',yard:'Yard',origin:'Origin',scr:'SCR',delivery:'Delivery',laycan_date:'Layday',eta:'ETA',hire_offer:'Hire Offer',bb_offer:'BB Offer',bki_eqvt:'BKI Eqvt',rate_pmt:'Rate $/PMT',arrow_eqvt:'Arrow Eqvt',bunker:'Bunker',p6_bid:'P6 Bid',p6_offer:'P6 Offer',spread:'Spread',fixed:'Fixed',charterer:'Charterer',date_fixed:'Date Fixed',last_updated:'Updated',notes:'Notes',status:'Status',actions:'Actions'};

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
  const states = ['OPEN', 'FIXED', 'FAILED', 'WITHDRAWN'];
  const cur = vessels[idx].status || 'OPEN';
  const next = states[(states.indexOf(cur) + 1) % states.length];
  vessels[idx].status = next;
  touchVessel(idx);

  // Prompt for fixed price and charterer when moving to FIXED
  if (next === 'FIXED' && !vessels[idx].fixed_price) {
    if (!vessels[idx].date_fixed) vessels[idx].date_fixed = new Date().toISOString().split('T')[0];
    const price = prompt(`${vessels[idx].vessel_name} on subs — enter fixed P6 price:`);
    if (price) {
      const val = parseRate(price, 'tc');
      if (val) vessels[idx].fixed_price = val;
    }
    const charterer = prompt(`${vessels[idx].vessel_name} — enter charterer:`);
    if (charterer) vessels[idx].charterer = charterer.trim();
  }

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
  const failed = vessels.filter(v => v.status === 'FAILED').length;
  const withdrawn = vessels.filter(v => v.status === 'WITHDRAWN').length;
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statFixed').textContent = fixed;
  document.getElementById('statTotal').textContent = vessels.length;
  // Filter pill counts
  const ce = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = `(${val})`; };
  ce('cntAll', vessels.length); ce('cntOpen', open);
  ce('cntFixed', fixed); ce('cntFailed', failed); ce('cntWithdrawn', withdrawn);
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
  const sortKeys = {laycan:'laycan',vessel:'vessel_name',owner:'owner',dwt:'dwt',built:'build_year',scr:null,delivery:'delivery_basis',eta:'eta_ecsa',p6_bid:'p6_bid',p6_offer:'p6_offer',spread:'spread',fixed:'fixed_price',charterer:'charterer',date_fixed:'date_fixed',last_updated:'last_updated',notes:null,status:'status',actions:null};
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
      case 'vessel': return `<td class="td-vessel editable" onclick="startEdit(this,${gi},'vessel_name',true)">${v.vessel_name || '—'}${warnDot}</td>`;
      case 'owner': return `<td class="td-owner editable" onclick="startEdit(this,${gi},'owner',false)">${v.owner || '—'}</td>`;
      case 'dwt': return `<td class="td-specs editable" onclick="startEdit(this,${gi},'dwt',true)">${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '—'}</td>`;
      case 'built': return `<td class="td-specs editable" onclick="startEdit(this,${gi},'build_year',true)">${v.build_year || '—'}</td>`;
      case 'scr': return `<td class="editable" onclick="startEdit(this,${gi},'scrubber',false)">${v.scrubber === true ? '<span class="scrubber-yes">SCR</span>' : '<span class="scrubber-unk">—</span>'}</td>`;
      case 'delivery': return `<td class="td-port editable" onclick="startEdit(this,${gi},'delivery_basis',false)">${v.delivery_basis || v.current_position || '—'}</td>`;
      case 'eta': {
        const etaText = v.eta_ecsa ? `${fmtDate(v.eta_ecsa)}${v.eta_ecsa_end ? '–' + fmtDate(v.eta_ecsa_end).split(' ')[0] : ''}${v.eta_type === 'ONW' ? ' <span class="onw-badge">ONW</span>' : ''}` : '—';
        return `<td class="td-eta editable" onclick="startEdit(this,${gi},'eta_ecsa',true)">${etaText}</td>`;
      }
      case 'p6_bid': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'p6_bid',true)"><span class="bid">${p6.bid ? fmtNum(p6.bid) : '—'}</span></td>`;
      case 'p6_offer': return `<td class="td-p6 editable" onclick="startEdit(this,${gi},'p6_offer',true)"><span class="offer">${p6.offer ? fmtNum(p6.offer) : '—'}</span></td>`;
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
      case 'actions': return `<td><button class="btn-remove" onclick="removeVessel(${gi})">x</button></td>`;
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

    // Build cells in column order
    const cells = visCols.map(col => {
      const html = cellHTML(col, v, gi);
      // cellHTML returns full <td> for most, but laycan returns just inner HTML
      if (col === 'laycan') return `<td>${html}</td>`;
      return html;
    }).join('');

    rows.push(`<tr class="${laycanClass}">${cells}</tr>`);
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
