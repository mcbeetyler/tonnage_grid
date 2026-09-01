// ─── Participants ────────────────────────────────────────────────────────────
// Activity-first view. Top: chronological feed of recent bids/offers/fixtures.
// Below: two card columns (Owners, Charterers) — compact, click to expand.
//
// Same operator can appear in BOTH lists (e.g. Cargill as owner AND charterer).

const ANON_NAMES = new Set(['', 'NFD', 'CNR', 'TBN', 'UNKNOWN', '?', '-', '—']);

const _origSwitchTabParticipants = window.switchTab;
window.switchTab = function(tab) {
  _origSwitchTabParticipants(tab);
  if (tab === 'participants') renderParticipants();
};

let participantsExpanded = new Set();
let activityShowAll = false;
let ownersShowAll = false;
let charterersShowAll = false;

// Cargo stem filter applied to Operators + Cargo Demand views.
// Empty set means "show all stems"; default focuses on ECSA FH.
let participantCargoFilter = (() => {
  try {
    const raw = localStorage.getItem('pt_participant_cargo_filter');
    if (raw) return new Set(JSON.parse(raw));
  } catch (e) {}
  return new Set(['ECSA Fronthaul']);
})();

function _persistParticipantCargoFilter() {
  try { localStorage.setItem('pt_participant_cargo_filter', JSON.stringify([...participantCargoFilter])); } catch (e) {}
}

function toggleParticipantCargoStem(stem) {
  if (participantCargoFilter.has(stem)) participantCargoFilter.delete(stem);
  else participantCargoFilter.add(stem);
  _persistParticipantCargoFilter();
  renderParticipants();
}

function setParticipantCargoStemAll() {
  participantCargoFilter.clear();
  _persistParticipantCargoFilter();
  renderParticipants();
}

function filterCargoMap(cargoMap, stems) {
  if (!stems || stems.size === 0) return cargoMap;
  const filtered = new Map();
  for (const [key, cargoes] of cargoMap) {
    const kept = cargoes.filter(c => stems.has(c.stem));
    if (kept.length) filtered.set(key, kept);
  }
  return filtered;
}

const ACTIVITY_DEFAULT = 10;
const PARTY_DEFAULT = 15;

function toggleActivityExpand() {
  activityShowAll = !activityShowAll;
  renderParticipants();
}
function toggleOwnersExpand() {
  ownersShowAll = !ownersShowAll;
  renderParticipants();
}
function toggleCharterersExpand() {
  charterersShowAll = !charterersShowAll;
  renderParticipants();
}

function normalizeParty(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (ANON_NAMES.has(trimmed.toUpperCase())) return null;
  return trimmed;
}

function isWithinDays(iso, days) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= days * 86400000;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function marketMedians(days = 60) {
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

function partyTrend(partyName, field) {
  if (!partyName) return null;
  const norm = String(partyName).toUpperCase();
  let up = 0, down = 0, flat = 0;
  vessels.forEach(v => {
    const hist = v.price_history || [];
    const own = hist.filter(h => h.field === field && (h.counterparty || '').toUpperCase() === norm);
    if (own.length < 2) return;
    const last = own[own.length - 1].value;
    const prev = own[own.length - 2].value;
    if (last > prev) up++; else if (last < prev) down++; else flat++;
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
    return {
      name: g.name,
      openCount: open.length,
      fixedCount30: fixed30.length,
      offerMedian: median(open.map(v => getP6Values(v).offer).filter(x => x != null)),
      fixedMedian: median(fixed30.map(v => v.fixed_price).filter(x => x != null)),
      lastActivity: g.vessels.map(v => v.last_updated || '').sort().pop() || null,
      vessels: g.vessels,
      trend: partyTrend(g.name, 'p6_offer'),
    };
  });
}

// Look in price_history for the first explicit follow-up event after a fixture
// (a 'relet' or 'failed' entry). Returns 'relet' / 'failed' / null.
// Fallback: if vessel is currently OPEN but no follow-up event logged, assume
// the vessel was relet (legacy data before the explicit actions existed).
function outcomeAfterFixture(v, fixtureT) {
  const hist = v.price_history || [];
  let earliestEvent = null;
  for (const h of hist) {
    if (h.field !== 'relet' && h.field !== 'failed') continue;
    if (!h.t || h.t <= (fixtureT || '')) continue;
    if (!earliestEvent || h.t < earliestEvent.t) earliestEvent = h;
  }
  if (earliestEvent) return earliestEvent.field;
  if (v.status === 'OPEN') return 'relet'; // legacy fallback
  return null;
}

// Collect every fixture event we know about, source-of-truth being price_history.
// A vessel can only be fixed once per "cycle" (cycles are bounded by relet
// events). So within each cycle we keep ONLY the most recent fixed_price /
// in_house entry — typo corrections to the same fixture don't double-count.
function collectFixtureEvents() {
  const events = [];
  for (const v of vessels) {
    const hist = (v.price_history || []).slice().sort((a, b) => (a.t || '').localeCompare(b.t || ''));

    // Segment history by relet events; within each segment a fixture appears
    // at most once (later entries overwrite earlier — i.e. typo corrections).
    const segments = [[]];
    for (const h of hist) {
      if (h.field === 'relet') segments.push([]);
      else segments[segments.length - 1].push(h);
    }
    for (const seg of segments) {
      const latest = {}; // field -> entry
      for (const h of seg) {
        if (h.field !== 'fixed_price' && h.field !== 'in_house') continue;
        const cur = latest[h.field];
        if (!cur || (h.t || '') > (cur.t || '')) latest[h.field] = h;
      }
      for (const field of Object.keys(latest)) {
        const h = latest[field];
        events.push({
          vessel: v,
          charterer: h.counterparty || (h.field === 'in_house' ? v.owner : null),
          price: h.value,
          date: h.t,
          dateOnly: h.t ? h.t.slice(0, 10) : null,
          type: h.field,
          fromHistory: true,
          outcome: outcomeAfterFixture(v, h.t),
        });
      }
    }

    // Fallback for vessels with no logged fixture history but a current
    // FIXED / IN HOUSE state. Price is optional — we still want to count
    // the fixture for the charterer/owner even if no rate was reported.
    const histHasFix = hist.some(h => h.field === 'fixed_price' || h.field === 'in_house');
    if (!histHasFix) {
      if (v.status === 'FIXED' && v.date_fixed) {
        events.push({
          vessel: v, charterer: v.charterer || null, price: v.fixed_price != null ? v.fixed_price : null,
          date: v.date_fixed + 'T12:00:00', dateOnly: v.date_fixed,
          type: 'fixed_price', fromHistory: false,
        });
      } else if (v.status === 'IN HOUSE' && v.date_fixed) {
        events.push({
          vessel: v, charterer: v.owner || null, price: v.fixed_price != null ? v.fixed_price : null,
          date: v.date_fixed + 'T12:00:00', dateOnly: v.date_fixed,
          type: 'in_house', fromHistory: false,
        });
      }
    }
  }
  return events;
}

function aggregateCharterers() {
  const map = new Map();

  // Open-bid side from currently OPEN vessels
  for (const v of vessels) {
    if (v.status !== 'OPEN') continue;
    const name = normalizeParty(v.bidding_charterer);
    if (!name) continue;
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, { name, bidding: [], fix30Events: [], fixAllEvents: [] });
    map.get(key).bidding.push(v);
  }

  // Fixture side from price_history (with current-state fallback)
  const events = collectFixtureEvents();
  for (const evt of events) {
    const name = normalizeParty(evt.charterer);
    if (!name) continue;
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, { name, bidding: [], fix30Events: [], fixAllEvents: [] });
    map.get(key).fixAllEvents.push(evt);
    if (isWithinDays(evt.dateOnly, 30)) map.get(key).fix30Events.push(evt);
  }

  // Fold in charterers who only appear in the cargo book — they're still
  // active participants even without vessel-side bid or fixture activity.
  if (typeof cargoHistory !== 'undefined' && typeof cargoCurrent !== 'undefined') {
    const liveIds = new Set(cargoCurrent);
    for (const c of cargoHistory) {
      if (!liveIds.has(c.id) || c.fixed) continue;
      const name = normalizeParty(c.charterer);
      if (!name) continue;
      const key = name.toUpperCase();
      if (!map.has(key)) map.set(key, { name, bidding: [], fix30Events: [], fixAllEvents: [] });
    }
  }

  return [...map.values()].map(g => {
    const uniqVessels = arr => [...new Set(arr.map(e => e.vessel))];
    const lastBid = g.bidding.map(v => v.last_updated || '').sort().pop() || null;
    const lastFix = g.fixAllEvents.map(e => e.date || '').sort().pop() || null;
    return {
      name: g.name,
      bidCount: g.bidding.length,
      fixedCount30: g.fix30Events.length,
      bidMedian: median(g.bidding.map(v => getP6Values(v).bid).filter(x => x != null)),
      fixedMedian: median(g.fix30Events.map(e => e.price).filter(x => x != null)),
      lastActivity: [lastBid, lastFix].filter(Boolean).sort().pop() || null,
      bidding: g.bidding,
      fixed: uniqVessels(g.fixAllEvents),
      fixedEvents: g.fixAllEvents,
      trend: partyTrend(g.name, 'p6_bid'),
    };
  });
}

// Sort participants: most recent activity first (gives a "what's hot" view).
function byRecent(a, b) { return (b.lastActivity || '').localeCompare(a.lastActivity || ''); }

// Aggregate live open cargoes from the Cargo Book by charterer name.
// Returns Map<upperName, cargo[]> for fast lookup when rendering cards.
function aggregateOpenCargoesByCharterer() {
  const map = new Map();
  if (typeof cargoHistory === 'undefined' || typeof cargoCurrent === 'undefined') return map;
  const liveIds = new Set(cargoCurrent);
  for (const c of cargoHistory) {
    if (!liveIds.has(c.id)) continue;   // only currently-live cargoes
    if (c.fixed) continue;              // already taken
    const name = normalizeParty(c.charterer);
    if (!name) continue;                // skip NFD / CNR / blanks
    const key = name.toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

// Build summary rows pairing each cargo-holder with the ships they're bidding on.
function buildCargoSummaryRows(cargoMap, charterers, operators) {
  const lookup = new Map();
  charterers.forEach(c => lookup.set(c.name.toUpperCase(), { name: c.name, bidding: c.bidding, isOperator: false }));
  operators.forEach(o => lookup.set(o.name.toUpperCase(), { name: o.name, bidding: o.charterer.bidding, isOperator: true }));
  const rows = [];
  for (const [key, cargoes] of cargoMap) {
    const info = lookup.get(key) || { name: cargoes[0].charterer || key, bidding: [], isOperator: false };
    rows.push({ name: info.name, cargoes, bidding: info.bidding, isOperator: info.isOperator });
  }
  rows.sort((a, b) => (b.cargoes.length - a.cargoes.length) || (b.bidding.length - a.bidding.length));
  return rows;
}

function renderCargoSummary(rows) {
  if (rows.length === 0) {
    return `<div class="party-empty" style="padding:14px">No charterers with active cargoes yet.</div>`;
  }
  return rows.map(r => {
    const cargoLines = r.cargoes.slice()
      .sort((a, b) => (a.laycan || '').localeCompare(b.laycan || ''))
      .map(c => {
        const size = c.size ? ' · ' + c.size : '';
        const route = c.load && c.disch ? ` (${c.load}→${c.disch})` : '';
        return `<div class="cs-cargo">${c.stem || '?'} · ${c.laycan || '?'}${size}${route}</div>`;
      }).join('');

    const bidLines = r.bidding.slice()
      .sort((a, b) => ((b.bid_updated_at || b.last_updated || '')).localeCompare((a.bid_updated_at || a.last_updated || '')))
      .map(v => {
        const p6 = getP6Values(v);
        const tsRaw = v.bid_updated_at || v.last_updated;
        const bidDate = tsRaw ? fmtDateReport(tsRaw.slice(0, 10)) : '';
        const eta = v.eta_ecsa ? 'ETA ' + fmtDateReport(v.eta_ecsa) : '';
        const lvl = p6.bid != null ? fmtParty$(p6.bid) : '';
        const parts = [v.vessel_name || '?'];
        if (lvl) parts.push(lvl);
        if (eta) parts.push(eta);
        if (bidDate) parts.push('bid ' + bidDate);
        return `<div class="cs-bid">→ ${parts.join(' · ')}</div>`;
      }).join('');

    return `<div class="party-cs-row">
      <div class="cs-head">
        <span class="cs-name">${r.name}${r.isOperator ? ' <span class="cs-op-tag">OP</span>' : ''}</span>
        <span class="cs-counts">${r.cargoes.length} cargo${r.cargoes.length === 1 ? '' : 'es'}${r.bidding.length ? ' · ' + r.bidding.length + ' bid' + (r.bidding.length === 1 ? '' : 's') : ''}</span>
      </div>
      ${cargoLines}
      ${bidLines || (r.bidding.length === 0 ? '<div class="cs-no-bids">no bids yet</div>' : '')}
    </div>`;
  }).join('');
}

function renderCargoesDrillSection(cargoes) {
  if (!cargoes || cargoes.length === 0) return '';
  const sorted = cargoes.slice().sort((a, b) => (a.laycan || '').localeCompare(b.laycan || ''));
  let html = `<div class="party-cargoes-divider"><span>Open Cargoes · ${sorted.length}</span></div><div class="party-drill-section">`;
  sorted.forEach(c => {
    const route = c.load && c.disch ? `${c.load} → ${c.disch}` : (c.stem || '');
    const laycan = c.laycan || '';
    const size = c.size || '';
    const stem = c.stem ? `<span class="party-drill-specs">${c.stem}</span>` : '';
    html += `<div class="party-drill-row">
      <span class="party-drill-vessel">${c.cargo || c.stem || 'cargo'} ${stem}</span>
      <span class="party-drill-eta">${route}</span>
      <span class="party-drill-stat">${laycan}${size ? ' · ' + size : ''}</span>
    </div>`;
  });
  return html + '</div>';
}

// Build merged "operator" entries for any account appearing in BOTH the
// owner and charterer aggregates. Returns { operators, ownerNames, chartererNames }
// — the name sets let renderParticipants filter operators out of the per-role lists.
function aggregateOperators(owners, charterers) {
  const ownerByKey = new Map(owners.map(o => [o.name.toUpperCase(), o]));
  const chartererByKey = new Map(charterers.map(c => [c.name.toUpperCase(), c]));
  const operators = [];
  const operatorKeys = new Set();
  for (const [key, ow] of ownerByKey) {
    const ch = chartererByKey.get(key);
    if (!ch) continue;
    operatorKeys.add(key);
    operators.push({
      name: ow.name,
      owner: ow,
      charterer: ch,
      lastActivity: [ow.lastActivity, ch.lastActivity].filter(Boolean).sort().pop() || null,
      trend: ow.trend === ch.trend ? ow.trend : null,
    });
  }
  return { operators, operatorKeys };
}

// ─── Recent activity feed ────────────────────────────────────────────────────

function buildActivityFeed(limit) {
  const events = [];
  for (const v of vessels) {
    const hist = (v.price_history || []).slice().sort((a, b) => (a.t || '').localeCompare(b.t || ''));

    // Pre-compute which fixture/in-house entries should be kept (one per cycle —
    // typo corrections get suppressed). Cycles are bounded by relet events.
    const fixtureKeep = new Set();
    let segLatestFix = null;
    let segLatestInHouse = null;
    const flush = () => {
      if (segLatestFix) fixtureKeep.add(segLatestFix);
      if (segLatestInHouse) fixtureKeep.add(segLatestInHouse);
      segLatestFix = null; segLatestInHouse = null;
    };
    for (const h of hist) {
      if (h.field === 'relet') { flush(); }
      else if (h.field === 'fixed_price') segLatestFix = h;
      else if (h.field === 'in_house') segLatestInHouse = h;
    }
    flush();

    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      // Skip superseded fixture entries (the typo corrections we want hidden)
      if ((h.field === 'fixed_price' || h.field === 'in_house') && !fixtureKeep.has(h)) continue;
      let type = 'edit';
      if (h.field === 'p6_bid') type = 'bid';
      else if (h.field === 'p6_offer') type = 'offer';
      else if (h.field === 'fixed_price') type = 'fixed';
      else if (h.field === 'in_house') type = 'in_house';
      else if (h.field === 'relet') type = 'relet';
      else if (h.field === 'failed') type = 'failed';
      // Find previous same-field entry to compute delta
      let prev = null;
      for (let j = i - 1; j >= 0; j--) {
        if (hist[j].field === h.field) { prev = hist[j]; break; }
      }
      const delta = (prev && h.value != null && prev.value != null) ? (h.value - prev.value) : null;
      events.push({
        t: h.t,
        type,
        vessel: v,
        actor: normalizeParty(h.counterparty),
        owner: normalizeParty(v.owner),
        value: h.value,
        delta,
        route: typeof getEffectiveRoute === 'function' ? getEffectiveRoute(v) : null,
      });
    }
    // Fallback: legacy vessels that were FIXED / IN HOUSE before logging existed.
    // Price is optional — unrated fixtures still file under the participant.
    if (hist.length === 0 || !hist.some(h => h.field === 'fixed_price' || h.field === 'in_house')) {
      if (v.status === 'FIXED' && v.date_fixed) {
        events.push({
          t: v.date_fixed + 'T12:00:00',
          type: 'fixed',
          vessel: v,
          actor: normalizeParty(v.charterer),
          owner: normalizeParty(v.owner),
          value: v.fixed_price != null ? v.fixed_price : null,
          delta: null,
          route: typeof getEffectiveRoute === 'function' ? getEffectiveRoute(v) : null,
        });
      } else if (v.status === 'IN HOUSE' && v.date_fixed) {
        events.push({
          t: v.date_fixed + 'T12:00:00',
          type: 'in_house',
          vessel: v,
          actor: normalizeParty(v.owner),
          owner: normalizeParty(v.owner),
          value: v.fixed_price != null ? v.fixed_price : null,
          delta: null,
          route: typeof getEffectiveRoute === 'function' ? getEffectiveRoute(v) : null,
        });
      }
    }
  }
  events.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
  return limit ? events.slice(0, limit) : events;
}

function renderActivityFeed() {
  const all = buildActivityFeed();
  if (all.length === 0) {
    return `<div class="party-empty">No recent activity logged yet. Activity appears here as you edit bids, offers, and fixtures.</div>`;
  }
  const shown = activityShowAll ? all : all.slice(0, ACTIVITY_DEFAULT);
  const rowsHtml = shown.map(e => {
    const v = e.vessel;
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
    const ts = fmtPartyTs(e.t);
    const actor = e.actor
      ? `<span class="party-activity-actor">${e.actor}</span>`
      : `<span class="party-activity-anon">—</span>`;
    let actionCls = 'party-activity-action';
    let actionText = '';
    if (e.type === 'bid')           { actionCls += ' bid';      actionText = `bid ${fmtParty$(e.value)}`; }
    else if (e.type === 'offer')    { actionCls += ' offer';    actionText = `offer ${fmtParty$(e.value)}`; }
    else if (e.type === 'fixed')    { actionCls += ' fixed';    actionText = `FIXED${e.value != null ? ' ' + fmtParty$(e.value) : ''}`; }
    else if (e.type === 'in_house') { actionCls += ' in-house'; actionText = `IN HOUSE${e.value != null ? ' ' + fmtParty$(e.value) : ''}`; }
    else if (e.type === 'relet')    { actionCls += ' relet';    actionText = `RELET to ${e.actor || '?'}`; }
    else if (e.type === 'failed')   { actionCls += ' failed';   actionText = `FAILED${e.value != null ? ' ' + fmtParty$(e.value) : ''}`; }
    // Delta indicator: red if up (more aggressive offer / higher bid), green if discount
    let deltaHtml = '';
    if (e.delta != null && e.delta !== 0) {
      // For bids/offers: a DECREASE in offer = discount (green); INCREASE in bid = aggressive buyer (red)
      // Keep it intuitive: the sign of the change with $ formatting, color by whether it's pricing tighter (red) or softer (green)
      const isBidUp = e.type === 'bid' && e.delta > 0;
      const isOfferDown = e.type === 'offer' && e.delta < 0;
      const isTighter = isBidUp || isOfferDown; // market moving up / counterparty getting more aggressive
      const cls = isTighter ? 'delta-up' : 'delta-down';
      const sign = e.delta > 0 ? '+' : '';
      deltaHtml = ` <span class="party-activity-delta ${cls}">${sign}$${Math.abs(e.delta).toLocaleString()}</span>`;
    }
    const ownerSuffix = e.owner ? ` <span class="party-activity-owner">· ${e.owner}</span>` : '';
    return `<div class="party-activity-row">
      <span class="party-activity-ts">${ts}</span>
      ${actor}
      <span class="${actionCls}">${actionText}${deltaHtml}</span>
      <span class="party-activity-vessel">${v.vessel_name || '?'} <span class="party-drill-specs">${specs}</span>${ownerSuffix}</span>
      <span class="party-activity-route">${e.route || ''}</span>
    </div>`;
  }).join('');
  const hidden = all.length - shown.length;
  let toggle = '';
  if (all.length > ACTIVITY_DEFAULT) {
    toggle = activityShowAll
      ? `<button class="party-show-toggle" onclick="toggleActivityExpand()">Show less</button>`
      : `<button class="party-show-toggle" onclick="toggleActivityExpand()">Show all ${all.length} events</button>`;
  }
  return rowsHtml + (toggle ? `<div class="party-show-row">${toggle}</div>` : '');
}

// ─── Cards ───────────────────────────────────────────────────────────────────

function fmtParty$(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString(); }
function fmtPartyTs(iso) { return !iso ? '—' : fmtTimestamp(iso); }

function vsMarketChip(value, marketVal) {
  if (value == null || marketVal == null) return '';
  const diff = value - marketVal;
  if (Math.abs(diff) < 100) return '<span class="party-vs flat">≈ mkt</span>';
  const cls = diff > 0 ? 'high' : 'low';
  const sign = diff > 0 ? '+' : '';
  return `<span class="party-vs ${cls}">${sign}$${Math.round(diff).toLocaleString()}</span>`;
}

function trendArrow(t) {
  if (!t) return '<span class="party-trend none" title="No history yet">·</span>';
  if (t === 'up')   return '<span class="party-trend up"   title="Trending higher">▲</span>';
  if (t === 'down') return '<span class="party-trend down" title="Trending lower">▼</span>';
  return '<span class="party-trend flat" title="Flat">→</span>';
}

function renderPartyCard(r, type, mkt, cargoMap) {
  const expanded = participantsExpanded.has(`${type}:${r.name.toUpperCase()}`);
  const safe = r.name.replace(/'/g, "\\'");
  const isOwner = type === 'owner';
  const openCount = isOwner ? r.openCount : r.bidCount;
  const openLabel = isOwner ? 'open' : 'bidding';
  const medianLevel = isOwner ? r.offerMedian : r.bidMedian;
  const marketLevel = isOwner ? mkt.offer : mkt.bid;
  const medianLabel = isOwner ? 'offer' : 'bid';
  const cargoes = (!isOwner && cargoMap) ? (cargoMap.get(r.name.toUpperCase()) || []) : [];

  const stats = [];
  stats.push(`<span class="party-chip"><strong>${openCount || 0}</strong> ${openLabel}</span>`);
  if (cargoes.length > 0) {
    stats.push(`<span class="party-chip"><strong>${cargoes.length}</strong> open cargo${cargoes.length === 1 ? '' : 'es'}</span>`);
  }
  if (r.fixedCount30) {
    stats.push(`<span class="party-chip"><strong>${r.fixedCount30}</strong> fix${r.fixedCount30 === 1 ? '' : 'es'}/30d</span>`);
  }
  if (medianLevel != null) {
    stats.push(`<span class="party-chip">${medianLabel} ${fmtParty$(medianLevel)} ${vsMarketChip(medianLevel, marketLevel)}</span>`);
  }
  if (r.fixedMedian != null) {
    stats.push(`<span class="party-chip">fixed @ ${fmtParty$(r.fixedMedian)}</span>`);
  }

  let drill = '';
  if (expanded) {
    const inner = isOwner
      ? renderOwnerDrill(r)
      : renderCargoesDrillSection(cargoes) + renderChartererDrill(r);
    drill = `<div class="party-card-drill">${inner}</div>`;
  }

  return `<div class="party-card ${type} ${expanded ? 'expanded' : ''}" onclick="toggleParticipant('${type}','${safe}')">
    <div class="party-card-head">
      <span class="party-role-tag ${type}">${type === 'owner' ? 'OWNER' : 'CHARTERER'}</span>
      <span class="party-card-name">${r.name}</span>
      ${trendArrow(r.trend)}
      <div style="flex:1"></div>
      <span class="party-card-ts">${fmtPartyTs(r.lastActivity)}</span>
      <span class="party-caret">${expanded ? '▾' : '▸'}</span>
    </div>
    <div class="party-card-stats">${stats.join('')}</div>
    ${drill}
  </div>`;
}

function renderOperatorCard(op, mkt, cargoMap) {
  const expanded = participantsExpanded.has(`operator:${op.name.toUpperCase()}`);
  const safe = op.name.replace(/'/g, "\\'");
  const ow = op.owner;
  const ch = op.charterer;
  const cargoes = cargoMap ? (cargoMap.get(op.name.toUpperCase()) || []) : [];

  const ownerChips = [];
  ownerChips.push(`<span class="party-chip"><strong>${ow.openCount || 0}</strong> open</span>`);
  if (ow.fixedCount30) ownerChips.push(`<span class="party-chip"><strong>${ow.fixedCount30}</strong> fix${ow.fixedCount30 === 1 ? '' : 'es'}/30d</span>`);
  if (ow.offerMedian != null) ownerChips.push(`<span class="party-chip">offer ${fmtParty$(ow.offerMedian)} ${vsMarketChip(ow.offerMedian, mkt.offer)}</span>`);
  if (ow.fixedMedian != null) ownerChips.push(`<span class="party-chip">fixed @ ${fmtParty$(ow.fixedMedian)}</span>`);

  const chartererChips = [];
  chartererChips.push(`<span class="party-chip"><strong>${ch.bidCount || 0}</strong> bidding</span>`);
  if (cargoes.length > 0) chartererChips.push(`<span class="party-chip"><strong>${cargoes.length}</strong> open cargo${cargoes.length === 1 ? '' : 'es'}</span>`);
  if (ch.fixedCount30) chartererChips.push(`<span class="party-chip"><strong>${ch.fixedCount30}</strong> fix${ch.fixedCount30 === 1 ? '' : 'es'}/30d</span>`);
  if (ch.bidMedian != null) chartererChips.push(`<span class="party-chip">bid ${fmtParty$(ch.bidMedian)} ${vsMarketChip(ch.bidMedian, mkt.bid)}</span>`);
  if (ch.fixedMedian != null) chartererChips.push(`<span class="party-chip">fixed @ ${fmtParty$(ch.fixedMedian)}</span>`);

  let drill = '';
  if (expanded) {
    drill = `<div class="party-card-drill">
      <div class="party-operator-divider owner-divider"><span>As Owner</span></div>
      <div class="party-operator-side owner-side">
        ${renderOwnerDrill(ow)}
      </div>
      <div class="party-operator-divider charterer-divider"><span>As Charterer</span></div>
      <div class="party-operator-side charterer-side">
        ${renderCargoesDrillSection(cargoes)}
        ${renderChartererDrill(ch)}
      </div>
    </div>`;
  }

  return `<div class="party-card operator ${expanded ? 'expanded' : ''}" onclick="toggleParticipant('operator','${safe}')">
    <div class="party-card-head">
      <span class="party-role-tag operator">OPERATOR</span>
      <span class="party-card-name">${op.name}</span>
      ${trendArrow(op.trend)}
      <div style="flex:1"></div>
      <span class="party-card-ts">${fmtPartyTs(op.lastActivity)}</span>
      <span class="party-caret">${expanded ? '▾' : '▸'}</span>
    </div>
    <div class="party-role-row"><span class="party-role-label owner">as owner</span>${ownerChips.join('')}</div>
    <div class="party-role-row"><span class="party-role-label charterer">as charterer</span>${chartererChips.join('')}</div>
    ${drill}
  </div>`;
}

// ─── Drill-downs ────────────────────────────────────────────────────────────

function renderOwnerDrill(r) {
  const open = r.vessels.filter(v => v.status === 'OPEN');
  const fixed = r.vessels.filter(v => v.status === 'FIXED' && isWithinDays(v.date_fixed, 60));
  return `<div class="party-drill">
    ${renderDrillList('Open ' + open.length, open, 'open')}
    ${renderDrillList('Fixed (last 60d) ' + fixed.length, fixed, 'fixed')}
  </div>`;
}

function renderChartererDrill(r) {
  const recentEvents = (r.fixedEvents || []).filter(e => isWithinDays(e.dateOnly, 60));
  return `<div class="party-drill">
    ${renderDrillList('Bidding on ' + r.bidding.length, r.bidding, 'bidding')}
    ${renderFixtureEventList('Fixed (last 60d) ' + recentEvents.length, recentEvents)}
  </div>`;
}

function renderFixtureEventList(title, events) {
  if (events.length === 0) {
    return `<div class="party-drill-section"><div class="party-drill-title">${title}</div><div class="party-empty" style="padding:6px 0">—</div></div>`;
  }
  const sorted = events.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let html = `<div class="party-drill-section"><div class="party-drill-title">${title}</div>`;
  sorted.forEach(e => {
    const v = e.vessel;
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
    const eta = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
    const dateFixed = e.dateOnly ? fmtDateReport(e.dateOnly) : '';
    const tag = e.type === 'in_house' ? ' (in house)' : '';
    let outcomeBadge = '';
    if (e.outcome === 'failed') {
      outcomeBadge = ' <span class="party-drill-failed" title="Subs lifted — fixture failed">✗ failed</span>';
    } else if (e.outcome === 'relet') {
      outcomeBadge = ' <span class="party-drill-stale" title="Vessel has been relet since this fixture">↺ relet</span>';
    }
    html += `<div class="party-drill-row">
      <span class="party-drill-vessel">${v.vessel_name || '?'} <span class="party-drill-specs">${specs}</span>${outcomeBadge}</span>
      ${eta ? `<span class="party-drill-eta">ETA ${eta}</span>` : ''}
      <span class="party-drill-stat">${fmtParty$(e.price)} · fixed ${dateFixed}${tag}</span>
    </div>`;
  });
  return html + '</div>';
}

function renderDrillList(title, list, mode) {
  if (list.length === 0) {
    return `<div class="party-drill-section"><div class="party-drill-title">${title}</div><div class="party-empty" style="padding:6px 0">—</div></div>`;
  }
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
    if (mode === 'bidding') {
      const lvl = p6.bid;
      const tsRaw = v.bid_updated_at || v.last_updated;
      const bidDate = tsRaw ? fmtDateReport(tsRaw.slice(0, 10)) : '';
      stat = lvl != null ? `bid ${fmtParty$(lvl)}${bidDate ? ' · ' + bidDate : ''}` : '—';
    } else if (mode === 'open') {
      const lvl = p6.offer;
      stat = lvl != null ? `offer ${fmtParty$(lvl)}` : '—';
    } else if (mode === 'fixed') {
      const dateFixed = v.date_fixed ? fmtDateReport(v.date_fixed) : '';
      const priceTxt = v.fixed_price != null ? fmtParty$(v.fixed_price) : 'FIXED';
      stat = `${priceTxt} · ${dateFixed}`;
    }
    html += `<div class="party-drill-row">
      <span class="party-drill-vessel">${v.vessel_name || '?'} <span class="party-drill-specs">${specs}</span></span>
      ${eta ? `<span class="party-drill-eta">ETA ${eta}</span>` : ''}
      <span class="party-drill-stat">${stat}</span>
    </div>`;
  });
  return html + '</div>';
}

function toggleParticipant(type, name) {
  // event bubbles from cards; prevent default so clicks on drill rows don't collapse
  if (window.event) window.event.stopPropagation();
  const key = type + ':' + name.toUpperCase();
  if (participantsExpanded.has(key)) participantsExpanded.delete(key);
  else participantsExpanded.add(key);
  renderParticipants();
}

// ─── Top-level render ───────────────────────────────────────────────────────

function renderParticipants() {
  const streamBoxEarly = document.getElementById('participantsStream');
  const activityBox = document.getElementById('participantsActivity');
  if (!streamBoxEarly) return;

  const mkt = marketMedians(60);
  const marketRef = document.getElementById('participantsMarket');
  if (marketRef) {
    marketRef.innerHTML = `Market median: <strong>offer ${fmtParty$(mkt.offer)}</strong> · <strong>bid ${fmtParty$(mkt.bid)}</strong> · <strong>fixed (30d) ${fmtParty$(mkt.fixed)}</strong>`;
  }

  if (activityBox) activityBox.innerHTML = renderActivityFeed();

  const owners = aggregateOwners();
  const charterers = aggregateCharterers();
  const cargoMapAll = aggregateOpenCargoesByCharterer();
  const cargoMap = filterCargoMap(cargoMapAll, participantCargoFilter);
  const { operators, operatorKeys } = aggregateOperators(owners, charterers);
  const cargoSummaryRows = buildCargoSummaryRows(cargoMap, charterers, operators);

  // Build the stem filter pill bar from stems present in the (unfiltered) data
  const filterBar = document.getElementById('participantsCargoFilter');
  if (filterBar) {
    const stems = new Set();
    for (const cargoes of cargoMapAll.values()) cargoes.forEach(c => { if (c.stem) stems.add(c.stem); });
    const stemOrder = (typeof STEM_ORDER !== 'undefined' ? STEM_ORDER : []).filter(s => stems.has(s));
    [...stems].sort().forEach(s => { if (!stemOrder.includes(s)) stemOrder.push(s); });
    if (stemOrder.length === 0) {
      filterBar.innerHTML = '';
    } else {
      const allOn = participantCargoFilter.size === 0;
      filterBar.innerHTML =
        `<span class="filter-label" style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;margin-right:4px">Cargo stems</span>` +
        `<button class="filter-pill ${allOn ? 'active' : ''}" onclick="setParticipantCargoStemAll()">All</button>` +
        stemOrder.map(s => `<button class="filter-pill ${participantCargoFilter.has(s) ? 'active' : ''}" onclick="toggleParticipantCargoStem('${s.replace(/'/g, "\\'")}')">${s}</button>`).join('');
    }
  }

  // Drop cargo-only charterers whose only signal was a now-filtered-out cargo.
  const visibleCharterers = charterers.filter(c => {
    const hasVesselActivity = c.bidCount > 0 || (c.fixedEvents && c.fixedEvents.length > 0);
    if (hasVesselActivity) return true;
    return (cargoMap.get(c.name.toUpperCase()) || []).length > 0;
  });

  // Filter operators out of the per-role lists so they aren't shown twice
  const filteredOwners = owners.filter(o => !operatorKeys.has(o.name.toUpperCase()));
  const filteredCharterers = visibleCharterers.filter(c => !operatorKeys.has(c.name.toUpperCase()));

  // Unified stream — operators + owners + charterers, sorted by most recent activity.
  const streamEntries = [];
  operators.forEach(o => streamEntries.push({ kind: 'operator', row: o, lastActivity: o.lastActivity }));
  filteredOwners.forEach(o => streamEntries.push({ kind: 'owner', row: o, lastActivity: o.lastActivity }));
  filteredCharterers.forEach(c => streamEntries.push({ kind: 'charterer', row: c, lastActivity: c.lastActivity }));
  streamEntries.sort(byRecent);

  const operatorsSection = document.getElementById('participantsOperatorsSection');
  const streamBox = document.getElementById('participantsStream');
  const cargoSummaryBox = document.getElementById('participantsCargoSummary');
  const showSection = streamEntries.length || cargoSummaryRows.length || cargoMapAll.size > 0;
  if (operatorsSection) operatorsSection.style.display = showSection ? '' : 'none';
  if (streamBox) {
    streamBox.innerHTML = streamEntries.length === 0
      ? `<div class="party-empty">No participants with identifiable names yet.</div>`
      : streamEntries.map(e => e.kind === 'operator'
          ? renderOperatorCard(e.row, mkt, cargoMap)
          : renderPartyCard(e.row, e.kind, mkt, cargoMap)
        ).join('');
  }
  if (cargoSummaryBox) cargoSummaryBox.innerHTML = renderCargoSummary(cargoSummaryRows);
}
