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

// Collect every fixture event we know about, source-of-truth being price_history
// (which preserves the original counterparty even if the vessel has since been
// relet / re-owned). For vessels with no history yet, fall back to current state.
function collectFixtureEvents() {
  const events = [];
  for (const v of vessels) {
    const histFix = (v.price_history || []).filter(h => h.field === 'fixed_price' || h.field === 'in_house');
    for (const h of histFix) {
      events.push({
        vessel: v,
        charterer: h.counterparty || (h.field === 'in_house' ? v.owner : null),
        price: h.value,
        date: h.t,            // ISO timestamp
        dateOnly: h.t ? h.t.slice(0, 10) : null,
        type: h.field,
        fromHistory: true,
      });
    }
    // Fallback for vessels without logged history but a current FIXED/IN HOUSE state
    if (v.status === 'FIXED' && v.fixed_price != null && v.date_fixed) {
      const already = histFix.some(h => h.field === 'fixed_price');
      if (!already) {
        events.push({
          vessel: v,
          charterer: v.charterer || null,
          price: v.fixed_price,
          date: v.date_fixed + 'T12:00:00',
          dateOnly: v.date_fixed,
          type: 'fixed_price',
          fromHistory: false,
        });
      }
    }
    if (v.status === 'IN HOUSE' && v.date_fixed) {
      const already = histFix.some(h => h.field === 'in_house');
      if (!already) {
        events.push({
          vessel: v,
          charterer: v.owner || null,
          price: v.fixed_price,
          date: v.date_fixed + 'T12:00:00',
          dateOnly: v.date_fixed,
          type: 'in_house',
          fromHistory: false,
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

// ─── Recent activity feed ────────────────────────────────────────────────────

function buildActivityFeed(limit) {
  const events = [];
  for (const v of vessels) {
    const hist = (v.price_history || []).slice();
    // Walk in order so we can compute delta from previous same-field entry
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      let type = 'edit';
      if (h.field === 'p6_bid') type = 'bid';
      else if (h.field === 'p6_offer') type = 'offer';
      else if (h.field === 'fixed_price') type = 'fixed';
      else if (h.field === 'in_house') type = 'in_house';
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
    // Fallback: legacy vessels that were FIXED / IN HOUSE before logging existed
    if (hist.length === 0 || !hist.some(h => h.field === 'fixed_price' || h.field === 'in_house')) {
      if (v.status === 'FIXED' && v.fixed_price != null && v.date_fixed) {
        events.push({
          t: v.date_fixed + 'T12:00:00',
          type: 'fixed',
          vessel: v,
          actor: normalizeParty(v.charterer),
          owner: normalizeParty(v.owner),
          value: v.fixed_price,
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
          value: v.fixed_price,
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
    else if (e.type === 'fixed')    { actionCls += ' fixed';    actionText = `FIXED ${fmtParty$(e.value)}`; }
    else if (e.type === 'in_house') { actionCls += ' in-house'; actionText = `IN HOUSE${e.value != null ? ' ' + fmtParty$(e.value) : ''}`; }
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

function renderPartyCard(r, type, mkt) {
  const expanded = participantsExpanded.has(`${type}:${r.name.toUpperCase()}`);
  const safe = r.name.replace(/'/g, "\\'");
  const isOwner = type === 'owner';
  const openCount = isOwner ? r.openCount : r.bidCount;
  const openLabel = isOwner ? 'open' : 'bidding';
  const medianLevel = isOwner ? r.offerMedian : r.bidMedian;
  const marketLevel = isOwner ? mkt.offer : mkt.bid;
  const medianLabel = isOwner ? 'offer' : 'bid';

  const stats = [];
  stats.push(`<span class="party-chip"><strong>${openCount || 0}</strong> ${openLabel}</span>`);
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
  if (expanded) drill = `<div class="party-card-drill">${isOwner ? renderOwnerDrill(r) : renderChartererDrill(r)}</div>`;

  return `<div class="party-card ${expanded ? 'expanded' : ''}" onclick="toggleParticipant('${type}','${safe}')">
    <div class="party-card-head">
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

function renderPartyCardList(rows, type, mkt) {
  if (rows.length === 0) {
    return `<div class="party-empty">No ${type === 'owner' ? 'owners' : 'charterers'} with identifiable names yet.</div>`;
  }
  const sorted = rows.slice().sort(byRecent);
  const showAll = type === 'owner' ? ownersShowAll : charterersShowAll;
  const shown = showAll ? sorted : sorted.slice(0, PARTY_DEFAULT);
  const cards = shown.map(r => renderPartyCard(r, type, mkt)).join('');
  let toggle = '';
  if (sorted.length > PARTY_DEFAULT) {
    const fn = type === 'owner' ? 'toggleOwnersExpand' : 'toggleCharterersExpand';
    toggle = showAll
      ? `<button class="party-show-toggle" onclick="${fn}()">Show top ${PARTY_DEFAULT}</button>`
      : `<button class="party-show-toggle" onclick="${fn}()">Show all ${sorted.length}</button>`;
  }
  return cards + (toggle ? `<div class="party-show-row">${toggle}</div>` : '');
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
    const isStale = v.status === 'OPEN'; // vessel has since been relet
    const staleTag = isStale ? ' <span class="party-drill-stale" title="Vessel has been relet since this fixture">↺ relet</span>' : '';
    html += `<div class="party-drill-row">
      <span class="party-drill-vessel">${v.vessel_name || '?'} <span class="party-drill-specs">${specs}</span>${staleTag}</span>
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
  const ownersBox = document.getElementById('participantsOwners');
  const chartersBox = document.getElementById('participantsCharterers');
  const activityBox = document.getElementById('participantsActivity');
  if (!ownersBox || !chartersBox) return;

  const mkt = marketMedians(60);
  const marketRef = document.getElementById('participantsMarket');
  if (marketRef) {
    marketRef.innerHTML = `Market median: <strong>offer ${fmtParty$(mkt.offer)}</strong> · <strong>bid ${fmtParty$(mkt.bid)}</strong> · <strong>fixed (30d) ${fmtParty$(mkt.fixed)}</strong>`;
  }

  if (activityBox) activityBox.innerHTML = renderActivityFeed();
  ownersBox.innerHTML = renderPartyCardList(aggregateOwners(), 'owner', mkt);
  chartersBox.innerHTML = renderPartyCardList(aggregateCharterers(), 'charterer', mkt);
}
