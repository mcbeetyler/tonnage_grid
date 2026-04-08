// ─── Cargo Book Dashboard ────────────────────────────────────────────────────

// Tab switching
function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`).classList.add('active');
  if (tab === 'cargo' && cargoData.length > 0) renderCargo();
}

// ─── Cargo State ─────────────────────────────────────────────────────────────

let cargoData = JSON.parse(localStorage.getItem('pt_cargo') || '[]');
let activeCargoStem = 'ALL';
let cargoChart = null;

function saveCargo() { localStorage.setItem('pt_cargo', JSON.stringify(cargoData)); }

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

// ─── Laycan Parsing ──────────────────────────────────────────────────────────

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_FULL = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseLaycanSlot(laycan) {
  if (!laycan) return null;
  const lc = laycan.toLowerCase().replace(/\s+/g, '');
  // Extract leading number
  const dayMatch = lc.match(/^(\d{1,2})/);
  if (!dayMatch) return null;
  const day = parseInt(dayMatch[1], 10);
  // Find month
  const monthMatch = lc.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (!monthMatch) return null;
  const monthIdx = MONTH_NAMES.indexOf(monthMatch[1]) + 1;
  const half = day <= 15 ? 'FH' : 'LH';
  return `${MONTH_FULL[monthIdx]} ${half}`;
}

function slotSortKey(slot) {
  if (!slot) return 999;
  const parts = slot.split(' ');
  const month = MONTH_FULL.indexOf(parts[0]);
  return month * 2 + (parts[1] === 'LH' ? 1 : 0);
}

// ─── Cargo Parser ────────────────────────────────────────────────────────────

function parseCargoData(text) {
  const lines = text.split('\n');
  const cargoes = [];
  let currentStem = null;

  for (const line of lines) {
    const cells = line.split('\t').map(c => c.trim());
    if (cells.length < 2 || cells.every(c => !c)) continue;

    // Check if this is a stem header row
    const firstCell = cells[0].toLowerCase().replace(/\s+/g, ' ').trim();
    if (STEM_MAP[firstCell]) {
      currentStem = STEM_MAP[firstCell];
      continue;
    }

    // Skip if no stem context yet
    if (!currentStem) continue;

    // Try to parse as cargo row — need at least a charterer and something else
    const charterer = cells[0].replace(/- NOT FOR LIST/gi, '').trim();
    if (!charterer || charterer.length < 2) continue;

    // Try to find laycan (look for date-like patterns in cells)
    let laycan = null, size = null, cargo = null, load = null, disch = null, updated = null;
    let fresh = false, fixed = false;

    for (let i = 1; i < cells.length; i++) {
      const c = cells[i].toLowerCase();
      if (!cells[i]) continue;
      // Laycan: contains month name + number
      if (!laycan && /\d/.test(c) && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(c)) {
        laycan = cells[i];
        continue;
      }
      // Size: contains pmx, kmx, or a number > 10000
      if (!size && (/pmx|kmx|smx/i.test(c) || /^\d{5,}/.test(c))) {
        size = cells[i];
        continue;
      }
      // Cargo type
      if (!cargo && /grain|coal|ore|ferts?|sugar|cement|clinker|petcoke|bauxite|soda ash|sulphur/i.test(c)) {
        cargo = cells[i];
        continue;
      }
      // Updated date
      if (!updated && /^\d{1,2}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(c.replace(/\s/g, ''))) {
        updated = cells[i];
        continue;
      }
      // Fresh/Fixed
      if (/^true$/i.test(c) || /^yes$/i.test(c)) {
        // Check column position relative to expected layout
        if (!fresh && i >= cells.length - 4) { fresh = true; continue; }
        if (fresh && !fixed) { fixed = true; continue; }
      }
      // Load/disch
      if (!load && cells[i].length > 1 && cells[i].length < 30) {
        load = cells[i]; continue;
      }
      if (load && !disch && cells[i].length > 1 && cells[i].length < 30) {
        disch = cells[i]; continue;
      }
    }

    // Also check explicit FRESH/FIXED columns
    for (let i = 0; i < cells.length; i++) {
      if (/^FRESH$/i.test(cells[i - 1] || '') || (cells[i] && /^TRUE$/i.test(cells[i]) && i >= cells.length - 3)) {
        // Heuristic: TRUE near the end = fresh, second TRUE = fixed
      }
    }

    if (laycan || cargo || size) {
      const slot = parseLaycanSlot(laycan);
      cargoes.push({
        charterer, size: size || '', load: load || '', disch: disch || '',
        cargo: cargo || '', laycan: laycan || '', slot,
        updated: updated || '', fresh, fixed, stem: currentStem
      });
    }
  }

  return cargoes;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderCargo() {
  const statusFilter = document.getElementById('cargoStatusFilter').value;
  const typeFilter = document.getElementById('cargoTypeFilter').value;

  let filtered = cargoData.filter(c => {
    if (activeCargoStem !== 'ALL' && c.stem !== activeCargoStem) return false;
    if (statusFilter === 'fresh' && !c.fresh) return false;
    if (statusFilter === 'fixed' && !c.fixed) return false;
    if (typeFilter !== 'all' && c.cargo.toLowerCase().indexOf(typeFilter) === -1) return false;
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

  // Stem filter buttons
  const stemCounts = {};
  cargoData.forEach(c => { stemCounts[c.stem] = (stemCounts[c.stem] || 0) + 1; });
  const stems = STEM_ORDER.filter(s => stemCounts[s]);

  document.getElementById('cargoStemFilters').innerHTML =
    `<button class="filter-pill ${activeCargoStem === 'ALL' ? 'active' : ''}" onclick="setCargoStem('ALL')">All (${total})</button>` +
    stems.map(s =>
      `<button class="filter-pill ${activeCargoStem === s ? 'active' : ''}" onclick="setCargoStem('${s}')">${s} (${stemCounts[s]})</button>`
    ).join('');

  // Legend
  const presentSlots = [...new Set(filtered.map(c => c.slot).filter(Boolean))].sort((a, b) => slotSortKey(a) - slotSortKey(b));
  document.getElementById('cargoLegend').innerHTML =
    presentSlots.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${slotColor(s)}"></span>${s}</span>`).join('') +
    `<span class="legend-item"><span class="legend-line"></span>Running total</span>`;

  // Chart
  renderCargoChart(filtered);

  // Table
  filtered.sort((a, b) => slotSortKey(a.slot) - slotSortKey(b.slot));
  const tbody = document.getElementById('cargoBody');
  tbody.innerHTML = filtered.map(c => {
    const route = c.load && c.disch ? `${c.load} → ${c.disch}` : '';
    let statusBadge = '';
    if (c.fresh) statusBadge = '<span class="badge-fresh">FRESH</span>';
    if (c.fixed) statusBadge = '<span class="badge-fixed">FIXED</span>';
    const slotBadge = c.slot ? `<span class="td-laycan" style="background:${slotColor(c.slot)}20;color:${slotColor(c.slot)}">${c.slot}</span>` : '—';
    return `<tr>
      <td style="font-weight:500">${c.charterer}</td>
      <td style="color:var(--text-dim)">${c.stem}</td>
      <td>${c.cargo}</td>
      <td style="color:var(--text-dim)">${route}</td>
      <td style="font-family:var(--mono);font-size:12px">${c.laycan}</td>
      <td>${slotBadge}</td>
      <td style="font-family:var(--mono)">${c.size}</td>
      <td style="color:var(--text-dim)">${c.updated}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');
}

function renderCargoChart(filtered) {
  // Group by updated date
  const dateMap = {};
  filtered.forEach(c => {
    const d = c.updated || 'Unknown';
    if (!dateMap[d]) dateMap[d] = [];
    dateMap[d].push(c);
  });

  const dates = Object.keys(dateMap).sort((a, b) => {
    const pa = a.replace(/\s/g, '').toLowerCase();
    const pb = b.replace(/\s/g, '').toLowerCase();
    return pa.localeCompare(pb);
  });

  const slots = [...new Set(filtered.map(c => c.slot).filter(Boolean))].sort((a, b) => slotSortKey(a) - slotSortKey(b));

  const barDatasets = slots.map(slot => ({
    label: slot,
    data: dates.map(d => dateMap[d].filter(c => c.slot === slot).length),
    backgroundColor: slotColor(slot),
    stack: 'a',
    order: 2,
  }));

  // Running total
  let cumulative = 0;
  const runningTotal = dates.map(d => {
    cumulative += dateMap[d].length;
    return cumulative;
  });

  const lineDataset = {
    label: 'Running total',
    data: runningTotal,
    type: 'line',
    borderColor: '#E24B4A',
    backgroundColor: '#E24B4A',
    pointRadius: 4,
    pointBackgroundColor: '#E24B4A',
    borderWidth: 2,
    fill: false,
    order: 1,
    tension: 0.1,
  };

  const ctx = document.getElementById('cargoChart');
  if (cargoChart) cargoChart.destroy();

  cargoChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: dates, datasets: [...barDatasets, lineDataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: ctx => 'Added: ' + ctx[0].label,
            label: ctx => ctx.raw > 0 ? ` ${ctx.dataset.label}: ${ctx.raw}` : null,
            filter: item => item.raw > 0,
          }
        }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { autoSkip: false } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } },
      }
    }
  });
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

function parseCargoPaste() {
  const text = document.getElementById('cargoInput').value.trim();
  if (!text) return;
  cargoData = parseCargoData(text);
  saveCargo();
  renderCargo();
  // Collapse the paste area after parsing
  document.getElementById('cargoPasteBody').classList.remove('open');
  document.getElementById('cargoPasteArrow').classList.remove('open');
}

function clearCargo() {
  cargoData = [];
  saveCargo();
  document.getElementById('cargoInput').value = '';
  document.getElementById('cargoBody').innerHTML = '';
  document.getElementById('cargoStats').innerHTML = '';
  document.getElementById('cargoStemFilters').innerHTML = '';
  document.getElementById('cargoLegend').innerHTML = '';
  if (cargoChart) { cargoChart.destroy(); cargoChart = null; }
}

// Init cargo if data exists
if (cargoData.length > 0 && document.getElementById('tab-cargo').classList.contains('active')) {
  renderCargo();
}
