// ─── App State ────────────────────────────────────────────────────────────────
let vessels = JSON.parse(localStorage.getItem('pt_vessels') || '[]');
let pendingParsed = null;
let activeFilter = 'ALL';
let currentSort = { key: 'eta_ecsa', dir: 'asc' }; // default: ETA ascending

function save() { localStorage.setItem('pt_vessels', JSON.stringify(vessels)); }

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  const months = ['','JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${parseInt(d,10)} ${months[parseInt(m,10)]}`;
}

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function getP6Values(v) {
  const mc = v.market_colour && v.market_colour[0];
  return {
    bid: mc ? mc.p6_bid : null,
    offer: mc ? mc.p6_offer : null
  };
}

function getSpread(v) {
  const p6 = getP6Values(v);
  if (p6.offer != null && p6.bid != null) return p6.offer - p6.bid;
  return null;
}

// ─── Inbox Handlers ──────────────────────────────────────────────────────────

function handleParse() {
  const raw = document.getElementById('rawInput').value.trim();
  if (!raw) return;
  const preview = document.getElementById('previewBox');
  const btnAdd = document.getElementById('btnAdd');
  try {
    const parsed = parseMultipleMessages(raw);
    pendingParsed = parsed;
    const summary = parsed.map(v =>
      `${v.vessel_name || '?'} (${v.dwt ? (v.dwt/1000).toFixed(0)+'K' : '?'}/${v.build_year || '?'}) ETA: ${fmtDate(v.eta_ecsa)} ${v.eta_type === 'ONW' ? 'ONW' : ''}`
    ).join('\n');
    preview.textContent = `Parsed ${parsed.length} vessel(s):\n\n${summary}\n\n${JSON.stringify(parsed, null, 2)}`;
    preview.className = 'preview-box has-content';
    btnAdd.disabled = false;
  } catch (e) {
    preview.textContent = 'Parse error: ' + e.message;
    preview.className = 'preview-box has-error';
    btnAdd.disabled = true;
  }
}

function handleAdd() {
  if (!pendingParsed) return;
  // Deduplicate by vessel name — update existing if same name
  for (const pv of pendingParsed) {
    const existIdx = vessels.findIndex(v =>
      v.vessel_name && pv.vessel_name &&
      v.vessel_name.toUpperCase() === pv.vessel_name.toUpperCase()
    );
    if (existIdx !== -1) {
      // Merge: keep existing owner/notes, update rates and ETA
      const existing = vessels[existIdx];
      vessels[existIdx] = { ...existing, ...pv, owner: pv.owner || existing.owner, notes: pv.notes || existing.notes, status: existing.status };
    } else {
      vessels.push(pv);
    }
  }
  save(); renderTable(); updateStats();
  document.getElementById('rawInput').value = '';
  document.getElementById('previewBox').textContent = `Added ${pendingParsed.length} vessel(s) to board.`;
  document.getElementById('previewBox').className = 'preview-box has-content';
  document.getElementById('btnAdd').disabled = true;
  pendingParsed = null;
}

function handleClear() {
  document.getElementById('rawInput').value = '';
  document.getElementById('previewBox').textContent = '— parsed output will appear here —';
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
    // Fallback: try localStorage
    document.getElementById('previewBox').textContent = 'Could not load sample_vessels.json. Serve via http or paste manually.';
    document.getElementById('previewBox').className = 'preview-box has-error';
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
  const states = ['OPEN', 'FIXED', 'FAILED', 'WITHDRAWN'];
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
  document.getElementById('statFixed').textContent = vessels.filter(v => v.status === 'FIXED').length;
  document.getElementById('statTotal').textContent = vessels.length;
}

function renderTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const etaFrom = document.getElementById('etaFrom').value;
  const etaTo = document.getElementById('etaTo').value;
  const tbody = document.getElementById('vesselBody');
  const empty = document.getElementById('emptyState');

  // Filter
  let filtered = vessels.filter((v) => {
    if (activeFilter !== 'ALL' && v.status !== activeFilter) return false;
    if (etaFrom && (!v.eta_ecsa || v.eta_ecsa < etaFrom)) return false;
    if (etaTo && (!v.eta_ecsa || v.eta_ecsa > etaTo)) return false;
    if (search) {
      const hay = `${v.vessel_name||''} ${v.owner||''} ${v.source||''} ${v.current_position||''} ${v.delivery_basis||''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Sort — primary: ETA asc, secondary: P6 offer desc (default behavior)
  // If user clicked a column, use that as primary sort
  filtered.sort((a, b) => {
    const va = getSortValue(a, currentSort.key);
    const vb = getSortValue(b, currentSort.key);
    let cmp = 0;
    if (typeof va === 'string') cmp = va.localeCompare(vb);
    else cmp = va - vb;
    if (currentSort.dir === 'desc') cmp = -cmp;

    // Secondary sort: if sorting by ETA/laycan, use P6 offer desc as tiebreaker
    if (cmp === 0 && (currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan')) {
      const p6a = getP6Values(a).offer || 0;
      const p6b = getP6Values(b).offer || 0;
      return p6b - p6a; // descending
    }
    return cmp;
  });

  empty.style.display = filtered.length === 0 ? 'block' : 'none';
  document.getElementById('vesselTable').style.display = filtered.length === 0 ? 'none' : '';

  // Group by laycan period
  let lastLaycan = null;
  const rows = [];

  for (const v of filtered) {
    const globalIdx = vessels.indexOf(v);
    const laycan = getLaycanPeriod(v.eta_ecsa);

    // Insert group header when laycan changes (only when sorted by ETA)
    if ((currentSort.key === 'eta_ecsa' || currentSort.key === 'laycan') && laycan !== lastLaycan) {
      rows.push(`<tr class="group-header"><td colspan="13">${laycan || 'NO ETA'}</td></tr>`);
      lastLaycan = laycan;
    }

    const p6 = getP6Values(v);
    const spread = getSpread(v);
    const mc = v.market_colour && v.market_colour[0];

    const etaCell = v.eta_ecsa
      ? `${fmtDate(v.eta_ecsa)}${v.eta_ecsa_end ? '–' + fmtDate(v.eta_ecsa_end).split(' ')[0] : ''}${v.eta_type === 'ONW' ? '<span class="onw-badge">ONW</span>' : ''}`
      : '—';

    const laycanBadge = laycan
      ? `<span class="td-laycan">${laycan}</span>`
      : '<span style="color:var(--text-dim)">—</span>';

    const scrTag = v.scrubber === true
      ? '<span class="scrubber-yes">SCR</span>'
      : '<span class="scrubber-unk">—</span>';

    let spreadCell = '—';
    if (spread != null) {
      const cls = spread > 0 ? 'spread-pos' : spread < 0 ? 'spread-neg' : 'spread-zero';
      spreadCell = `<span class="td-spread ${cls}">${spread > 0 ? '+' : ''}${fmtNum(spread)}</span>`;
    }

    const warnDot = v.parse_warnings && v.parse_warnings.length > 0
      ? `<span class="warn-dot" title="${v.parse_warnings.join('; ')}"></span>`
      : '';

    const delivery = v.delivery_basis || (v.current_position ? v.current_position : '—');

    rows.push(`<tr>
      <td>${laycanBadge}</td>
      <td class="td-vessel">${v.vessel_name || '—'}${warnDot}</td>
      <td class="td-owner">${v.owner || '—'}</td>
      <td class="td-source">${v.source || '—'}</td>
      <td class="td-specs">${v.dwt ? (v.dwt/1000).toFixed(0) + 'K' : '—'} / ${v.build_year || '—'}</td>
      <td>${scrTag}</td>
      <td class="td-port">${delivery}</td>
      <td class="td-eta">${etaCell}</td>
      <td class="td-p6"><span class="bid">${p6.bid ? fmtNum(p6.bid) : '—'}</span></td>
      <td class="td-p6"><span class="offer">${p6.offer ? fmtNum(p6.offer) : '—'}</span></td>
      <td>${spreadCell}</td>
      <td><span class="status-badge status-${v.status || 'OPEN'}" onclick="cycleStatus(${globalIdx})">${v.status || 'OPEN'}</span></td>
      <td><button class="btn-secondary" style="padding:3px 8px;font-size:10px" onclick="removeVessel(${globalIdx})">x</button></td>
    </tr>`);
  }

  tbody.innerHTML = rows.join('');
  updateStats();
}

// ─── Init ────────────────────────────────────────────────────────────────────
renderTable();
updateStats();
