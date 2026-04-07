// ─── App State ────────────────────────────────────────────────────────────────
let vessels = []; // loaded async from API on init
let pendingParsed = null;
let activeFilters = new Set(['ALL']); // multi-select status filters
let currentSort = { key: 'eta_ecsa', dir: 'asc' };

// Column visibility AND order — stored in localStorage
const ALL_COLUMNS = ['laycan','vessel','owner','specs','scr','delivery','eta','p6_bid','p6_offer','spread','fixed','charterer','date_fixed','last_updated','notes','status','actions'];
const DEFAULT_ORDER = ['laycan','vessel','owner','specs','delivery','eta','p6_bid','p6_offer','spread','fixed','charterer','date_fixed','last_updated','notes','status','actions'];
let columnOrder = JSON.parse(localStorage.getItem('pt_col_order') || 'null') || [...DEFAULT_ORDER];
let hiddenColumns = new Set(JSON.parse(localStorage.getItem('pt_col_hidden') || '[]'));

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
function save() {
  // Keep localStorage in sync as a fast local cache / offline fallback
  localStorage.setItem('pt_vessels', JSON.stringify(vessels));
  // Debounce API writes so rapid inline edits don't hammer the server
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/api/vessels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vessels),
    }).catch(() => {}); // silent — localStorage is the fallback
  }, 500);
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
- status: "OPEN", "ON SUBS", "FIXED", "FAILED", "WITHDRAWN". "OFF-MKT" or "EX-OUR CP" = WITHDRAWN. "On subs (nfd)" = ON SUBS.
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

function startEditSpecs(el, vesselIdx) {
  if (el.querySelector('input')) return;
  const v = vessels[vesselIdx];
  const dwtVal = v.dwt ? (v.dwt/1000).toFixed(0) : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = `${dwtVal}/${v.build_year || ''}`;
  input.className = 'edit-input mono';
  input.placeholder = '82/19';
  input.style.width = Math.max(el.offsetWidth - 8, 60) + 'px';
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    const match = val.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) {
      applyEdit(vesselIdx, 'dwt', match[1]);
      applyEdit(vesselIdx, 'build_year', match[2]);
    }
    renderTable();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') renderTable();
  });
}

// ─── Inbox Handlers ──────────────────────────────────────────────────────────

async function handleParse() {
  const raw = document.getElementById('rawInput').value.trim();
  if (!raw) return;
  const preview = document.getElementById('previewBox');
  const btnAdd = document.getElementById('btnAdd');
  const btnParse = document.getElementById('btnParse');

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

function clearDateFilter() {
  document.getElementById('etaFrom').value = '';
  document.getElementById('etaTo').value = '';
  renderTable();
}

// ─── Column Visibility & Reordering ──────────────────────────────────────────

const COL_LABELS = {laycan:'Laycan',vessel:'Vessel',owner:'Owner',specs:'DWT/Built',scr:'SCR',delivery:'Delivery',eta:'ETA',p6_bid:'P6 Bid',p6_offer:'P6 Offer',spread:'Spread',fixed:'Fixed',charterer:'Charterer',date_fixed:'Date Fixed',last_updated:'Updated',notes:'Notes',status:'Status',actions:'Actions'};

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
    case 'vessel_name': return (v.vessel_name || '').toUpperCase();
    case 'owner': return (v.owner || '').toUpperCase();
    case 'source': return (v.source || '').toUpperCase();
    case 'delivery_basis': return (v.delivery_basis || '').toUpperCase();
    case 'status': return v.status || '';
    default: return '';
  }
}

// ─── Status & Actions ────────────────────────────────────────────────────────

function cycleStatus(idx) {
  const states = ['OPEN', 'ON SUBS', 'FIXED', 'FAILED', 'WITHDRAWN'];
  const cur = vessels[idx].status || 'OPEN';
  const next = states[(states.indexOf(cur) + 1) % states.length];
  vessels[idx].status = next;
  touchVessel(idx);

  // Prompt for fixed price, charterer, and auto-set date when moving to ON SUBS
  if (next === 'ON SUBS' && !vessels[idx].fixed_price) {
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
  const subs = vessels.filter(v => v.status === 'ON SUBS').length;
  const fixed = vessels.filter(v => v.status === 'FIXED').length;
  const failed = vessels.filter(v => v.status === 'FAILED').length;
  const withdrawn = vessels.filter(v => v.status === 'WITHDRAWN').length;
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statSubs').textContent = subs;
  document.getElementById('statFixed').textContent = fixed;
  document.getElementById('statTotal').textContent = vessels.length;
  // Filter pill counts
  const ce = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = `(${val})`; };
  ce('cntAll', vessels.length); ce('cntOpen', open); ce('cntSubs', subs);
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
    if (search) {
      const hay = `${v.vessel_name||''} ${v.owner||''} ${v.source||''} ${v.current_position||''} ${v.delivery_basis||''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const va = getSortValue(a, currentSort.key);
    const vb = getSortValue(b, currentSort.key);
    let cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    if (currentSort.dir === 'desc') cmp = -cmp;
    if (cmp === 0 && (currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan')) {
      return (getP6Values(b).offer || 0) - (getP6Values(a).offer || 0);
    }
    return cmp;
  });

  empty.style.display = filtered.length === 0 ? 'block' : 'none';
  document.getElementById('vesselTable').style.display = filtered.length === 0 ? 'none' : '';

  // Build headers dynamically from columnOrder
  const sortKeys = {laycan:'laycan',vessel:'vessel_name',owner:'owner',specs:'dwt',scr:null,delivery:'delivery_basis',eta:'eta_ecsa',p6_bid:'p6_bid',p6_offer:'p6_offer',spread:'spread',fixed:'fixed_price',charterer:'charterer',date_fixed:'date_fixed',last_updated:'last_updated',notes:null,status:'status',actions:null};
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

  // Laycan color map — rotating distinct colors per period
  const laycanColors = {
    'FH Jan':'0','LH Jan':'0','FH Feb':'1','LH Feb':'1','FH Mar':'2','LH Mar':'2',
    'FH Apr':'3','LH Apr':'3','FH May':'4','LH May':'4','FH Jun':'5','LH Jun':'5',
    'FH Jul':'0','LH Jul':'0','FH Aug':'1','LH Aug':'1','FH Sep':'2','LH Sep':'2',
    'FH Oct':'3','LH Oct':'3','FH Nov':'4','LH Nov':'4','FH Dec':'5','LH Dec':'5',
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
      case 'specs': return `<td class="td-specs editable" onclick="startEditSpecs(this,${gi})">${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '—'} / ${v.build_year || '—'}</td>`;
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
  try {
    const resp = await fetch('/api/vessels');
    if (resp.ok) {
      vessels = await resp.json();
      localStorage.setItem('pt_vessels', JSON.stringify(vessels)); // refresh cache
    } else {
      // API not available (e.g. standalone mode) — fall back to localStorage
      vessels = JSON.parse(localStorage.getItem('pt_vessels') || '[]');
    }
  } catch (e) {
    // Offline or standalone — fall back to localStorage
    vessels = JSON.parse(localStorage.getItem('pt_vessels') || '[]');
  }
  renderTable();
  updateStats();
  renderColumnMenu();
}
init();
