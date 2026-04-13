// ─── Voyages Dashboard ───────────────────────────────────────────────────────

// Data shape:
//   voyageData = { p7: [...], p8: [...] }
//   each voyage = { id, laycan, buyer_seller, bid, offer, cgo_stem, relets, comments, last_update }

let voyageData = JSON.parse(localStorage.getItem('pt_voyages') || '{"p7":[],"p8":[]}');
let voyageRouteHeaders = JSON.parse(localStorage.getItem('pt_voyage_headers') || '{}');
let voyageStemFilters = { p7: 'ALL', p8: 'ALL' };
let voyageFixedExpanded = JSON.parse(localStorage.getItem('pt_voyage_fixed_expanded') || '{"p7":false,"p8":false}');

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
  // Split live vs fixed
  const live = all.filter(v => v.status !== 'FIXED');
  const fixed = all.filter(v => v.status === 'FIXED');

  // Stem filter pills — extract sizes from default header + each voyage's cgo_stem override
  // (only consider live voyages for the filter counts)
  const defaultSize = extractStemSize(getRouteHeader(section)) || '63/10';
  const stemSet = new Set([defaultSize]);
  live.forEach(v => {
    const s = extractStemSize(v.cgo_stem);
    if (s) stemSet.add(s);
  });
  const stems = [...stemSet].sort();
  const stemFilters = document.getElementById(section + 'StemFilters');
  const activeStem = voyageStemFilters[section];
  stemFilters.innerHTML =
    `<button class="voyage-stem-pill ${activeStem === 'ALL' ? 'active' : ''}" onclick="setVoyageStem('${section}','ALL')">All (${live.length})</button>` +
    stems.map(s => {
      const cnt = live.filter(v => {
        const sz = extractStemSize(v.cgo_stem) || defaultSize;
        return sz === s;
      }).length;
      return `<button class="voyage-stem-pill ${activeStem === s ? 'active' : ''}" onclick="setVoyageStem('${section}','${s}')">${s} (${cnt})</button>`;
    }).join('');

  // Filter
  let filtered = live;
  if (activeStem !== 'ALL') {
    filtered = live.filter(v => {
      const sz = extractStemSize(v.cgo_stem) || defaultSize;
      return sz === activeStem;
    });
  }

  // Sort by laycan
  filtered = [...filtered].sort((a, b) => laycanSortKey(a.laycan) - laycanSortKey(b.laycan));

  // Counts
  document.getElementById(section + 'Count').textContent =
    `${live.length} live${fixed.length ? ` · ${fixed.length} fixed` : ''}`;

  // Live table
  const tbody = document.getElementById(section + 'Body');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="voyage-empty">No live voyages. Click "+ Add row" or paste data above.</td></tr>`;
  } else {
    const rows = [];
    let lastMonth = null;
    for (const v of filtered) {
      const month = laycanMonth(v.laycan);
      if (month !== lastMonth) {
        rows.push(`<tr><td colspan="11" class="laycan-month">${month || 'No laycan'}</td></tr>`);
        lastMonth = month;
      }
      rows.push(renderVoyageRow(section, v, false));
    }
    tbody.innerHTML = rows.join('');
  }

  // Fixed section
  renderVoyageFixed(section, fixed);
}

function renderVoyageFixed(section, fixed) {
  const wrap = document.getElementById(section + 'FixedWrap');
  if (!wrap) return;

  if (fixed.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  const expanded = voyageFixedExpanded[section];
  const arrow = expanded ? '&#9660;' : '&#9654;';

  const sortedFixed = [...fixed].sort((a, b) => {
    // Most recently fixed first
    return (b.fixed_at || '').localeCompare(a.fixed_at || '');
  });

  let inner = `<div class="voyage-fixed-toggle" onclick="toggleVoyageFixed('${section}')">
    <span class="arrow">${arrow}</span>
    Fixed (${fixed.length})
  </div>`;

  if (expanded) {
    const rows = sortedFixed.map(v => renderVoyageRow(section, v, true)).join('');
    inner += `<div class="voyage-table-wrap" style="border-radius:0 0 var(--radius) var(--radius);margin-top:0">
      <table class="voyage-table">
        <thead><tr>
          <th>Laycan</th><th>Buyer/Seller</th><th>Bid</th><th>Offer</th><th>Cgo Stem</th><th>Relets</th><th>Comments</th><th>Fixed At</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  wrap.innerHTML = inner;
}

function toggleVoyageFixed(section) {
  voyageFixedExpanded[section] = !voyageFixedExpanded[section];
  localStorage.setItem('pt_voyage_fixed_expanded', JSON.stringify(voyageFixedExpanded));
  renderVoyageSection(section);
}

function renderVoyageRow(section, v, isFixed) {
  const editable = (field, value, cls) => {
    return `<td class="voyage-cell-edit ${cls || ''}" onclick="editVoyageCell(this,'${section}','${v.id}','${field}')">${value || '—'}</td>`;
  };
  // For fixed rows, show fixed_at instead of last_update in the date column
  const dateField = isFixed
    ? `<td class="voyage-update" style="color:var(--green);font-weight:600">${v.fixed_at || '—'}</td>`
    : editable('last_update', v.last_update, 'voyage-update');

  const actionBtn = isFixed
    ? `<button class="btn-remove" onclick="unfixVoyage('${section}','${v.id}')" title="Move back to live" style="border-color:var(--green);color:var(--green)">Unfix</button>`
    : `<button class="voyage-fix-btn" onclick="fixVoyage('${section}','${v.id}')" title="Mark as fixed">✓ Fix</button>`;

  const checked = v.is_133 ? 'checked' : '';
  const draftCell = `<td style="text-align:center"><input type="checkbox" ${checked} onclick="toggle133('${section}','${v.id}')" style="cursor:pointer;width:16px;height:16px;accent-color:var(--accent)"></td>`;

  return `<tr ${isFixed ? 'class="voyage-row-fixed"' : ''}>
    ${editable('laycan', v.laycan)}
    ${editable('buyer_seller', v.buyer_seller)}
    ${editable('bid', v.bid, 'voyage-bid')}
    ${editable('offer', v.offer, 'voyage-offer')}
    ${editable('cgo_stem', v.cgo_stem, 'voyage-stem')}
    ${draftCell}
    ${editable('relets', v.relets)}
    ${editable('comments', v.comments)}
    ${dateField}
    <td style="white-space:nowrap">${actionBtn} <button class="btn-remove" onclick="removeVoyage('${section}','${v.id}')" style="margin-left:4px">x</button></td>
  </tr>`;
}

function toggle133(section, id) {
  const v = voyageData[section].find(x => x.id === id);
  if (!v) return;
  v.is_133 = !v.is_133;
  v.last_update = todayCompact();
  saveVoyages();
  renderVoyageSection(section);
}

function fixVoyage(section, id) {
  const v = voyageData[section].find(x => x.id === id);
  if (!v) return;
  v.status = 'FIXED';
  v.fixed_at = todayCompact();
  saveVoyages();
  renderVoyageSection(section);
}

function unfixVoyage(section, id) {
  const v = voyageData[section].find(x => x.id === id);
  if (!v) return;
  v.status = 'OPEN';
  v.fixed_at = null;
  saveVoyages();
  renderVoyageSection(section);
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
    cgo_stem: '', is_133: false, relets: '', comments: '', last_update: todayCompact(),
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
- is_133: boolean — true if the cgo_stem mentions 13.3 draft (e.g. "13.3M", "13.3m"), or if there's an explicit 13.3 column showing TRUE/checked. Default false.
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

    const cgoStem = cells[4] || '';
    voyages.push({
      laycan,
      buyer_seller: cells[1] || '',
      bid: cells[2] || '',
      offer: cells[3] || '',
      cgo_stem: cgoStem,
      is_133: /13\.3/.test(cgoStem),
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
      is_133: !!p.is_133 || /13\.3/.test(p.cgo_stem || ''),
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
