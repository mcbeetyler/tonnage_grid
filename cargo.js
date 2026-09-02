// ─── Cargo Book Dashboard ────────────────────────────────────────────────────

// Tab switching
function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`).classList.add('active');
  if (tab === 'cargo') {
    loadCargoFromServer();
  }
}

// ─── Cargo State ─────────────────────────────────────────────────────────────

// Current cargoes = IDs present in the latest paste (what's "live" in the market)
// History = every cargo ever seen, with first_seen/last_seen timestamps
let cargoHistory = JSON.parse(localStorage.getItem('pt_cargo_history') || '[]');
let cargoCurrent = JSON.parse(localStorage.getItem('pt_cargo_current') || '[]');
let activeCargoStem = 'ALL';
let activeCargoView = 'current'; // 'current' or 'trends'
let trendGranularity = 'weekly';  // 'daily', 'weekly', 'monthly'
let trendChart = null;

// Get the currently visible (non-departed) cargoes for the dashboard view
function getCargoData() {
  return cargoHistory.filter(c => cargoCurrent.includes(c.id));
}

// Deterministic ID for a cargo: charterer + cargo + load + disch + laycan + updated
function cargoId(c) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  return `${norm(c.charterer)}|${norm(c.cargo)}|${norm(c.load)}|${norm(c.disch)}|${norm(c.laycan)}|${norm(c.updated)}`;
}

function updateCargoSyncBadge(status, detail) {
  const badge = document.getElementById('cargoSyncBadge');
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

function forceCargoSync() {
  updateCargoSyncBadge('pending');
  fetch('/api/cargo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history: cargoHistory, current: cargoCurrent }),
  }).then(resp => {
    if (resp.ok) {
      updateCargoSyncBadge('ok');
      alert('Cargo sync successful — ' + cargoHistory.length + ' history entries pushed.');
    } else {
      updateCargoSyncBadge('error', `Server returned ${resp.status}`);
      alert('Cargo sync failed — server returned ' + resp.status + '.');
    }
  }).catch(err => {
    updateCargoSyncBadge('error', err.message);
    alert('Cargo sync failed — ' + err.message);
  });
}

let _cargoSaveTimer = null;
function saveCargo() {
  localStorage.setItem('pt_cargo_history', JSON.stringify(cargoHistory));
  localStorage.setItem('pt_cargo_current', JSON.stringify(cargoCurrent));
  clearTimeout(_cargoSaveTimer);
  _cargoSaveTimer = setTimeout(() => {
    updateCargoSyncBadge('pending');
    fetch('/api/cargo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: cargoHistory, current: cargoCurrent }),
    }).then(resp => {
      if (resp.ok) updateCargoSyncBadge('ok');
      else updateCargoSyncBadge('error', `Server returned ${resp.status}`);
    }).catch(err => {
      updateCargoSyncBadge('error', err.message);
    });
  }, 500);
}

async function loadCargoFromServer() {
  try {
    const resp = await fetch('/api/cargo');
    if (!resp.ok) { backfillEnteredMarket(); renderCargo(); return; }
    const data = await resp.json();
    if (!data || !Array.isArray(data.history)) { backfillEnteredMarket(); renderCargo(); return; }

    const serverHist = data.history;
    const localHist = cargoHistory || [];

    // Only overwrite local with server data if server has MORE entries, or local is empty.
    // Protects against losing local edits when server returns empty.
    if (serverHist.length > localHist.length || localHist.length === 0) {
      cargoHistory = serverHist;
      cargoCurrent = data.current || [];
      localStorage.setItem('pt_cargo_history', JSON.stringify(cargoHistory));
      localStorage.setItem('pt_cargo_current', JSON.stringify(cargoCurrent));
    } else if (localHist.length > serverHist.length) {
      // Local is ahead — push to server to sync
      saveCargo();
    }
  } catch (e) { /* use localStorage fallback */ }
  backfillEnteredMarket();
  renderCargo();
}

// Backfill entered_market for old history records that don't have it
function backfillEnteredMarket() {
  let changed = false;
  cargoHistory.forEach(c => {
    if (!c.entered_market) {
      const parsed = parseUpdatedDate(c.updated);
      c.entered_market = parsed || c.first_seen || null;
      if (c.entered_market) changed = true;
    }
  });
  if (changed) saveCargo();
}

// ─── Slot Colors ─────────────────────────────────────────────────────────────

const SLOT_COLORS = {
  'Mar FH': '#533AB7', 'Mar LH': '#AFA9EC',
  'Apr FH': '#185FA5', 'Apr LH': '#85B7EB',
  'May FH': '#0F6E56', 'May LH': '#5DCAA5',
  'Jun FH': '#854F0B', 'Jun LH': '#EF9F27',
  'Jul FH': '#993C1D', 'Jul LH': '#F0997B',
  'Aug FH': '#533AB7', 'Aug LH': '#AFA9EC',
  'Sep FH': '#185FA5', 'Sep LH': '#85B7EB',
  'Oct FH': '#0F6E56', 'Oct LH': '#5DCAA5',
};
function slotColor(k) { return SLOT_COLORS[k] || '#888780'; }

// ─── Known Stems ─────────────────────────────────────────────────────────────

const STEM_MAP = {
  'cont/baltic ta': 'Cont/Baltic TA', 'cont/baltic fronthaul': 'Cont/Baltic Fronthaul',
  'ec can ta': 'EC CAN TA', 'ec can fronthaul': 'EC CAN Fronthaul',
  'usec ta': 'USEC TA', 'usec fhaul': 'USEC Fronthaul', 'usec fronthaul': 'USEC Fronthaul',
  'usg ta': 'USG TA', 'usg fronthaul': 'USG Fronthaul',
  'ncsa ta': 'NCSA TA', 'ncsa fronthaul': 'NCSA Fronthaul',
  'ecsa ta': 'ECSA TA', 'ecsa fronthaul': 'ECSA Fronthaul',
  'wafr ta': 'WAFR TA', 'wafr fronthaul': 'WAFR Fronthaul',
  'bsea/wmed/emed ta': 'Bsea/Med TA', 'bsea/wmed/emed fronthaul': 'Bsea/Med Fronthaul',
  'bsea/med ta': 'Bsea/Med TA', 'bsea/med fronthaul': 'Bsea/Med Fronthaul',
};

const STEM_ORDER = ['ECSA Fronthaul','ECSA TA','NCSA Fronthaul','NCSA TA','USG Fronthaul','USG TA','USEC Fronthaul','USEC TA','EC CAN TA','EC CAN Fronthaul','Cont/Baltic TA','Cont/Baltic Fronthaul','WAFR Fronthaul','WAFR TA','Bsea/Med Fronthaul','Bsea/Med TA'];

// ─── Segments ────────────────────────────────────────────────────────────────
// Stems roll up into trade segments so the book reads on aggregate: every
// NATL loading area bound for the Far East is ONE fronthaul market (USG and
// NCSA to China compete for the same ships), every NATL → Atlantic stem is
// ONE TA market. ECSA is its own basin — Santos/China is THE fronthaul, and
// ECSA TA runs against the flow, so it's the backhaul. Edit SEGMENT_OF to
// move a stem; anything unmapped falls back on its Fronthaul/TA suffix.
const SEGMENT_ORDER = ['ECSA Fronthaul', 'NATL Fronthaul', 'NATL TA', 'ECSA Backhaul'];
const SEGMENT_OF = {
  'ECSA Fronthaul': 'ECSA Fronthaul',
  'ECSA TA': 'ECSA Backhaul',
  'NCSA Fronthaul': 'NATL Fronthaul', 'USG Fronthaul': 'NATL Fronthaul', 'USEC Fronthaul': 'NATL Fronthaul',
  'EC CAN Fronthaul': 'NATL Fronthaul', 'Cont/Baltic Fronthaul': 'NATL Fronthaul',
  'WAFR Fronthaul': 'NATL Fronthaul', 'Bsea/Med Fronthaul': 'NATL Fronthaul',
  'NCSA TA': 'NATL TA', 'USG TA': 'NATL TA', 'USEC TA': 'NATL TA', 'EC CAN TA': 'NATL TA',
  'Cont/Baltic TA': 'NATL TA', 'WAFR TA': 'NATL TA', 'Bsea/Med TA': 'NATL TA',
};
function segmentOfStem(stem) {
  if (SEGMENT_OF[stem]) return SEGMENT_OF[stem];
  const s = String(stem || '');
  if (/f(ront)?haul/i.test(s)) return /ecsa/i.test(s) ? 'ECSA Fronthaul' : 'NATL Fronthaul';
  if (/\bta\b/i.test(s)) return /ecsa/i.test(s) ? 'ECSA Backhaul' : 'NATL TA';
  return 'Other';
}

// Two-level scope shared by the Current and Trends views: a segment pill
// narrows the book to that market, a stem pill narrows further. Picking a
// segment clears the stem so the aggregate is what you see first.
let activeCargoSegment = 'ALL';
function cargoInScope(c) {
  if (activeCargoSegment !== 'ALL' && segmentOfStem(c.stem) !== activeCargoSegment) return false;
  if (activeCargoStem !== 'ALL' && c.stem !== activeCargoStem) return false;
  return true;
}
function cargoScopeLabel() {
  if (activeCargoStem !== 'ALL') return activeCargoStem;
  if (activeCargoSegment !== 'ALL') return activeCargoSegment;
  return 'all stems';
}
// The board is the ECSA book, so ship-supply series only make sense for an
// ECSA scope (or the whole book).
function cargoScopeIsEcsa() {
  if (activeCargoStem !== 'ALL') return /ecsa/i.test(activeCargoStem);
  if (activeCargoSegment !== 'ALL') return /ecsa/i.test(activeCargoSegment);
  return true;
}
function setCargoSegment(seg) {
  activeCargoSegment = seg;
  activeCargoStem = 'ALL';
  renderCargo();
}
// Segment + stem pill rows for one view. `cargoes` = the population the
// counts describe (live book on Current, full history on Trends).
function renderScopePills(segEl, stemEl, cargoes) {
  const segCounts = {}, stemCounts = {};
  cargoes.forEach(c => {
    const seg = segmentOfStem(c.stem);
    segCounts[seg] = (segCounts[seg] || 0) + 1;
    stemCounts[c.stem] = (stemCounts[c.stem] || 0) + 1;
  });
  const segs = SEGMENT_ORDER.filter(s => segCounts[s]).concat(segCounts.Other ? ['Other'] : []);
  if (segEl) segEl.innerHTML =
    `<span class="toolbar-label">Segment</span>` +
    `<button class="filter-pill ${activeCargoSegment === 'ALL' ? 'active' : ''}" onclick="setCargoSegment('ALL')">All (${cargoes.length})</button>` +
    segs.map(s =>
      `<button class="filter-pill ${activeCargoSegment === s ? 'active' : ''}" onclick="setCargoSegment('${s}')" title="${STEM_ORDER.filter(st => segmentOfStem(st) === s).join(' · ')}">${s} (${segCounts[s]})</button>`
    ).join('');
  // Stem pills: only the stems inside the chosen segment
  const inSeg = activeCargoSegment === 'ALL' ? cargoes.length : (segCounts[activeCargoSegment] || 0);
  const stems = STEM_ORDER.filter(s => stemCounts[s] && (activeCargoSegment === 'ALL' || segmentOfStem(s) === activeCargoSegment));
  if (stemEl) stemEl.innerHTML =
    `<span class="toolbar-label">Stem</span>` +
    `<button class="filter-pill ${activeCargoStem === 'ALL' ? 'active' : ''}" onclick="setCargoStem('ALL')">All (${inSeg})</button>` +
    stems.map(s =>
      `<button class="filter-pill ${activeCargoStem === s ? 'active' : ''}" onclick="setCargoStem('${s}')">${s} (${stemCounts[s]})</button>`
    ).join('');
}

// ─── Laycan Parsing ──────────────────────────────────────────────────────────

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_FULL = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseLaycanSlot(laycan) {
  if (!laycan) return null;
  const lc = laycan.toLowerCase().replace(/\s+/g, '');
  // Find the first day-month pair anywhere in the string. Handles inputs like
  // "1jul onw", "15-30jul", and also "june dates or 1-10jul" (where the leading
  // word is a bare month with no day, so we scan past it).
  const pairMatch = lc.match(/(\d{1,2})[^a-z]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (pairMatch) {
    const day = parseInt(pairMatch[1], 10);
    const monthIdx = MONTH_NAMES.indexOf(pairMatch[2]) + 1;
    return `${MONTH_FULL[monthIdx]} ${day <= 15 ? 'FH' : 'LH'}`;
  }
  // Fall back to a bare month (no day given): assume FH of that month.
  const monthOnly = lc.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (monthOnly) {
    const monthIdx = MONTH_NAMES.indexOf(monthOnly[1]) + 1;
    return `${MONTH_FULL[monthIdx]} FH`;
  }
  return null;
}

function slotSortKey(slot) {
  if (!slot) return 999;
  const parts = slot.split(' ');
  const month = MONTH_FULL.indexOf(parts[0]);
  return month * 2 + (parts[1] === 'LH' ? 1 : 0);
}

// ─── Cargo Parser ────────────────────────────────────────────────────────────

// The Google Sheet uses these columns (0-indexed, from the actual sheet):
// 0: charterer  1: size  2: age  3: delivery (load)  4: redelivery (disch)
// 5: cargo  6: laycan  7: com  8: updated  9: comment  10: FRESH  11: FIXED  12: user
const EXPECTED_COL_HEADERS = ['charterer','size','age','delivery','redelivery','load','disch','cargo','laycan','com','updated','comment','fresh','fixed','user'];

// Normalized key → canonical cargo field name
const HEADER_TO_FIELD = {
  'charterer': 'charterer',
  'size': 'size',
  'age': 'age',
  'delivery': 'load',      // "Delivery" in sheet = load area
  'redelivery': 'disch',   // "Redelivery" in sheet = discharge area
  'load': 'load',
  'disch': 'disch',
  'cargo': 'cargo',
  'laycan': 'laycan',
  'com': 'com',
  'updated': 'updated',
  'comment': 'comment',
  'fresh': 'fresh',
  'fixed': 'fixed',
  'user': 'user',
};

function isHeaderRow(cells) {
  const joined = cells.map(c => (c || '').toLowerCase().trim()).join(' ');
  // Robust detection: needs at least 2 of these column markers
  const markers = ['laycan', 'cargo', 'fresh', 'fixed', 'updated', 'delivery', 'redelivery', 'size'];
  const hits = markers.filter(m => joined.includes(m)).length;
  return hits >= 3;
}

function isSummaryRow(cells) {
  const joined = cells.map(c => (c || '').toLowerCase().trim()).join(' ');
  return /\btotal cargo count\b/.test(joined) || /\bfresh\/fixed cargoes\b/.test(joined) || /^in\s+\d/.test(joined.trim());
}

function parseCargoData(text) {
  const lines = text.split('\n');
  const cargoes = [];
  let currentStem = null;
  // Default field→position map matching the real sheet layout
  let fieldMap = {
    charterer: 0, size: 1, age: 2, load: 3, disch: 4, cargo: 5,
    laycan: 6, com: 7, updated: 8, comment: 9, fresh: 10, fixed: 11
  };

  for (const line of lines) {
    // Split on tab — preserve empty cells
    const cells = line.split('\t');
    const trimmed = cells.map(c => (c || '').trim());
    if (trimmed.length < 2 || trimmed.every(c => !c)) continue;

    // Skip summary rows
    if (isSummaryRow(trimmed)) continue;

    // Check if this is a stem header row (first non-empty cell is a known stem)
    const firstNonEmpty = trimmed.find(c => c) || '';
    const stemKey = firstNonEmpty.toLowerCase().replace(/\s+/g, ' ').trim();
    if (STEM_MAP[stemKey]) {
      currentStem = STEM_MAP[stemKey];
      continue;
    }

    // Check if this is the column header row
    if (isHeaderRow(trimmed)) {
      const newMap = {};
      trimmed.forEach((cell, i) => {
        const key = cell.toLowerCase().trim();
        const field = HEADER_TO_FIELD[key];
        if (field && newMap[field] === undefined) {
          newMap[field] = i;
        }
      });
      // Only use the detected map if we found at least laycan+cargo
      if (newMap.laycan !== undefined || newMap.cargo !== undefined) {
        fieldMap = { ...fieldMap, ...newMap };
      }
      continue;
    }

    // Skip if no stem context yet
    if (!currentStem) continue;

    const get = (field) => {
      const idx = fieldMap[field];
      return idx !== undefined ? (trimmed[idx] || '') : '';
    };

    const charterer = get('charterer').replace(/- NOT FOR LIST/gi, '').trim();
    if (!charterer || charterer.length < 2) continue;

    // Skip rows where "charterer" is actually a stem name or count
    if (STEM_MAP[charterer.toLowerCase().replace(/\s+/g, ' ').trim()]) continue;
    if (/^\d+$/.test(charterer) || /^total/i.test(charterer) || /^#$/.test(charterer)) continue;

    const size = get('size');
    const load = get('load');
    const disch = get('disch');
    const cargo = get('cargo');
    const laycan = get('laycan');
    const updated = get('updated');
    const freshRaw = get('fresh').toLowerCase();
    const fixedRaw = get('fixed').toLowerCase();
    const fresh = /^true$|^yes$|^y$|^1$/.test(freshRaw);
    const fixed = /^true$|^yes$|^y$|^1$/.test(fixedRaw);

    // Need a laycan or cargo or size to count as a valid row
    if (!laycan && !cargo && !size) continue;

    const slot = parseLaycanSlot(laycan);
    cargoes.push({
      charterer, size, load, disch, cargo, laycan, slot,
      updated, fresh, fixed, stem: currentStem
    });
  }

  return cargoes;
}

// ─── Date parsing for "updated" field ────────────────────────────────────────

// Parse compact date strings like "9Apr", "1Apr", "25 Mar", "2Apr onw" → ISO YYYY-MM-DD
function parseUpdatedDate(str) {
  if (!str) return null;
  const clean = str.toLowerCase().replace(/\s+/g, '').replace(/onw/g, '');
  const match = clean.match(/(\d{1,2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const monthIdx = MONTH_NAMES.indexOf(match[2]) + 1;
  if (!monthIdx || day < 1 || day > 31) return null;
  const year = new Date().getFullYear();
  const pad = n => n.toString().padStart(2, '0');
  return `${year}-${pad(monthIdx)}-${pad(day)}`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderCargo() {
  // Show/hide the right sub-view
  const currentView = document.getElementById('cargoCurrentView');
  const trendsView = document.getElementById('cargoTrendsView');
  if (currentView && trendsView) {
    currentView.style.display = activeCargoView === 'current' ? '' : 'none';
    trendsView.style.display = activeCargoView === 'trends' ? '' : 'none';
  }
  if (activeCargoView === 'trends') { renderTrends(); return; }

  const cargoData = getCargoData();
  const statusFilter = document.getElementById('cargoStatusFilter').value;
  const typeFilter = document.getElementById('cargoTypeFilter').value;

  let filtered = cargoData.filter(c => {
    if (!cargoInScope(c)) return false;
    if (statusFilter === 'fresh' && !c.fresh) return false;
    if (statusFilter === 'fixed' && !c.fixed) return false;
    if (typeFilter !== 'all' && (c.cargo || '').toLowerCase().indexOf(typeFilter) === -1) return false;
    return true;
  });

  // Stats
  const total = cargoData.length;
  const freshCount = cargoData.filter(c => c.fresh).length;
  const fixedCount = cargoData.filter(c => c.fixed).length;
  const fhCount = cargoData.filter(c => c.slot && c.slot.includes('FH')).length;

  document.getElementById('cargoStats').innerHTML = [
    { label: 'Total cargoes', value: total },
    { label: 'Fresh', value: freshCount },
    { label: 'Fixed', value: fixedCount },
    { label: 'FH laycans', value: fhCount },
  ].map(s => `<div class="stat"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div></div>`).join('');

  // Segment + stem filter buttons
  renderScopePills(document.getElementById('cargoSegmentFilters'), document.getElementById('cargoStemFilters'), cargoData);

  // Table
  filtered.sort((a, b) => slotSortKey(a.slot) - slotSortKey(b.slot));
  const tbody = document.getElementById('cargoBody');
  tbody.innerHTML = filtered.map(c => {
    const route = c.load && c.disch ? `${c.load} → ${c.disch}` : '';
    let statusBadge = '';
    if (c.fresh) statusBadge = '<span class="badge-fresh">FRESH</span>';
    if (c.fixed) statusBadge = '<span class="badge-fixed">FIXED</span>';
    const slotBadge = c.slot ? `<span class="td-laycan" style="background:${slotColor(c.slot)}20;color:${slotColor(c.slot)}">${c.slot}</span>` : '—';
    const idEscaped = c.id.replace(/'/g, "\\'");
    const notesEsc = (c.notes || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    const chartererEsc = (c.charterer || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    return `<tr>
      <td contenteditable="true" class="cargo-charterer-cell" onblur="saveCargoCharterer('${idEscaped}', this.innerText)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.blur();}" title="Click to edit · Enter to save">${chartererEsc}</td>
      <td style="color:var(--text-dim)" title="${segmentOfStem(c.stem)}">${c.stem}</td>
      <td>${c.cargo || ''}</td>
      <td style="color:var(--text-dim)">${route}</td>
      <td style="font-family:var(--mono);font-size:12px">${c.laycan || ''}</td>
      <td>${slotBadge}</td>
      <td style="font-family:var(--mono)">${c.size || ''}</td>
      <td style="color:var(--text-dim)">${c.updated || ''}</td>
      <td style="cursor:pointer" onclick="toggleCargoFixed('${idEscaped}')" title="Click to toggle fixed status">${statusBadge || '—'}</td>
      <td contenteditable="true" class="cargo-notes-cell" onblur="saveCargoNotes('${idEscaped}', this.innerText)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.blur();}" title="Click to edit · Enter to save">${notesEsc}</td>
      <td><button class="btn-remove" onclick="markCargoDeparted('${idEscaped}')" title="Mark as fixed & departed (removes from live list)">✓ Fixed</button></td>
    </tr>`;
  }).join('');
}

function saveCargoNotes(id, value) {
  const cargo = cargoHistory.find(c => c.id === id);
  if (!cargo) return;
  const newVal = (value || '').trim();
  if ((cargo.notes || '') === newVal) return;
  cargo.notes = newVal || null;
  saveCargo();
}

function saveCargoCharterer(id, value) {
  const cargo = cargoHistory.find(c => c.id === id);
  if (!cargo) return;
  const newVal = (value || '').trim();
  if ((cargo.charterer || '') === newVal) return;
  cargo.charterer = newVal || null;
  saveCargo();
}

// ─── Manual Add Cargo ────────────────────────────────────────────────────────

function openAddCargoModal() {
  const overlay = document.getElementById('addCargoOverlay');
  if (!overlay) return;
  // Populate stem dropdown
  const stemSel = document.getElementById('addCargoStem');
  if (stemSel && !stemSel.options.length) {
    stemSel.innerHTML = STEM_ORDER.map(s => `<option value="${s}"${s === 'ECSA Fronthaul' ? ' selected' : ''}>${s}</option>`).join('');
  }
  // Clear previous inputs
  ['addCargoCharterer','addCargoCargo','addCargoSize','addCargoLoad','addCargoDisch','addCargoLaycan','addCargoNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const err = document.getElementById('addCargoError');
  if (err) { err.textContent = ''; err.style.display = 'none'; }
  overlay.classList.add('open');
  setTimeout(() => { const ch = document.getElementById('addCargoCharterer'); if (ch) ch.focus(); }, 50);
}

function closeAddCargoModal() {
  const overlay = document.getElementById('addCargoOverlay');
  if (overlay) overlay.classList.remove('open');
}

function submitAddCargo() {
  const get = id => (document.getElementById(id)?.value || '').trim();
  const charterer = get('addCargoCharterer');
  if (!charterer) {
    const err = document.getElementById('addCargoError');
    if (err) { err.textContent = 'Charterer is required.'; err.style.display = ''; }
    return;
  }
  const stem = get('addCargoStem') || 'ECSA Fronthaul';
  const cargo = get('addCargoCargo');
  const size = get('addCargoSize');
  const load = get('addCargoLoad').toUpperCase();
  const disch = get('addCargoDisch').toUpperCase();
  const laycan = get('addCargoLaycan');
  const notes = get('addCargoNotes');

  const today = new Date().toISOString().split('T')[0];
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  const newCargo = {
    id,
    charterer,
    stem,
    cargo: cargo || null,
    size: size || null,
    load: load || null,
    disch: disch || null,
    laycan: laycan || null,
    slot: parseLaycanSlot(laycan),
    updated: today,
    notes: notes || null,
    fresh: true,
    fixed: false,
    first_seen: today,
    last_seen: today,
    entered_market: today,
    manual: true,
  };

  cargoHistory.push(newCargo);
  cargoCurrent.push(id);
  saveCargo();
  closeAddCargoModal();
  renderCargo();
}

function toggleCargoFixed(id) {
  const cargo = cargoHistory.find(c => c.id === id);
  if (!cargo) return;
  cargo.fixed = !cargo.fixed;
  if (cargo.fixed) cargo.fresh = false;
  saveCargo();
  renderCargo();
}

function markCargoDeparted(id) {
  const cargo = cargoHistory.find(c => c.id === id);
  if (!cargo) return;
  if (!confirm(`Mark ${cargo.charterer} ${cargo.cargo || ''} (${cargo.laycan || ''}) as fixed and remove from live list?`)) return;
  cargo.fixed = true;
  cargo.fresh = false;
  cargo.departed_at = new Date().toISOString().split('T')[0];
  // Remove from current (live) list
  const idx = cargoCurrent.indexOf(id);
  if (idx !== -1) cargoCurrent.splice(idx, 1);
  saveCargo();
  renderCargo();
}


function setCargoStem(stem) {
  activeCargoStem = stem;
  renderCargo();
}

function toggleCargoPaste() {
  const body = document.getElementById('cargoPasteBody');
  const arrow = document.getElementById('cargoPasteArrow');
  body.classList.toggle('open');
  arrow.classList.toggle('open');
}

// ─── Claude API cargo parser ─────────────────────────────────────────────────

const CARGO_SYSTEM_PROMPT = `You are a dry bulk cargo book parser. Extract cargo entries from spreadsheet paste data into structured JSON.

The input is tab-separated text from a Google Sheet. Structure:
1. Summary rows at top (like "IN 30 Total Cargo Count: 45 Fresh/Fixed cargoes: 2 0") — IGNORE these
2. A column header row like: "charterer Size Age Delivery Redelivery Cargo Laycan Com Updated Comment FRESH FIXED USER"
3. Stem header rows (e.g. "Cont/Baltic TA", "ECSA fronthaul") followed by a count number — these mark the section, not cargoes
4. Cargo rows under each stem section
5. Another stem header, more cargoes, etc.

KNOWN STEM NAMES (normalize to these exactly):
- ECSA Fronthaul, ECSA TA
- NCSA Fronthaul, NCSA TA
- USG Fronthaul, USG TA
- USEC Fronthaul, USEC TA
- EC CAN TA, EC CAN Fronthaul
- Cont/Baltic TA, Cont/Baltic Fronthaul
- WAFR Fronthaul, WAFR TA
- Bsea/Med Fronthaul, Bsea/Med TA (also accept Bsea/WMed/EMed variants)

COLUMN MEANING (the sheet uses these column names):
- charterer: name of charterer (position 0)
- Size: vessel size like "pmx", "kmx", "66000", "pmx/kmx"
- Age: vessel age requirement (optional, often empty)
- Delivery: load area like "ecsa", "ncsa", "usg", "santos" — this is the LOAD area
- Redelivery: discharge area like "china", "spore-jpn", "feast" — this is the DISCHARGE area
- Cargo: cargo type like "grain", "coal", "ore", "petcoke", "hss", "concentrates"
- Laycan: laycan string like "10apr onw", "15-30apr", "1-5may"
- Com: commission (ignore)
- Updated: date the cargo was last updated in the sheet (like "25Mar", "2Apr", "9Apr")
- Comment: notes (ignore for now)
- FRESH: boolean TRUE/FALSE
- FIXED: boolean TRUE/FALSE
- USER: username (ignore)

OUTPUT FIELDS (use exactly these names):
- charterer: strip "- NOT FOR LIST" suffix silently
- size, load (from Delivery), disch (from Redelivery), cargo, laycan, updated
- fresh (boolean), fixed (boolean)
- stem: which stem section this cargo was under

RULES:
- A row where the first non-empty cell is a known stem name is a SECTION HEADER, not a cargo. Track current stem.
- Summary rows ("Total Cargo Count", "IN 30", "Fresh/Fixed cargoes") are metadata — skip them entirely.
- Column header rows (the "charterer Size Age Delivery..." row) are the schema — skip them.
- Only extract rows with a real charterer name (not a stem name, not a number, not "#", not "total").
- If a cell is empty, use empty string "".
- Boolean fields: "TRUE" → true, anything else → false.

Return ONLY a JSON array of cargo objects. No markdown, no explanation. Start with [ and end with ].`;

async function parseCargoWithAI(text) {
  const resp = await fetch('/api/parse-cargo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Server parse failed (${resp.status}): ${err.error || resp.statusText}`);
  }

  const arr = await resp.json();

  // Add slot calculation + field defaults
  return arr.map(c => ({
    ...c,
    slot: parseLaycanSlot(c.laycan),
    fresh: !!c.fresh,
    fixed: !!c.fixed,
    charterer: c.charterer || '',
    size: c.size || '',
    load: c.load || '',
    disch: c.disch || '',
    cargo: c.cargo || '',
    laycan: c.laycan || '',
    updated: c.updated || '',
    stem: c.stem || 'Unknown',
  }));
}

async function parseCargoPaste() {
  const text = document.getElementById('cargoInput').value.trim();
  if (!text) return;

  const aiToggle = document.getElementById('cargoAIToggle');
  const useAI = aiToggle ? aiToggle.checked : true; // default on if toggle missing
  let parsed;

  if (useAI) {
    try {
      parsed = await parseCargoWithAI(text);
    } catch (e) {
      const summary = document.createElement('div');
      summary.style.cssText = 'padding:8px 12px;margin-top:6px;background:var(--red-light);color:var(--red);border-radius:6px;font-size:11px';
      summary.textContent = `AI parse failed: ${e.message}. Falling back to positional parser.`;
      const body = document.getElementById('cargoPasteBody');
      const existing = body.querySelector('.parse-summary');
      if (existing) existing.remove();
      summary.className = 'parse-summary';
      body.appendChild(summary);
      parsed = parseCargoData(text);
    }
  } else {
    parsed = parseCargoData(text);
  }

  if (parsed.length === 0) {
    alert('No cargoes parsed. Check the paste format or try AI mode.');
    return;
  }

  const { addedCount, updatedCount, autoFixedCount } = applyParsedCargoes(parsed);

  // Show summary
  const preview = document.createElement('div');
  preview.style.cssText = 'padding:8px 12px;margin-top:6px;background:var(--green-light);color:var(--green);border-radius:6px;font-size:11px';
  preview.textContent = `Parsed ${parsed.length} cargoes: ${addedCount} new, ${updatedCount} still live, ${autoFixedCount} auto-marked FIXED (dropped from update).`;
  const summaryBody = document.getElementById('cargoPasteBody');
  const existingSummary = summaryBody.querySelector('.parse-summary');
  if (existingSummary) existingSummary.remove();
  preview.className = 'parse-summary';
  summaryBody.appendChild(preview);

  // Auto-collapse after 3s
  setTimeout(() => {
    document.getElementById('cargoPasteBody').classList.remove('open');
    document.getElementById('cargoPasteArrow').classList.remove('open');
    if (preview.parentNode) preview.remove();
  }, 3000);
}

// Merge a parsed cargo list into the book — shared by manual paste and the
// Google Sheets feed. Same rules as ever: refresh live cargoes, add new ones,
// auto-mark dropped ones FIXED.
function applyParsedCargoes(parsed) {
  const today = new Date().toISOString().split('T')[0];

  // Build map of existing history for fast lookup
  const historyMap = new Map();
  cargoHistory.forEach(c => historyMap.set(c.id, c));

  // New current IDs seen in this paste
  const newCurrentIds = [];
  let addedCount = 0;
  let updatedCount = 0;

  for (const c of parsed) {
    const id = cargoId(c);
    c.id = id;
    // entered_market = parsed date from the "updated" field (when cargo
    // actually came to market), falling back to paste date
    const enteredMarket = parseUpdatedDate(c.updated) || today;
    newCurrentIds.push(id);

    if (historyMap.has(id)) {
      // Existing cargo — update last_seen and refresh live fields
      const existing = historyMap.get(id);
      existing.last_seen = today;
      existing.fresh = c.fresh;
      existing.fixed = c.fixed;
      // Keep any enrichments, update latest data
      existing.cargo = c.cargo || existing.cargo;
      existing.size = c.size || existing.size;
      existing.load = c.load || existing.load;
      existing.disch = c.disch || existing.disch;
      existing.laycan = c.laycan || existing.laycan;
      existing.slot = c.slot || existing.slot;
      existing.stem = c.stem || existing.stem;
      // Backfill entered_market if missing (from older records)
      if (!existing.entered_market) existing.entered_market = enteredMarket;
      updatedCount++;
    } else {
      // New cargo — add with first_seen and entered_market
      cargoHistory.push({
        ...c,
        first_seen: today,
        last_seen: today,
        entered_market: enteredMarket,
      });
      historyMap.set(id, cargoHistory[cargoHistory.length - 1]);
      addedCount++;
    }
  }

  // Cargoes that were live but are NOT in this paste — broker dropped them,
  // typically because the cargo was covered. Auto-mark as fixed and stamp
  // departed_at. User can untoggle via the cargo row if it was a mistake.
  const departedIds = cargoCurrent.filter(id => !newCurrentIds.includes(id));
  let autoFixedCount = 0;
  for (const id of departedIds) {
    const c = historyMap.get(id);
    if (!c) continue;
    if (!c.departed_at) c.departed_at = today;
    if (!c.fixed) { c.fixed = true; autoFixedCount++; }
    c.fresh = false;
  }

  cargoCurrent = newCurrentIds;
  saveCargo();
  renderCargo();

  return { addedCount, updatedCount, autoFixedCount };
}

function clearCargo() {
  if (!confirm('Clear all cargo history? This cannot be undone.')) return;
  cargoHistory = [];
  cargoCurrent = [];
  saveCargo();
  document.getElementById('cargoInput').value = '';
  document.getElementById('cargoBody').innerHTML = '';
  document.getElementById('cargoStats').innerHTML = '';
  document.getElementById('cargoStemFilters').innerHTML = '';
  if (trendChart) { trendChart.destroy(); trendChart = null; }
}

function setCargoView(view) {
  activeCargoView = view;
  document.querySelectorAll('.cargo-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  renderCargo();
}

function setTrendGranularity(g) {
  trendGranularity = g;
  document.querySelectorAll('.trend-gran-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.gran === g);
  });
  if (activeCargoView === 'trends') renderTrends();
}

// ─── Trends View ─────────────────────────────────────────────────────────────

function getBucket(dateStr, granularity) {
  // dateStr is ISO YYYY-MM-DD
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');

  if (granularity === 'daily') return `${y}-${m}-${day}`;
  if (granularity === 'monthly') return `${y}-${m}`;
  // weekly — ISO week start (Monday)
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  const my = monday.getFullYear();
  const mm = (monday.getMonth() + 1).toString().padStart(2, '0');
  const md = monday.getDate().toString().padStart(2, '0');
  return `${my}-${mm}-${md}`;
}

function fmtBucket(bucket, granularity) {
  if (!bucket) return '';
  if (granularity === 'monthly') {
    const [y, m] = bucket.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m, 10) - 1]} ${y.slice(2)}`;
  }
  if (granularity === 'weekly') {
    const [y, m, d] = bucket.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `Wk ${parseInt(d,10)} ${months[parseInt(m,10) - 1]}`;
  }
  // daily
  const [y, m, d] = bucket.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d,10)} ${months[parseInt(m,10) - 1]}`;
}

// Palette for trend lines (distinct colors that look decent on white)
const TREND_COLORS = ['#185FA5','#0F6E56','#854F0B','#993C1D','#533AB7','#B91C56','#0E7490','#A16207','#4F46E5','#0B7A5F','#D97706','#BE185D','#1D4ED8','#047857','#C2410C','#6D28D9'];

// Half-month laycan slot for a board ship's ETA ("Aug FH" / "Aug LH") —
// same buckets as the cargo book's slots, for the demand/supply balance
function etaSlot(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  return MONTH_FULL[d.getUTCMonth() + 1] + (d.getUTCDate() <= 15 ? ' FH' : ' LH');
}
function renderTrendStemPills() {
  renderScopePills(document.getElementById('trendSegmentFilters'), document.getElementById('trendStemFilters'), cargoHistory);
}

// Demand (live cargoes by laycan slot) vs supply (OPEN board ships by ETA
// slot). Ship series only means something for an ECSA scope — the board is
// the ECSA book — so it hides for e.g. a USG stem or the NATL TA segment.
let balanceChart = null;
function renderBalanceChart(hist) {
  const canvas = document.getElementById('balanceChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const live = hist.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
  const demand = {};
  live.forEach(c => { const s = c.slot || parseLaycanSlot(c.laycan); if (s) demand[s] = (demand[s] || 0) + 1; });

  const stemIsEcsa = cargoScopeIsEcsa();
  const supply = {};
  if (stemIsEcsa && typeof vessels !== 'undefined' && Array.isArray(vessels)) {
    vessels.forEach(v => {
      if (v.status !== 'OPEN' || !v.eta_ecsa) return;
      const s = etaSlot(v.eta_ecsa);
      if (s) supply[s] = (supply[s] || 0) + 1;
    });
  }

  const slots = [...new Set([...Object.keys(demand), ...Object.keys(supply)])]
    .sort((a, b) => slotSortKey(a) - slotSortKey(b)).slice(0, 8);
  const note = document.getElementById('balanceNote');
  if (!slots.length) {
    if (balanceChart) { balanceChart.destroy(); balanceChart = null; }
    if (note) note.textContent = 'No live laycans to compare.';
    return;
  }
  // Tightness read: slots where demand outstrips arriving ships
  const tight = slots.filter(s => (demand[s] || 0) > (supply[s] || 0));
  if (note) {
    note.textContent = stemIsEcsa
      ? (tight.length ? `Tight slots (more stems than arriving ships): ${tight.join(', ')}` : 'Supply covers demand in every slot shown.')
      : 'Ship series hidden — the board covers ECSA arrivals only.';
  }

  const datasets = [{
    label: 'Live cargoes', data: slots.map(s => demand[s] || 0),
    backgroundColor: '#185FA5', borderRadius: 3,
  }];
  if (stemIsEcsa) datasets.push({
    label: 'Open ships arriving (ETA slot)', data: slots.map(s => supply[s] || 0),
    backgroundColor: '#B6D98A', borderRadius: 3,
  });

  if (balanceChart) balanceChart.destroy();
  balanceChart = new Chart(canvas, {
    type: 'bar',
    data: { labels: slots, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      plugins: { legend: { position: 'top', labels: { boxWidth: 14 } } },
    },
  });
}

// ─── Demand Pulse ────────────────────────────────────────────────────────────
// "Are there more or fewer cargoes than typical?" Reconstructed daily from
// history: a cargo is live on day D if entered_market <= D <= departure.
// Baseline = trailing 28-day mean. Index 100 = normal.
function computeDemandPulse(hist, windowDays) {
  const W = windowDays || 84;
  const DAY = 86400000;
  const dayStr = t => new Date(t).toISOString().slice(0, 10);
  // UTC day grid — cargo dates are UTC calendar strings, and a local-midnight
  // grid drifts a day behind near midnight (Geneva mornings included)
  const todayStr = dayStr(Date.now());
  const todayUtc = new Date(todayStr + 'T00:00:00Z').getTime();

  // One span per PHYSICAL cargo. The history id includes the sheet's
  // "updated" stamp, so a re-touched cargo appears as several entries.
  // Two merge tiers:
  //  1. strict — identical charterer/stem/load/disch/laycan → same cargo
  //  2. chain  — same charterer/stem/load/disch and the old entry ends
  //     within ±1 day of the new one entering (a retouch that ALSO moved
  //     the laycan text). Parallel liftings (two stems live side by side
  //     for days) never chain — their overlap is much bigger than a day.
  const norm = x => String(x || '').toLowerCase().replace(/\s+/g, '');
  const entries = [];
  hist.forEach(c => {
    const start = c.entered_market || c.first_seen;
    if (!start) return;
    const live = typeof cargoCurrent !== 'undefined' && cargoCurrent.includes(c.id) && !c.fixed;
    const end = live ? todayStr : (c.departed_at || c.last_seen || start);
    const hasSubstance = c.load || c.laycan || c.disch || c.cargo;
    entries.push({
      start: String(start).slice(0, 10), end: String(end).slice(0, 10), live,
      strictKey: hasSubstance ? [c.charterer, c.stem, c.load, c.disch, c.laycan].map(norm).join('|') : 'id:' + c.id,
      looseKey: hasSubstance ? [c.charterer, c.stem, c.load, c.disch].map(norm).join('|') : 'id:' + c.id,
    });
  });

  // Tier 1: strict union
  const strict = {};
  for (const e of entries) {
    const p = strict[e.strictKey];
    if (!p) strict[e.strictKey] = { ...e };
    else {
      if (e.start < p.start) p.start = e.start;
      if (e.end > p.end) p.end = e.end;
      p.live = p.live || e.live;
    }
  }
  // Tier 2: chain hand-offs within the loose group
  const groups = {};
  for (const s of Object.values(strict)) (groups[s.looseKey] = groups[s.looseKey] || []).push(s);
  const spans = [];
  const T = d => new Date(d + 'T00:00:00Z').getTime();
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.start < b.start ? -1 : 1);
    let cur = null;
    for (const s of list) {
      if (cur && Math.abs(T(s.start) - T(cur.end)) <= DAY) {
        // hand-off: successor starts within a day of the predecessor ending
        if (s.end > cur.end) cur.end = s.end;
        cur.live = cur.live || s.live;
      } else {
        if (cur) spans.push(cur);
        cur = { ...s };
      }
    }
    if (cur) spans.push(cur);
  }

  const days = [];
  for (let i = W - 1; i >= 0; i--) {
    const d = dayStr(todayUtc - i * DAY);
    let live = 0, inflow = 0;
    for (const s of spans) {
      // Departure day is EXCLUSIVE for ended cargoes — a cargo that left the
      // book today is not live today (keeps 'today' equal to the Current tab).
      // Still-live spans count through today; same-day blips count their day.
      const counted = s.live
        ? (s.start <= d && d <= s.end)
        : (s.start === s.end ? d === s.start : (s.start <= d && d < s.end));
      if (counted) live++;
      if (s.start === d) inflow++;
    }
    days.push({ date: d, live, inflow });
  }
  // Trailing 28d mean per day (over available lookback)
  days.forEach((d, i) => {
    const from = Math.max(0, i - 27);
    const slice = days.slice(from, i + 1);
    d.avg28 = slice.reduce((s, x) => s + x.live, 0) / slice.length;
  });

  const t = days[days.length - 1];
  const yd = days[days.length - 2];
  const wk = days[days.length - 8];
  return {
    days,
    today: t ? t.live : 0,
    avg28: t ? t.avg28 : 0,
    index: t && t.avg28 > 0 ? Math.round(t.live / t.avg28 * 100) : null,
    dd: t && yd ? t.live - yd.live : null,
    ww: t && wk ? t.live - wk.live : null,
  };
}

// WhatsApp export: the pulse for the whole book, per segment, and per stem in
// one message — segments first so the market read comes before the detail
function buildPulseText() {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const sign = n => n == null ? '' : (n > 0 ? '+' : '') + n;
  const arrow = idx => idx == null ? '' : idx >= 115 ? ' ↑' : idx <= 85 ? ' ↓' : '';
  const line = p => `${p.today} live — index ${p.index != null ? p.index : '—'}${arrow(p.index)}` +
    ` (${sign(p.dd)} d/d, ${sign(p.ww)} w/w)`;

  const all = computeDemandPulse(cargoHistory, 84);
  let text = `*CARGO DEMAND PULSE — ${today}*\n_live cargoes vs trailing 4-week norm · index 100 = typical_\n\n`;
  text += `*All stems:* ${line(all)}\n\n_By segment:_\n`;

  const segs = SEGMENT_ORDER.filter(s => cargoHistory.some(c => segmentOfStem(c.stem) === s));
  for (const s of segs) {
    const p = computeDemandPulse(cargoHistory.filter(c => segmentOfStem(c.stem) === s), 84);
    if (p.today === 0 && !p.ww) continue;
    text += `· *${s}* ${line(p)}\n`;
  }
  text += `\n_By stem:_\n`;

  const stems = STEM_ORDER.filter(s => cargoHistory.some(c => c.stem === s));
  for (const s of stems) {
    const p = computeDemandPulse(cargoHistory.filter(c => c.stem === s), 84);
    if (p.today === 0 && !p.ww) continue;   // dead stems stay out of the message
    text += `· *${s}* ${line(p)}\n`;
  }
  return text.trim();
}

function copyPulse(btn) {
  const text = buildPulseText();
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = t; }, 1400); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
  else done();
}

let pulseChart = null;
function renderDemandPulse(hist) {
  const stats = document.getElementById('pulseStats');
  const canvas = document.getElementById('pulseChart');
  if (!stats || !canvas) return;
  const p = computeDemandPulse(hist);
  const sign = n => n == null ? '—' : (n > 0 ? '+' : '') + n;
  const idxColor = p.index == null ? 'var(--text-dim)' : p.index >= 115 ? 'var(--green)' : p.index <= 85 ? 'var(--red)' : 'var(--text-bright)';
  const scope = cargoScopeLabel();
  // Audit list: hover the live count to see exactly which cargoes it counts
  const liveNow = hist.filter(c => cargoCurrent.includes(c.id) && !c.fixed)
    .map(c => `${c.charterer || '?'} · ${c.load || '?'} · ${c.laycan || '?'}`);
  stats.innerHTML = [
    ['Live cargoes — ' + scope, p.today, '', 'Counted right now:\n' + (liveNow.join('\n') || 'none')],
    ['4-week norm', p.avg28 ? p.avg28.toFixed(1) : '—', ''],
    ['Demand index', p.index != null ? p.index : '—', `color:${idxColor}`, 'today ÷ trailing 28d avg × 100 — >100 = more cargoes than typical'],
    ['Day / day', sign(p.dd), p.dd > 0 ? 'color:var(--green)' : p.dd < 0 ? 'color:var(--red)' : ''],
    ['Week / week', sign(p.ww), p.ww > 0 ? 'color:var(--green)' : p.ww < 0 ? 'color:var(--red)' : ''],
  ].map(([l, v, style, tip]) => `<div class="stat" ${tip ? `title="${tip}"` : ''}><div class="stat-label">${l}</div><div class="stat-value" style="${style || ''}">${v}</div></div>`).join('');

  if (typeof Chart === 'undefined') return;
  if (pulseChart) pulseChart.destroy();
  pulseChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: p.days.map(d => d.date),
      datasets: [
        { label: 'Live cargoes (' + scope + ')', data: p.days.map(d => d.live),
          borderColor: '#185FA5', backgroundColor: '#185FA51a', fill: true,
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .25 },
        { label: '4-week average', data: p.days.map(d => Math.round(d.avg28 * 10) / 10),
          borderColor: '#888780', borderDash: [6, 4], borderWidth: 1.5,
          pointRadius: 0, pointHoverRadius: 3, tension: .25 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 10, callback(v) {
          const d = new Date(this.getLabelForValue(v) + 'T00:00:00Z');
          return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
        } } },
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
      },
      plugins: { legend: { position: 'top', labels: { boxWidth: 14 } } },
    },
  });
}

// ─── Demand depth by charterer ───────────────────────────────────────────────
// The cargo book shows QUOTED demand — houses run programs behind it. This
// measures the gap per charterer: ships they fixed vs cargoes they showed.
// A house fixing 5 against 2 shown moved 3 dark; their visible book should
// be read with that multiplier.
function normCharterer(name) {
  if (!name) return null;
  const t = String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const first = t.split(' ')[0];
  return first.length >= 3 ? first : t;   // COFCO INT ≡ COFCO; JERA GM ≡ JERA
}

function computeDemandDepth(days) {
  const cut = Date.now() - (days || 56) * 86400000;
  const inWin = d => {
    if (!d) return false;
    const t = new Date(String(d).slice(0, 10)).getTime();
    return !isNaN(t) && t >= cut;
  };
  const H = {};
  const get = (k, label) => {
    if (!H[k]) H[k] = { key: k, label: label || k, shown: 0, fixed: 0, bids: 0, requotes: 0 };
    return H[k];
  };

  cargoHistory.forEach(c => {
    const k = normCharterer(c.charterer);
    if (!k || !inWin(c.entered_market || c.first_seen)) return;
    get(k, c.charterer).shown++;
  });

  // Re-quotes: same charterer+stem+load re-entering within 10 days of a
  // departure — failed on subs or re-let. Distress marker.
  const groups = {};
  cargoHistory.forEach(c => {
    const k = normCharterer(c.charterer);
    if (!k) return;
    const g = k + '|' + (c.stem || '') + '|' + String(c.load || '').toLowerCase().trim();
    (groups[g] = groups[g] || []).push(c);
  });
  Object.values(groups).forEach(list => {
    if (list.length < 2) return;
    list.sort((a, b) => String(a.entered_market || a.first_seen || '').localeCompare(String(b.entered_market || b.first_seen || '')));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (!prev.departed_at || !cur.entered_market) continue;
      const gap = (new Date(cur.entered_market) - new Date(prev.departed_at)) / 86400000;
      if (gap >= 0 && gap <= 10 && inWin(cur.entered_market)) get(normCharterer(cur.charterer)).requotes++;
    }
  });

  // Fixtures from the board (incl archived fixtures from reopened ships)
  // and live bid appetite
  if (typeof vessels !== 'undefined' && Array.isArray(vessels)) {
    vessels.forEach(v => {
      if (v.status === 'FIXED' && inWin(v.date_fixed)) {
        const k = normCharterer(v.charterer);
        if (k) get(k, v.charterer).fixed++;
      }
      (v.fixture_history || []).forEach(f => {
        if (inWin(f.date_fixed)) {
          const k = normCharterer(f.charterer);
          if (k) get(k, f.charterer).fixed++;
        }
      });
      if (v.status === 'OPEN' && typeof getAllBids === 'function') {
        getAllBids(v).forEach(b => {
          const k = normCharterer(b.charterer);
          if (k) get(k, b.charterer).bids++;
        });
      }
    });
  }

  return Object.values(H)
    .map(e => ({ ...e, dark: Math.max(0, e.fixed - e.shown),
      mult: e.shown > 0 ? e.fixed / e.shown : null }))
    .filter(r => r.shown + r.fixed + r.bids > 0)
    .sort((a, b) => (b.fixed + b.shown + b.bids) - (a.fixed + a.shown + a.bids));
}

function renderDemandDepth() {
  const el = document.getElementById('demandDepth');
  if (!el) return;
  const rows = computeDemandDepth(56);
  if (!rows.length) {
    el.innerHTML = '<div style="padding:14px;color:var(--text-dim);font-size:12px">No charterer activity yet — fixtures need charterer names (use the 💬 hints on the board) for the depth read to work.</div>';
    return;
  }
  const badge = r => {
    if (r.mult != null && r.mult >= 1.5) return '<span class="depth-badge deep" title="Fixing well beyond the visible book — read their quotes as a fraction of the real program">DEEP</span>';
    if (r.shown === 0 && (r.fixed > 0 || r.bids > 0)) return '<span class="depth-badge dark" title="Active (fixing/bidding) without ever quoting — fully dark book">DARK</span>';
    if (r.requotes > 0) return '<span class="depth-badge requote" title="Cargoes failing/re-entering — possible distress">RE-Q</span>';
    return '';
  };
  el.innerHTML = `<table class="cargo-table" style="font-size:12px">
    <thead><tr><th>Charterer</th><th style="text-align:right" title="Cargoes quoted in the book, last 8 weeks">Shown</th>
    <th style="text-align:right" title="Ships fixed on the board (incl archived fixtures), last 8 weeks">Fixed</th>
    <th style="text-align:right" title="Fixed minus shown — cargoes that never hit the book">Dark</th>
    <th style="text-align:right" title="Fixed ÷ shown — multiply their visible book by this">×</th>
    <th style="text-align:right" title="Bids on open ships right now">Live bids</th>
    <th style="text-align:right" title="Cargoes re-entering within 10d of departing">Re-quotes</th><th></th></tr></thead>
    <tbody>${rows.slice(0, 15).map(r => `<tr>
      <td style="font-weight:600">${r.label || r.key}</td>
      <td style="text-align:right;font-family:var(--mono)">${r.shown}</td>
      <td style="text-align:right;font-family:var(--mono)">${r.fixed}</td>
      <td style="text-align:right;font-family:var(--mono);${r.dark ? 'color:var(--accent);font-weight:700' : ''}">${r.dark || ''}</td>
      <td style="text-align:right;font-family:var(--mono)">${r.mult != null ? r.mult.toFixed(1) : '—'}</td>
      <td style="text-align:right;font-family:var(--mono)">${r.bids || ''}</td>
      <td style="text-align:right;font-family:var(--mono);${r.requotes ? 'color:var(--amber)' : ''}">${r.requotes || ''}</td>
      <td>${badge(r)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function renderTrends() {
  renderTrendStemPills();
  // Trends respect the segment/stem pills — pick NATL TA and everything below
  // (stats, activity chart, balance) is that market only
  const hist = cargoHistory.filter(cargoInScope);
  if (cargoHistory.length === 0) {
    document.getElementById('trendStats').innerHTML = '<div style="padding:40px;color:var(--text-dim);font-size:13px">No cargo history yet. Paste cargo data to start building trends.</div>';
    document.getElementById('trendLegend').innerHTML = '';
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    return;
  }

  const trendType = document.getElementById('trendType').value;
  const topN = parseInt(document.getElementById('trendTopN').value || '10', 10);

  // Time in market stats
  const withBothDates = hist.filter(c => c.first_seen && c.last_seen);
  const departedCargoes = hist.filter(c => c.departed_at);
  const stillLive = hist.filter(c => cargoCurrent.includes(c.id));

  const avgTimeInMarket = (() => {
    const days = departedCargoes.map(c => {
      // Prefer entered_market (from cargo's "updated" field), fall back to first_seen
      const startStr = c.entered_market || c.first_seen;
      if (!startStr) return null;
      const start = new Date(startStr);
      const end = new Date(c.departed_at);
      return Math.round((end - start) / 86400000);
    }).filter(d => d !== null && d >= 0);
    if (days.length === 0) return '—';
    return (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) + ' d';
  })();

  const totalEverSeen = hist.length;
  const fixedCount = hist.filter(c => c.fixed).length;
  const fixRate = totalEverSeen > 0 ? ((fixedCount / totalEverSeen) * 100).toFixed(0) + '%' : '—';

  document.getElementById('trendStats').innerHTML = [
    { label: 'Total ever seen', value: totalEverSeen },
    { label: 'Currently live', value: stillLive.length },
    { label: 'Avg time in market', value: avgTimeInMarket },
    { label: 'Departed', value: departedCargoes.length },
    { label: 'Fix rate', value: fixRate },
  ].map(s => `<div class="stat"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div></div>`).join('');

  // Group cargoes by bucket and category (charterer/stem/cargo type)
  const bucketSet = new Set();
  const seriesMap = {}; // category -> bucket -> count
  const totalByCategory = {}; // for top-N sorting

  hist.forEach(c => {
    const bucket = getBucket(c.first_seen, trendGranularity);
    if (!bucket) return;
    bucketSet.add(bucket);

    let category;
    if (trendType === 'charterer') category = (c.charterer || 'Unknown').toLowerCase();
    else if (trendType === 'stem') category = c.stem || 'Unknown';
    else if (trendType === 'segment') category = segmentOfStem(c.stem);
    else if (trendType === 'cargo') category = (c.cargo || 'Unknown').toLowerCase();
    else category = 'All';

    if (!seriesMap[category]) seriesMap[category] = {};
    seriesMap[category][bucket] = (seriesMap[category][bucket] || 0) + 1;
    totalByCategory[category] = (totalByCategory[category] || 0) + 1;
  });

  // Sort buckets chronologically
  const buckets = [...bucketSet].sort();

  // Top-N categories by total count
  const topCategories = Object.keys(totalByCategory)
    .sort((a, b) => totalByCategory[b] - totalByCategory[a])
    .slice(0, topN);

  // Build datasets
  const datasets = topCategories.map((cat, i) => ({
    label: cat + ` (${totalByCategory[cat]})`,
    data: buckets.map(b => seriesMap[cat][b] || 0),
    borderColor: TREND_COLORS[i % TREND_COLORS.length],
    backgroundColor: TREND_COLORS[i % TREND_COLORS.length] + '22',
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 3,
    pointHoverRadius: 5,
    fill: false,
  }));

  // Legend
  document.getElementById('trendLegend').innerHTML = topCategories.map((cat, i) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${TREND_COLORS[i % TREND_COLORS.length]}"></span>${cat} <span style="opacity:.6">(${totalByCategory[cat]})</span></span>`
  ).join('');

  // Render chart
  const ctx = document.getElementById('trendChart');
  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: buckets.map(b => fmtBucket(b, trendGranularity)),
      datasets: datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => ctx.raw > 0 ? ` ${ctx.dataset.label.split(' (')[0]}: ${ctx.raw}` : null,
            filter: item => item.raw > 0,
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
      }
    }
  });

  // Stem velocity table (only show for 'stem' view)
  renderStemVelocity();

  // Demand pulse first — the headline read
  renderDemandPulse(hist);

  // Demand vs supply balance for the filtered stem(s)
  renderBalanceChart(hist);

  // Depth read is charterer-level, all stems (fixtures aren't stem-tagged)
  renderDemandDepth();
}

function renderStemVelocity() {
  const wrap = document.getElementById('stemVelocityWrap');
  if (!wrap) return;

  // For each stem, calculate: total ever seen, avg time in market, current live
  const stemStats = {};
  cargoHistory.forEach(c => {
    const stem = c.stem || 'Unknown';
    if (!stemStats[stem]) stemStats[stem] = { total: 0, times: [], live: 0 };
    stemStats[stem].total++;
    if (cargoCurrent.includes(c.id)) stemStats[stem].live++;
    const startStr = c.entered_market || c.first_seen;
    if (startStr && c.departed_at) {
      const days = Math.round((new Date(c.departed_at) - new Date(startStr)) / 86400000);
      if (days >= 0) stemStats[stem].times.push(days);
    }
  });

  const rows = Object.entries(stemStats)
    .map(([stem, s]) => ({
      stem,
      total: s.total,
      live: s.live,
      avgTime: s.times.length > 0 ? (s.times.reduce((a, b) => a + b, 0) / s.times.length).toFixed(1) : '—',
      velocity: s.times.length > 0 ? (s.total / (Math.max(...s.times, 1))).toFixed(2) : '—',
    }))
    .sort((a, b) => b.total - a.total);

  wrap.innerHTML = `
    <table class="cargo-table" style="margin-top:8px">
      <thead><tr>
        <th>Stem</th><th>Total Ever</th><th>Currently Live</th><th>Avg Days in Market</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td style="font-weight:500">${r.stem}</td>
          <td style="font-family:var(--mono)">${r.total}</td>
          <td style="font-family:var(--mono)">${r.live}</td>
          <td style="font-family:var(--mono)">${r.avgTime}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// Init cargo if data exists
if (cargoHistory.length > 0 && document.getElementById('tab-cargo') && document.getElementById('tab-cargo').classList.contains('active')) {
  renderCargo();
}
