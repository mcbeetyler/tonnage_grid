// ─── Voyages Dashboard ───────────────────────────────────────────────────────

// Data shape:
//   voyageData = { p7: [...], p8: [...] }
//   each voyage = { id, laycan, buyer_seller, bid, offer, cgo_stem, relets, comments, last_update }

let voyageData = JSON.parse(localStorage.getItem('pt_voyages') || '{"p7":[],"p8":[]}');
let voyageRouteHeaders = JSON.parse(localStorage.getItem('pt_voyage_headers') || '{}');
let voyageStemFilters = { p7: 'ALL', p8: 'ALL' };

const DEFAULT_HEADERS = {
  p8: '63/10 SANTOS / N.CHINA 13M 8x/8x 5%ttl',
  p7: 'USG / N.CHINA 13M 8x/8x 5%ttl',
};

function getRouteHeader(section) {
  return voyageRouteHeaders[section] || DEFAULT_HEADERS[section];
}

let _voyageSaveTimer = null;
function saveVoyages() {
  localStorage.setItem('pt_voyages', JSON.stringify(voyageData));
  localStorage.setItem('pt_voyage_headers', JSON.stringify(voyageRouteHeaders));
  clearTimeout(_voyageSaveTimer);
  _voyageSaveTimer = setTimeout(() => {
    fetch('/api/voyages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(voyageData),
    }).catch(() => {});
  }, 500);
}

async function loadVoyagesFromServer() {
  try {
    const resp = await fetch('/api/voyages');
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && (Array.isArray(data.p7) || Array.isArray(data.p8))) {
      voyageData = { p7: data.p7 || [], p8: data.p8 || [] };
      localStorage.setItem('pt_voyages', JSON.stringify(voyageData));
    }
  } catch (e) { /* localStorage fallback */ }
  renderVoyages();
}

// Hook into existing tab switcher
const _origSwitchTab = typeof switchTab === 'function' ? switchTab : null;
window.switchTab = function(tab) {
  if (_origSwitchTab) _origSwitchTab(tab);
  else {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`).classList.add('active');
  }
  if (tab === 'voyages') loadVoyagesFromServer();
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genVoyageId() {
  return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function todayCompact() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}${months[d.getMonth()]}`;
}

// Extract stem size like "63/10", "66/10", "63/13.3" from a stem string
function extractStemSize(stemStr) {
  if (!stemStr) return null;
  const m = stemStr.match(/(\d{2,3})\/(\d{1,2}(?:\.\d+)?)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Get the month from a laycan string for grouping
const MONTH_NAMES_FULL = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const MONTH_NAMES_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function laycanMonth(laycan) {
  if (!laycan) return null;
  const upper = laycan.toUpperCase();
  for (let i = 0; i < MONTH_NAMES_FULL.length; i++) {
    if (upper.includes(MONTH_NAMES_FULL[i])) return MONTH_NAMES_FULL[i];
    if (upper.includes(MONTH_NAMES_ABBR[i])) return MONTH_NAMES_FULL[i];
  }
  return null;
}

function laycanStartDay(laycan) {
  if (!laycan) return 999;
  const m = laycan.match(/^\s*(\d{1,2})/);
  return m ? parseInt(m[1], 10) : 999;
}

function laycanSortKey(laycan) {
  const month = laycanMonth(laycan);
  const monthIdx = month ? MONTH_NAMES_FULL.indexOf(month) : 99;
  return monthIdx * 100 + laycanStartDay(laycan);
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderVoyages() {
  renderVoyageSection('p8');
  renderVoyageSection('p7');
}

function renderVoyageSection(section) {
  // Update header text
  document.getElementById(section + 'RouteName').textContent =
    section.toUpperCase() + ' — ' + getRouteHeader(section);

  const all = voyageData[section] || [];

  // Stem filter pills — extract sizes from default header + each voyage's cgo_stem override
  const defaultSize = extractStemSize(getRouteHeader(section)) || '63/10';
  const stemSet = new Set([defaultSize]);
  all.forEach(v => {
    const s = extractStemSize(v.cgo_stem);
    if (s) stemSet.add(s);
  });
  const stems = [...stemSet].sort();
  const stemFilters = document.getElementById(section + 'StemFilters');
  const activeStem = voyageStemFilters[section];
  stemFilters.innerHTML =
    `<button class="voyage-stem-pill ${activeStem === 'ALL' ? 'active' : ''}" onclick="setVoyageStem('${section}','ALL')">All (${all.length})</button>` +
    stems.map(s => {
      const cnt = all.filter(v => {
        const sz = extractStemSize(v.cgo_stem) || defaultSize;
        return sz === s;
      }).length;
      return `<button class="voyage-stem-pill ${activeStem === s ? 'active' : ''}" onclick="setVoyageStem('${section}','${s}')">${s} (${cnt})</button>`;
    }).join('');

  // Filter
  let filtered = all;
  if (activeStem !== 'ALL') {
    filtered = all.filter(v => {
      const sz = extractStemSize(v.cgo_stem) || defaultSize;
      return sz === activeStem;
    });
  }

  // Sort by laycan
  filtered = [...filtered].sort((a, b) => laycanSortKey(a.laycan) - laycanSortKey(b.laycan));

  // Group by month
  document.getElementById(section + 'Count').textContent = `${all.length} voyage${all.length === 1 ? '' : 's'}`;

  const tbody = document.getElementById(section + 'Body');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="voyage-empty">No voyages yet. Click "+ Add row" or paste data above.</td></tr>`;
    return;
  }

  const rows = [];
  let lastMonth = null;
  for (const v of filtered) {
    const month = laycanMonth(v.laycan);
    if (month !== lastMonth) {
      rows.push(`<tr><td colspan="9" class="laycan-month">${month || 'No laycan'}</td></tr>`);
      lastMonth = month;
    }
    rows.push(renderVoyageRow(section, v));
  }
  tbody.innerHTML = rows.join('');
}

function renderVoyageRow(section, v) {
  const editable = (field, value, cls) => {
    const safeVal = (value || '').toString().replace(/"/g, '&quot;');
    return `<td class="voyage-cell-edit ${cls || ''}" onclick="editVoyageCell(this,'${section}','${v.id}','${field}')">${value || '—'}</td>`;
  };
  return `<tr>
    ${editable('laycan', v.laycan)}
    ${editable('buyer_seller', v.buyer_seller)}
    ${editable('bid', v.bid, 'voyage-bid')}
    ${editable('offer', v.offer, 'voyage-offer')}
    ${editable('cgo_stem', v.cgo_stem, 'voyage-stem')}
    ${editable('relets', v.relets)}
    ${editable('comments', v.comments)}
    ${editable('last_update', v.last_update, 'voyage-update')}
    <td><button class="btn-remove" onclick="removeVoyage('${section}','${v.id}')">x</button></td>
  </tr>`;
}

// ─── Editing ─────────────────────────────────────────────────────────────────

function editVoyageCell(td, section, id, field) {
  if (td.querySelector('input')) return;
  const v = voyageData[section].find(x => x.id === id);
  if (!v) return;
  const current = v[field] || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = 'width:100%;padding:3px 6px;border:2px solid var(--accent);border-radius:4px;font-size:13px;font-family:inherit;outline:none';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim();
    v[field] = newVal;
    // Auto-update last_update timestamp on bid/offer changes
    if (['bid','offer','cgo_stem'].includes(field)) {
      v.last_update = todayCompact();
    }
    saveVoyages();
    renderVoyageSection(section);
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') renderVoyageSection(section);
  });
}

function addVoyageRow(section) {
  const newVoyage = {
    id: genVoyageId(),
    laycan: '', buyer_seller: '', bid: '', offer: '',
    cgo_stem: '', relets: '', comments: '', last_update: todayCompact(),
  };
  voyageData[section].push(newVoyage);
  saveVoyages();
  renderVoyageSection(section);
  // Auto-focus the laycan cell of the new row
  setTimeout(() => {
    const tbody = document.getElementById(section + 'Body');
    const lastEditable = tbody.querySelector('tr:last-child td.voyage-cell-edit');
    if (lastEditable) lastEditable.click();
  }, 50);
}

function removeVoyage(section, id) {
  const v = voyageData[section].find(x => x.id === id);
  if (!v) return;
  if (!confirm(`Remove voyage: ${v.buyer_seller || ''} ${v.laycan || ''}?`)) return;
  voyageData[section] = voyageData[section].filter(x => x.id !== id);
  saveVoyages();
  renderVoyageSection(section);
}

function setVoyageStem(section, stem) {
  voyageStemFilters[section] = stem;
  renderVoyageSection(section);
}

function editRouteHeader(section) {
  const current = getRouteHeader(section);
  const next = prompt(`Edit ${section.toUpperCase()} route header:`, current);
  if (next !== null && next.trim()) {
    voyageRouteHeaders[section] = next.trim();
    saveVoyages();
    renderVoyageSection(section);
  }
}

// ─── Paste Parser ────────────────────────────────────────────────────────────

function toggleVoyagePaste() {
  const body = document.getElementById('voyagePasteBody');
  const arrow = document.getElementById('voyagePasteArrow');
  body.classList.toggle('open');
  arrow.classList.toggle('open');
}

function clearVoyageInput() {
  document.getElementById('voyageInput').value = '';
}

const VOYAGE_SYSTEM_PROMPT = `You are a dry bulk voyage bid/offer parser. Extract voyage entries from spreadsheet paste data into JSON.

The input is tab-separated text from a Google Sheet. Layout:
- Column header row: LAYCAN, BUYER/SELLER, BID, OFFER, CGO STEM, RELETS, COMMENTS, LAST UPDATE
- Month header rows (e.g. "JULY", "AUGUST") — apply to following rows but don't create entries
- Voyage rows with the actual data

OUTPUT FIELDS (use exactly these names):
- laycan: string like "25-30 JULY", "1-5 AUGUST", "10JUL ONW"
- buyer_seller: charterer/owner name like "MINGWAH", "COFCO"
- bid: bid price string like "$40.00", "40", "$42.50" (preserve $ if present)
- offer: offer price string
- cgo_stem: cargo stem string like "66/10 ITAQUI/PRC 13.3M". If empty in row, return empty string (the route default applies).
- relets: relets string (often empty)
- comments: free-text comments like "SEEING MID 42'S"
- last_update: date string like "7Jul", "12Aug"

RULES:
- Skip the column header row
- Skip month-only rows (JULY, AUGUST etc with nothing else)
- Skip empty rows
- If a cell is empty, use empty string ""
- Prepend the month from the most recent month header to the laycan if the laycan doesn't already contain a month name (e.g. row shows "25-30" under "JULY" → laycan="25-30 JULY")

Return ONLY a JSON array of voyage objects. No markdown.`;

async function parseVoyageWithAI(text) {
  const apiKey = localStorage.getItem('pt_api_key') || '';
  if (!apiKey) throw new Error('No API key set');

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
      system: VOYAGE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Parse this voyage data into JSON:\n\n${text}`
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`API error ${response.status}: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const textResp = data.content.find(b => b.type === 'text')?.text;
  if (!textResp) throw new Error('No response from API');

  let jsonText = textResp.trim();
  const mdMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) jsonText = mdMatch[1].trim();

  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseVoyageDataPositional(text) {
  const lines = text.split('\n');
  const voyages = [];
  let currentMonth = null;

  for (const line of lines) {
    const cells = line.split('\t').map(c => c.trim());
    if (cells.every(c => !c)) continue;

    // Detect column header row
    const joined = cells.join(' ').toLowerCase();
    if (/laycan/.test(joined) && /buyer|seller|bid|offer/.test(joined)) continue;

    // Detect month-only row (one cell with just a month name)
    const firstNonEmpty = cells.find(c => c) || '';
    const upperFirst = firstNonEmpty.toUpperCase();
    if (cells.filter(c => c).length === 1 && MONTH_NAMES_FULL.includes(upperFirst)) {
      currentMonth = upperFirst;
      continue;
    }

    // Need at least laycan or buyer
    if (!cells[0] && !cells[1]) continue;

    let laycan = cells[0] || '';
    if (laycan && currentMonth && !laycanMonth(laycan)) {
      laycan = `${laycan} ${currentMonth}`;
    }

    voyages.push({
      laycan,
      buyer_seller: cells[1] || '',
      bid: cells[2] || '',
      offer: cells[3] || '',
      cgo_stem: cells[4] || '',
      relets: cells[5] || '',
      comments: cells[6] || '',
      last_update: cells[7] || '',
    });
  }

  return voyages;
}

async function parseVoyagePaste() {
  const text = document.getElementById('voyageInput').value.trim();
  if (!text) return;
  const section = document.getElementById('voyagePasteSection').value;
  const useAI = document.getElementById('voyageAIToggle')?.checked;

  let parsed;
  if (useAI && localStorage.getItem('pt_api_key')) {
    try {
      parsed = await parseVoyageWithAI(text);
    } catch (e) {
      alert(`AI parse failed: ${e.message}\n\nFalling back to positional parser.`);
      parsed = parseVoyageDataPositional(text);
    }
  } else {
    parsed = parseVoyageDataPositional(text);
  }

  if (!parsed || parsed.length === 0) {
    alert('No voyages parsed.');
    return;
  }

  // Add IDs and append to section
  const today = todayCompact();
  let added = 0;
  for (const p of parsed) {
    voyageData[section].push({
      id: genVoyageId(),
      laycan: p.laycan || '',
      buyer_seller: p.buyer_seller || '',
      bid: p.bid || '',
      offer: p.offer || '',
      cgo_stem: p.cgo_stem || '',
      relets: p.relets || '',
      comments: p.comments || '',
      last_update: p.last_update || today,
    });
    added++;
  }

  saveVoyages();
  renderVoyageSection(section);
  document.getElementById('voyageInput').value = '';
  document.getElementById('voyagePasteBody').classList.remove('open');
  document.getElementById('voyagePasteArrow').classList.remove('open');
  alert(`Added ${added} voyage(s) to ${section.toUpperCase()}.`);
}

// Init if voyages tab is active
if (document.getElementById('tab-voyages') && document.getElementById('tab-voyages').classList.contains('active')) {
  renderVoyages();
}
