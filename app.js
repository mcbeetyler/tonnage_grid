// ─── App State ────────────────────────────────────────────────────────────────
let vessels = JSON.parse(localStorage.getItem('pt_vessels') || '[]');
let pendingParsed = null;
let activeFilter = 'ALL';
let currentSort = { key: 'eta_ecsa', dir: 'asc' };

function save() { localStorage.setItem('pt_vessels', JSON.stringify(vessels)); }

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
  }
  save();
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
- source: The broker who sent the message (before " - " or after "WITH")
- owner: The vessel owner/operator (often same as source if owner is marketing directly)
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
- notes: Any additional context (CP notes, cargo details, etc.)

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

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('#statusFilters .filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.filter === f);
  });
  renderTable();
}

function clearDateFilter() {
  document.getElementById('etaFrom').value = '';
  document.getElementById('etaTo').value = '';
  renderTable();
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
  vessels[idx].status = states[(states.indexOf(cur) + 1) % states.length];
  save(); renderTable(); updateStats();
}

function removeVessel(idx) {
  if (!confirm(`Remove ${vessels[idx].vessel_name}?`)) return;
  vessels.splice(idx, 1);
  save(); renderTable(); updateStats();
}

// ─── Render ──────────────────────────────────────────────────────────────────

function updateStats() {
  document.getElementById('statOpen').textContent = vessels.filter(v => v.status === 'OPEN').length;
  document.getElementById('statFixed').textContent = vessels.filter(v => v.status === 'FIXED' || v.status === 'ON SUBS').length;
  document.getElementById('statTotal').textContent = vessels.length;
}

function renderTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const etaFrom = document.getElementById('etaFrom').value;
  const etaTo = document.getElementById('etaTo').value;
  const tbody = document.getElementById('vesselBody');
  const empty = document.getElementById('emptyState');

  let filtered = vessels.filter(v => {
    if (activeFilter !== 'ALL' && v.status !== activeFilter) return false;
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

  let lastLaycan = null;
  const rows = [];

  for (const v of filtered) {
    const gi = vessels.indexOf(v);
    const laycan = getLaycanPeriod(v.eta_ecsa);

    if ((currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan') && laycan !== lastLaycan) {
      rows.push(`<tr class="group-header"><td colspan="13">${laycan || 'NO ETA'}</td></tr>`);
      lastLaycan = laycan;
    }

    const p6 = getP6Values(v);
    const spread = getSpread(v);

    const etaText = v.eta_ecsa
      ? `${fmtDate(v.eta_ecsa)}${v.eta_ecsa_end ? '–' + fmtDate(v.eta_ecsa_end).split(' ')[0] : ''}${v.eta_type === 'ONW' ? ' <span class="onw-badge">ONW</span>' : ''}`
      : '—';

    const laycanBadge = laycan ? `<span class="td-laycan">${laycan}</span>` : '<span style="color:var(--text-dim)">—</span>';
    const scrTag = v.scrubber === true ? '<span class="scrubber-yes">SCR</span>' : '<span class="scrubber-unk">—</span>';

    let spreadCell = '—';
    if (spread != null) {
      const cls = spread > 0 ? 'spread-pos' : spread < 0 ? 'spread-neg' : 'spread-zero';
      spreadCell = `<span class="td-spread ${cls}">${spread > 0 ? '+' : ''}${fmtNum(spread)}</span>`;
    }

    const warnDot = v.parse_warnings && v.parse_warnings.length > 0
      ? `<span class="warn-dot" title="${v.parse_warnings.join('; ')}"></span>` : '';

    const delivery = v.delivery_basis || v.current_position || '—';
    const statusCls = (v.status || 'OPEN').replace(/\s+/g, '_');

    rows.push(`<tr>
      <td>${laycanBadge}</td>
      <td class="td-vessel editable" onclick="startEdit(this,${gi},'vessel_name',true)">${v.vessel_name || '—'}${warnDot}</td>
      <td class="td-owner editable" onclick="startEdit(this,${gi},'owner',false)">${v.owner || '—'}</td>
      <td class="td-source editable" onclick="startEdit(this,${gi},'source',false)">${v.source || '—'}</td>
      <td class="td-specs">${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '—'} / ${v.build_year || '—'}</td>
      <td class="editable" onclick="startEdit(this,${gi},'scrubber',false)">${scrTag}</td>
      <td class="td-port editable" onclick="startEdit(this,${gi},'delivery_basis',false)">${delivery}</td>
      <td class="td-eta editable" onclick="startEdit(this,${gi},'eta_ecsa',true)">${etaText}</td>
      <td class="td-p6 editable" onclick="startEdit(this,${gi},'p6_bid',true)"><span class="bid">${p6.bid ? fmtNum(p6.bid) : '—'}</span></td>
      <td class="td-p6 editable" onclick="startEdit(this,${gi},'p6_offer',true)"><span class="offer">${p6.offer ? fmtNum(p6.offer) : '—'}</span></td>
      <td>${spreadCell}</td>
      <td><span class="status-badge status-${statusCls}" onclick="cycleStatus(${gi})">${v.status || 'OPEN'}</span></td>
      <td><button class="btn-remove" onclick="removeVessel(${gi})">x</button></td>
    </tr>`);
  }

  tbody.innerHTML = rows.join('');
  updateStats();
}

// ─── Init ────────────────────────────────────────────────────────────────────
renderTable();
updateStats();
