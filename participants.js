// ─── Participants ────────────────────────────────────────────────────────────
// Owner and charterer activity view. Aggregates open positions, recent
// fixtures, median levels (vs market), and recent price-history trends.
//
// Same operator can appear in BOTH tables (e.g. Cargill as owner AND
// charterer) — that's accurate to how the market actually works.

const ANON_NAMES = new Set(['', 'NFD', 'CNR', 'TBN', 'UNKNOWN', '?', '-', '—']);

const _origSwitchTabParticipants = window.switchTab;
window.switchTab = function(tab) {
  _origSwitchTabParticipants(tab);
  if (tab === 'participants') {
    renderParticipants();
  }
};

let participantsExpanded = new Set(); // "owner:NAME" / "charterer:NAME"

function normalizeParty(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  const upper = trimmed.toUpperCase();
  if (ANON_NAMES.has(upper)) return null;
  return trimmed;
}

function isWithinDays(iso, days) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const ms = days * 86400000;
  return Date.now() - d.getTime() <= ms;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function marketMedians(days = 60) {
  // Market-wide median open offer/bid + recent fixed level
  const offers = [], bids = [], fixes = [];
  vessels.forEach(v => {
    const p6 = getP6Values(v);
    if (v.status === 'OPEN') {
      if (p6.offer != null) offers.push(p6.offer);
      if (p6.bid != null) bids.push(p6.bid);
    }
    if (v.status === 'FIXED' && v.fixed_price != null && isWithinDays(v.date_fixed, days)) {
      fixes.push(v.fixed_price);
    }
  });
  return { offer: median(offers), bid: median(bids), fixed: median(fixes) };
}

// Trend: compare each vessel's most-recent price entry to the one before it
// for this party, and report up/down/flat across their book.
function partyTrend(partyName, field) {
  if (!partyName) return null;
  const norm = String(partyName).toUpperCase();
  let up = 0, down = 0, flat = 0;
  vessels.forEach(v => {
    const hist = v.price_history || [];
    const ownEntries = hist.filter(h => {
      if (h.field !== field) return false;
      const cp = (h.counterparty || '').toUpperCase();
      return cp === norm;
    });
    if (ownEntries.length < 2) return;
    const last = ownEntries[ownEntries.length - 1].value;
    const prev = ownEntries[ownEntries.length - 2].value;
    if (last > prev) up++;
    else if (last < prev) down++;
    else flat++;
  });
  if (up === 0 && down === 0 && flat === 0) return null;
  if (up > down) return 'up';
  if (down > up) return 'down';
  return 'flat';
}

function aggregateOwners() {
  const map = new Map();
  for (const v of vessels) {
    const name = normalizeParty(v.owner);
    if (!name) continue;
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, { name, vessels: [] });
    map.get(key).vessels.push(v);
  }
  return [...map.values()].map(g => {
    const open = g.vessels.filter(v => v.status === 'OPEN');
    const fixed30 = g.vessels.filter(v => v.status === 'FIXED' && isWithinDays(v.date_fixed, 30));
    const openOffers = open.map(v => getP6Values(v).offer).filter(x => x != null);
    const fixedLevels = fixed30.map(v => v.fixed_price).filter(x => x != null);
    const lastActivity = g.vessels
      .map(v => v.last_updated || '')
      .sort()
      .pop() || null;
    return {
      name: g.name,
      openCount: open.length,
      fixedCount30: fixed30.length,
      offerMedian: median(openOffers),
      fixedMedian: median(fixedLevels),
      lastActivity,
      vessels: g.vessels,
      trend: partyTrend(g.name, 'p6_offer'),
    };
  }).sort((a, b) => (b.openCount + b.fixedCount30) - (a.openCount + a.fixedCount30));
}

function aggregateCharterers() {
  const map = new Map();
  // Active bid side: from bidding_charterer on OPEN vessels
  for (const v of vessels) {
    if (v.status !== 'OPEN') continue;
    const name = normalizeParty(v.bidding_charterer);
    if (!name) continue;
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, { name, bidding: [], fixed30: [], fixedAll: [] });
    map.get(key).bidding.push(v);
  }
  // Fixed side: from charterer on FIXED vessels
  for (const v of vessels) {
    if (v.status !== 'FIXED') continue;
    const name = normalizeParty(v.charterer);
    if (!name) continue;
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, { name, bidding: [], fixed30: [], fixedAll: [] });
    if (isWithinDays(v.date_fixed, 30)) map.get(key).fixed30.push(v);
    map.get(key).fixedAll.push(v);
  }
  return [...map.values()].map(g => {
    const openBidLevels = g.bidding.map(v => getP6Values(v).bid).filter(x => x != null);
    const fixedLevels = g.fixed30.map(v => v.fixed_price).filter(x => x != null);
    const lastBidActivity = g.bidding.map(v => v.last_updated || '').sort().pop() || null;
    const lastFixActivity = g.fixedAll.map(v => v.last_updated || '').sort().pop() || null;
    const lastActivity = [lastBidActivity, lastFixActivity].filter(Boolean).sort().pop() || null;
    return {
      name: g.name,
      bidCount: g.bidding.length,
      fixedCount30: g.fixed30.length,
      bidMedian: median(openBidLevels),
      fixedMedian: median(fixedLevels),
      lastActivity,
      bidding: g.bidding,
      fixed: g.fixedAll,
      trend: partyTrend(g.name, 'p6_bid'),
    };
  }).sort((a, b) => (b.bidCount + b.fixedCount30) - (a.bidCount + a.fixedCount30));
}

function fmtParty$(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString(); }
function fmtPartyTs(iso) {
  if (!iso) return '—';
  return fmtTimestamp(iso);
}

function vsMarketChip(value, marketVal) {
  if (value == null || marketVal == null) return '';
  const diff = value - marketVal;
  if (Math.abs(diff) < 100) return '<span class="party-vs flat">≈ mkt</span>';
  const cls = diff > 0 ? 'high' : 'low';
  const sign = diff > 0 ? '+' : '';
  return `<span class="party-vs ${cls}">${sign}$${Math.round(diff).toLocaleString()} vs mkt</span>`;
}

function trendArrow(t) {
  if (!t) return '<span class="party-trend none" title="No history yet">·</span>';
  if (t === 'up') return '<span class="party-trend up" title="Trending higher">▲</span>';
  if (t === 'down') return '<span class="party-trend down" title="Trending lower">▼</span>';
  return '<span class="party-trend flat" title="Flat">→</span>';
}

function renderParticipants() {
  const ownersBox = document.getElementById('participantsOwners');
  const chartersBox = document.getElementById('participantsCharterers');
  if (!ownersBox || !chartersBox) return;

  const mkt = marketMedians(60);
  const owners = aggregateOwners();
  const charterers = aggregateCharterers();

  // Header bar with market reference
  const marketRef = document.getElementById('participantsMarket');
  if (marketRef) {
    marketRef.innerHTML = `Market median: <strong>offer ${fmtParty$(mkt.offer)}</strong> · <strong>bid ${fmtParty$(mkt.bid)}</strong> · <strong>fixed (30d) ${fmtParty$(mkt.fixed)}</strong>`;
  }

  ownersBox.innerHTML = renderOwnerTable(owners, mkt);
  chartersBox.innerHTML = renderChartererTable(charterers, mkt);
}

function renderOwnerTable(rows, mkt) {
  if (rows.length === 0) {
    return '<div class="party-empty">No owners with identifiable names on the board.</div>';
  }
  let html = `<table class="party-table">
    <thead><tr>
      <th>Owner</th>
      <th class="num">Open</th>
      <th class="num">Median offer</th>
      <th>vs market</th>
      <th class="num">Fixed (30d)</th>
      <th class="num">Median fixed</th>
      <th>Trend</th>
      <th>Last activity</th>
      <th></th>
    </tr></thead><tbody>`;
  rows.forEach(r => {
    const key = 'owner:' + r.name.toUpperCase();
    const expanded = participantsExpanded.has(key);
    const safe = r.name.replace(/'/g, "\\'");
    html += `<tr class="party-row ${expanded ? 'expanded' : ''}" onclick="toggleParticipant('owner','${safe}')">
      <td class="party-name">${r.name}</td>
      <td class="num">${r.openCount || '—'}</td>
      <td class="num mono">${fmtParty$(r.offerMedian)}</td>
      <td>${vsMarketChip(r.offerMedian, mkt.offer)}</td>
      <td class="num">${r.fixedCount30 || '—'}</td>
      <td class="num mono">${fmtParty$(r.fixedMedian)}</td>
      <td>${trendArrow(r.trend)}</td>
      <td class="party-ts">${fmtPartyTs(r.lastActivity)}</td>
      <td class="party-caret">${expanded ? '▾' : '▸'}</td>
    </tr>`;
    if (expanded) {
      html += `<tr class="party-detail-row"><td colspan="9">${renderOwnerDrill(r)}</td></tr>`;
    }
  });
  html += '</tbody></table>';
  return html;
}

function renderChartererTable(rows, mkt) {
  if (rows.length === 0) {
    return '<div class="party-empty">No charterers with identifiable names yet — fill in Bidder column on open ships and Charterer on fixtures.</div>';
  }
  let html = `<table class="party-table">
    <thead><tr>
      <th>Charterer / Operator</th>
      <th class="num">Open bids</th>
      <th class="num">Median bid</th>
      <th>vs market</th>
      <th class="num">Fixed (30d)</th>
      <th class="num">Median fixed</th>
      <th>Trend</th>
      <th>Last activity</th>
      <th></th>
    </tr></thead><tbody>`;
  rows.forEach(r => {
    const key = 'charterer:' + r.name.toUpperCase();
    const expanded = participantsExpanded.has(key);
    const safe = r.name.replace(/'/g, "\\'");
    html += `<tr class="party-row ${expanded ? 'expanded' : ''}" onclick="toggleParticipant('charterer','${safe}')">
      <td class="party-name">${r.name}</td>
      <td class="num">${r.bidCount || '—'}</td>
      <td class="num mono">${fmtParty$(r.bidMedian)}</td>
      <td>${vsMarketChip(r.bidMedian, mkt.bid)}</td>
      <td class="num">${r.fixedCount30 || '—'}</td>
      <td class="num mono">${fmtParty$(r.fixedMedian)}</td>
      <td>${trendArrow(r.trend)}</td>
      <td class="party-ts">${fmtPartyTs(r.lastActivity)}</td>
      <td class="party-caret">${expanded ? '▾' : '▸'}</td>
    </tr>`;
    if (expanded) {
      html += `<tr class="party-detail-row"><td colspan="9">${renderChartererDrill(r)}</td></tr>`;
    }
  });
  html += '</tbody></table>';
  return html;
}

function renderOwnerDrill(r) {
  const open = r.vessels.filter(v => v.status === 'OPEN');
  const fixed = r.vessels.filter(v => v.status === 'FIXED' && isWithinDays(v.date_fixed, 60));
  return `
    <div class="party-drill">
      ${renderDrillList('Open ' + open.length, open, 'open')}
      ${renderDrillList('Fixed (last 60d) ' + fixed.length, fixed, 'fixed')}
    </div>
  `;
}

function renderChartererDrill(r) {
  return `
    <div class="party-drill">
      ${renderDrillList('Bidding on ' + r.bidding.length, r.bidding, 'bidding')}
      ${renderDrillList('Fixed (last 60d) ' + r.fixed.filter(v => isWithinDays(v.date_fixed, 60)).length, r.fixed.filter(v => isWithinDays(v.date_fixed, 60)), 'fixed')}
    </div>
  `;
}

function renderDrillList(title, list, mode) {
  if (list.length === 0) {
    return `<div class="party-drill-section"><div class="party-drill-title">${title}</div><div class="party-empty" style="padding:6px 0">—</div></div>`;
  }
  // Sort: fixtures by date desc; open/bidding by ETA asc
  const sorted = list.slice().sort((a, b) => {
    if (mode === 'fixed') return (b.date_fixed || '').localeCompare(a.date_fixed || '');
    return (a.eta_ecsa || '9999').localeCompare(b.eta_ecsa || '9999');
  });
  let html = `<div class="party-drill-section"><div class="party-drill-title">${title}</div>`;
  sorted.forEach(v => {
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
    const eta = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
    const p6 = getP6Values(v);
    let stat = '';
    if (mode === 'open' || mode === 'bidding') {
      const lvl = mode === 'bidding' ? p6.bid : p6.offer;
      stat = lvl != null ? `${mode === 'bidding' ? 'bid' : 'offer'} ${fmtParty$(lvl)}` : '—';
    } else if (mode === 'fixed') {
      const dateFixed = v.date_fixed ? fmtDateReport(v.date_fixed) : '';
      stat = `${fmtParty$(v.fixed_price)} · fixed ${dateFixed}`;
    }
    html += `<div class="party-drill-row">
      <span class="party-drill-vessel">${v.vessel_name || '?'} <span class="party-drill-specs">${specs}</span></span>
      ${eta ? `<span class="party-drill-eta">ETA ${eta}</span>` : ''}
      <span class="party-drill-stat">${stat}</span>
    </div>`;
  });
  html += '</div>';
  return html;
}

function toggleParticipant(type, name) {
  const key = type + ':' + name.toUpperCase();
  if (participantsExpanded.has(key)) participantsExpanded.delete(key);
  else participantsExpanded.add(key);
  renderParticipants();
}
