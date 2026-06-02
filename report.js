// ─── Tonnage Report ──────────────────────────────────────────────────────────
// Shows best (cheapest) offers and best bids per ETA window.
// Windows are laycan tags: 1-10 / 11-20 / 21+ of each month, matching the
// tonnage grid's laycan tags exactly.

// Vessels excluded from the current report (reset when switching tabs or changing filters)
let reportExcluded = new Set();

// Hook into tab switching
const _origSwitchTabReport = window.switchTab;
window.switchTab = function(tab) {
  _origSwitchTabReport(tab);
  if (tab === 'report') {
    populateReportMonths();
    renderReport();
  }
};

function populateReportMonths() {
  const sel = document.getElementById('reportMonth');
  if (!sel) return;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();

  // Build options: "By Laycan Tag" (current + next ~6 buckets) + next 6 months
  let html = '<option value="relative">By Laycan Tag</option>';
  for (let i = 0; i < 8; i++) {
    const m = (curMonth + i) % 12;
    const y = curYear + Math.floor((curMonth + i) / 12);
    html += `<option value="${y}-${String(m + 1).padStart(2, '0')}">${months[m]} ${y}</option>`;
  }
  sel.innerHTML = html;
}

function getEtaWindows(mode) {
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad = n => String(n).padStart(2, '0');

  if (mode === 'relative') {
    // Generate the next ~7 laycan-tag buckets starting from today's bucket.
    // Each month contributes 3 buckets (1-10, 11-20, 21+), so ~7 buckets ≈ 2.5 months.
    const today = new Date();
    let y = today.getFullYear();
    let m = today.getMonth() + 1;
    const d = today.getDate();
    let tier = d <= 10 ? 0 : d <= 20 ? 1 : 2;
    const out = [];
    for (let i = 0; i < 7; i++) {
      const lastDay = new Date(y, m, 0).getDate();
      let fromDay, toDay, tagLabel;
      if (tier === 0) { fromDay = 1;  toDay = 10;      tagLabel = '1-10'; }
      else if (tier === 1) { fromDay = 11; toDay = 20; tagLabel = '11-20'; }
      else { fromDay = 21; toDay = lastDay;            tagLabel = '21+'; }
      out.push({
        label: `${tagLabel} ${months[m]} ${y}`,
        from: new Date(`${y}-${pad(m)}-${pad(fromDay)}`),
        to: new Date(`${y}-${pad(m)}-${pad(toDay)}`),
      });
      tier++;
      if (tier > 2) { tier = 0; m++; if (m > 12) { m = 1; y++; } }
    }
    return out;
  }
  // Monthly mode: split into 1-10, 11-20, 21+
  const [y, m] = mode.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return [
    { label: `1-10 ${months[m]} ${y}`, from: new Date(`${y}-${pad(m)}-01`), to: new Date(`${y}-${pad(m)}-10`) },
    { label: `11-20 ${months[m]} ${y}`, from: new Date(`${y}-${pad(m)}-11`), to: new Date(`${y}-${pad(m)}-20`) },
    { label: `21+ ${months[m]} ${y}`, from: new Date(`${y}-${pad(m)}-21`), to: new Date(`${y}-${pad(m)}-${lastDay}`) },
  ];
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function fmtDateReport(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d, 10)}-${months[parseInt(m, 10)]}`;
}

function renderReport() {
  const mode = document.getElementById('reportMonth').value;
  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const showType = document.getElementById('reportType').value;
  const windows = getEtaWindows(mode);
  const container = document.getElementById('reportContent');

  // Filter to only OPEN/ON SUBS vessels
  const eligible = vessels.filter(v => v.status === 'OPEN' && !reportExcluded.has(v.vessel_name));

  renderP6IndexSidebar(eligible);

  let html = '';
  for (const win of windows) {
    // Find OPEN vessels whose ETA falls in this window
    const inWindow = eligible.filter(v => {
      if (!v.eta_ecsa) return false;
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    });

    // Find FIXED vessels whose ETA falls in this window (recent fixtures
    // for the aligned ETA, sorted by date_fixed desc — most recent first).
    const fixedInWindow = vessels.filter(v => {
      if (v.status !== 'FIXED') return false;
      if (reportExcluded.has(v.vessel_name)) return false;
      if (!v.eta_ecsa) return false;
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    }).sort((a, b) => (b.date_fixed || '').localeCompare(a.date_fixed || ''))
      .slice(0, topN);

    // Best offers: lowest P6 first
    const withOffer = inWindow
      .filter(v => { const p = getP6Values(v); return p.offer != null; })
      .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
      .slice(0, topN);

    // Best bids: HIGHEST P6 first (descending — what the market is paying up to)
    const withBid = inWindow
      .filter(v => { const p = getP6Values(v); return p.bid != null; })
      .sort((a, b) => getP6Values(b).bid - getP6Values(a).bid)
      .slice(0, topN);

    if (withOffer.length === 0 && withBid.length === 0 && fixedInWindow.length === 0) continue;

    html += `<div class="report-window">
      <div class="report-window-header">
        <span class="report-window-title">${win.label}</span>
        <span class="report-window-meta">${inWindow.length} open${fixedInWindow.length ? ' · ' + fixedInWindow.length + ' fixed' : ''}</span>
        <button class="report-copy-btn" onclick="copyWindowReport('${win.label}', '${mode}')">Copy</button>
      </div>
      <div class="report-window-body">
        <div class="report-window-left">`;

    if ((showType === 'both' || showType === 'offers') && withOffer.length > 0) {
      html += `<div class="report-section">
        <div class="report-section-label offers">Best Offers (lowest P6)</div>`;
      withOffer.forEach((v, i) => { html += renderReportCard(v, i + 1, 'offer'); });
      html += '</div>';
    }

    if ((showType === 'both' || showType === 'bids') && withBid.length > 0) {
      html += `<div class="report-section">
        <div class="report-section-label">Best Bids (highest P6)</div>`;
      withBid.forEach((v, i) => { html += renderReportCard(v, i + 1, 'bid'); });
      html += '</div>';
    }

    html += `</div>
      <div class="report-window-right">`;

    if (fixedInWindow.length > 0) {
      html += `<div class="report-section">
        <div style="display:flex;justify-content:space-between;align-items:center;padding-right:14px">
          <div class="report-section-label fixtures">Recent Fixtures</div>
          <button class="report-copy-btn" onclick="copyWindowFixtures('${win.label}', '${mode}')">Copy</button>
        </div>`;
      fixedInWindow.forEach((v, i) => { html += renderFixtureCard(v, i + 1); });
      html += '</div>';
    } else {
      html += `<div class="report-section">
        <div class="report-section-label fixtures">Recent Fixtures</div>
        <div class="report-empty" style="padding:8px 14px">No fixtures yet</div>
      </div>`;
    }

    html += `</div>
      </div>
    </div>`;
  }

  if (!html) {
    html = '<div class="report-empty" style="padding:40px;font-size:14px;text-align:center">No vessels with ETA data in the selected time frame.</div>';
  }

  // Show excluded count + restore button if any vessels are hidden
  if (reportExcluded.size > 0) {
    html = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:12px;color:var(--text-dim)">${reportExcluded.size} vessel${reportExcluded.size === 1 ? '' : 's'} hidden from report</span>
      <button class="filter-pill" onclick="restoreAllReport()" style="font-size:11px;padding:4px 12px">Restore all</button>
    </div>` + html;
  }

  container.innerHTML = html;
}

// P6 index window: 30-35 days from today. Shows latest bids/offers for
// vessels whose ETA falls in that range, sorted by last_updated desc.
function renderP6IndexSidebar(eligible) {
  const panel = document.getElementById('p6IndexPanel');
  if (!panel) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fromDate = addDays(today, 30);
  const toDate = addDays(today, 35);
  const monthAbbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtShort = d => `${d.getDate()} ${monthAbbr[d.getMonth()]}`;

  const inWindow = eligible.filter(v => {
    if (!v.eta_ecsa) return false;
    const eta = new Date(v.eta_ecsa);
    return eta >= fromDate && eta <= toDate;
  });

  const byUpdated = (a, b) => (b.last_updated || '').localeCompare(a.last_updated || '');
  const offers = inWindow.filter(v => getP6Values(v).offer != null).sort(byUpdated);
  const bids = inWindow.filter(v => getP6Values(v).bid != null).sort(byUpdated);

  let html = `<div class="p6-index-panel">
    <div class="p6-index-header">
      <div class="p6-index-title">P6 Index Window</div>
      <div class="p6-index-dates">${fmtShort(fromDate)} – ${fmtShort(toDate)}</div>
      <div class="p6-index-meta">${inWindow.length} vessel${inWindow.length === 1 ? '' : 's'} • 30–35 days out</div>
    </div>`;

  if (offers.length === 0 && bids.length === 0) {
    html += `<div class="p6-index-empty">No quotes in this window</div>`;
  } else {
    if (offers.length > 0) {
      html += `<div class="p6-index-section-label" style="color:var(--red)">Latest Offers</div>`;
      offers.forEach(v => { html += renderP6IndexRow(v, 'offer'); });
    }
    if (bids.length > 0) {
      html += `<div class="p6-index-section-label" style="color:var(--green)">Latest Bids</div>`;
      bids.forEach(v => { html += renderP6IndexRow(v, 'bid'); });
    }
  }

  html += `</div>`;
  panel.innerHTML = html;
}

function renderP6IndexRow(v, type) {
  const p6 = getP6Values(v);
  const val = type === 'offer' ? p6.offer : p6.bid;
  const eta = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const tsField = type === 'offer' ? v.offer_updated_at : v.bid_updated_at;
  const ts = tsField ? fmtTimestamp(tsField) : (v.last_updated ? fmtTimestamp(v.last_updated) : '');
  const stale = stalenessTag(tsField, type === 'offer' ? 'Offer' : 'Bid');
  return `<div class="p6-index-row${stale ? ' p6-index-row-stale' : ''}">
    <div class="p6-index-row-name" title="${(v.vessel_name || '').replace(/"/g,'&quot;')}">${v.vessel_name || '?'}</div>
    <div class="p6-index-row-eta">${eta}</div>
    <div class="p6-index-row-val ${type}">${val != null ? val.toLocaleString() : '—'}${stale}</div>
    ${ts ? `<div class="p6-index-row-ts">${ts}</div>` : ''}
  </div>`;
}

function renderReportCard(v, rank, type) {
  const p6 = getP6Values(v);
  const val = type === 'offer' ? p6.offer : p6.bid;
  const delivery = v.delivery_basis || v.current_position || '';
  const etaStr = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const etaType = v.eta_type === 'ONW' ? ' ONW' : '';
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
  const hire = v.hire_offer ? '$' + v.hire_offer.toLocaleString() : '';
  const bb = v.bb_offer ? '$' + v.bb_offer.toLocaleString() : '';
  const tsField = type === 'offer' ? v.offer_updated_at : v.bid_updated_at;
  const stale = stalenessTag(tsField, type === 'offer' ? 'Offer' : 'Bid');

  const safeName = (v.vessel_name || '').replace(/'/g, "\\'");

  // Build compact detail chips
  const chips = [];
  if (delivery) chips.push(delivery);
  if (etaStr) chips.push('ETA ' + etaStr + etaType);
  if (hire) chips.push('Hire ' + hire);
  if (bb) chips.push('BB ' + bb);

  return `<div class="report-card${stale ? ' report-card-stale' : ''}">
    <span class="report-rank">${rank}</span>
    <span class="report-vessel-name">${v.vessel_name || '—'} <span class="report-specs">${specs}</span></span>
    <span class="report-owner">${v.owner || '—'}</span>
    <span class="report-chips">${chips.join(' · ')}</span>
    <span class="report-p6 ${type}">${val != null ? '$' + val.toLocaleString() : '—'}${stale}</span>
    <button class="btn-remove" onclick="excludeFromReport('${safeName}')" title="Remove" style="padding:2px 6px">x</button>
  </div>`;
}

function renderFixtureCard(v, rank) {
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
  const fixedPx = v.fixed_price ? '$' + v.fixed_price.toLocaleString() : '—';
  const dateFixed = v.date_fixed ? fmtDateReport(v.date_fixed) : '';
  const charterer = v.charterer || '—';
  const safeName = (v.vessel_name || '').replace(/'/g, "\\'");
  return `<div class="report-card">
    <span class="report-rank">${rank}</span>
    <span class="report-vessel-name">${v.vessel_name || '—'} <span class="report-specs">${specs}</span></span>
    <span class="report-chips" title="${charterer.replace(/"/g,'&quot;')}">${charterer}</span>
    <span class="report-fixture-date">${dateFixed}</span>
    <span class="report-p6 fixed">${fixedPx}</span>
    <button class="btn-remove" onclick="excludeFromReport('${safeName}')" title="Remove" style="padding:2px 6px">x</button>
  </div>`;
}

function excludeFromReport(vesselName) {
  reportExcluded.add(vesselName);
  renderReport();
}

function restoreAllReport() {
  reportExcluded.clear();
  renderReport();
}

// ─── WhatsApp-format clipboard copy (Option B — compact) ────────────────────

function vesselToWhatsApp(v, type) {
  const p6 = getP6Values(v);
  const val = type === 'offer' ? p6.offer : p6.bid;
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
  const delivery = v.delivery_basis || v.current_position || '';
  const etaStr = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const etaType = v.eta_type === 'ONW' ? ' (ONW)' : '';
  const typeLabel = type === 'bid' ? ' [BID]' : '';

  let line1 = `*${v.vessel_name || '?'} ${specs}*${typeLabel}`;
  if (delivery) line1 += ` — ${delivery}`;
  if (etaStr) line1 += ` — ETA: ${etaStr}${etaType}`;

  const parts = [];
  if (val != null) parts.push(`P6: $${val.toLocaleString()}`);
  if (v.hire_offer) parts.push(`Hire: $${v.hire_offer.toLocaleString()}`);
  if (v.bb_offer) parts.push(`BB: $${v.bb_offer.toLocaleString()}`);

  return line1 + '\n' + parts.join(' | ');
}

function fixtureToWhatsApp(v) {
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
  const etaStr = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const etaType = v.eta_type === 'ONW' ? ' (ONW)' : '';
  const dateFixed = v.date_fixed ? fmtDateReport(v.date_fixed) : '';
  const charterer = v.charterer || '';

  let line1 = `*${v.vessel_name || '?'} ${specs}* [FIXED]`;
  if (etaStr) line1 += ` — ETA: ${etaStr}${etaType}`;

  const parts = [];
  if (v.fixed_price != null) parts.push(`P6: $${v.fixed_price.toLocaleString()}`);
  if (charterer) parts.push(`to ${charterer}`);
  if (dateFixed) parts.push(`fixed ${dateFixed}`);

  return line1 + '\n' + parts.join(' | ');
}

// Shared helper: collect top-N FIXED vessels in a given window, respecting exclusions.
function fixedVesselsInWindow(win, topN) {
  return vessels
    .filter(v => v.status === 'FIXED' && !reportExcluded.has(v.vessel_name) && v.eta_ecsa)
    .filter(v => {
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    })
    .sort((a, b) => (b.date_fixed || '').localeCompare(a.date_fixed || ''))
    .slice(0, topN);
}

function copyWindowReport(winLabel, mode) {
  const windows = getEtaWindows(mode);
  const win = windows.find(w => w.label === winLabel);
  if (!win) return;

  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const showType = document.getElementById('reportType').value;
  const eligible = vessels.filter(v => v.status === 'OPEN' && !reportExcluded.has(v.vessel_name));
  const inWindow = eligible.filter(v => {
    if (!v.eta_ecsa) return false;
    const eta = new Date(v.eta_ecsa);
    return eta >= win.from && eta <= win.to;
  });

  let text = `*${winLabel}*\n`;

  if (showType === 'both' || showType === 'offers') {
    const withOffer = inWindow
      .filter(v => getP6Values(v).offer != null)
      .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
      .slice(0, topN);
    if (withOffer.length > 0) {
      withOffer.forEach(v => { text += vesselToWhatsApp(v, 'offer') + '\n'; });
    }
  }

  if (showType === 'both' || showType === 'bids') {
    const withBid = inWindow
      .filter(v => getP6Values(v).bid != null)
      .sort((a, b) => getP6Values(b).bid - getP6Values(a).bid)
      .slice(0, topN);
    if (withBid.length > 0) {
      text += `_Bids:_\n`;
      withBid.forEach(v => { text += vesselToWhatsApp(v, 'bid') + '\n'; });
    }
  }

  const fixedInWindow = fixedVesselsInWindow(win, topN);
  if (fixedInWindow.length > 0) {
    text += `_Recent fixtures:_\n`;
    fixedInWindow.forEach(v => { text += fixtureToWhatsApp(v) + '\n'; });
  }

  copyToClipboard(text.trim());
}

function copyWindowFixtures(winLabel, mode) {
  const windows = getEtaWindows(mode);
  const win = windows.find(w => w.label === winLabel);
  if (!win) return;
  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const fixedInWindow = fixedVesselsInWindow(win, topN);
  if (fixedInWindow.length === 0) return;

  let text = `*${winLabel} — Recent fixtures*\n`;
  fixedInWindow.forEach(v => { text += fixtureToWhatsApp(v) + '\n'; });
  copyToClipboard(text.trim());
}

function copyFullReport() {
  const mode = document.getElementById('reportMonth').value;
  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const showType = document.getElementById('reportType').value;
  const windows = getEtaWindows(mode);
  const eligible = vessels.filter(v => v.status === 'OPEN' && !reportExcluded.has(v.vessel_name));

  let text = `*Tonnage Report — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}*\n`;

  for (const win of windows) {
    const inWindow = eligible.filter(v => {
      if (!v.eta_ecsa) return false;
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    });
    const fixedInWindow = fixedVesselsInWindow(win, topN);
    if (inWindow.length === 0 && fixedInWindow.length === 0) continue;

    text += `\n*${win.label}*\n`;

    if (showType === 'both' || showType === 'offers') {
      const withOffer = inWindow
        .filter(v => getP6Values(v).offer != null)
        .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
        .slice(0, topN);
      if (withOffer.length > 0) {
        withOffer.forEach(v => { text += vesselToWhatsApp(v, 'offer') + '\n'; });
      }
    }

    if (showType === 'both' || showType === 'bids') {
      const withBid = inWindow
        .filter(v => getP6Values(v).bid != null)
        .sort((a, b) => getP6Values(b).bid - getP6Values(a).bid)
        .slice(0, topN);
      if (withBid.length > 0) {
        text += `_Bids:_\n`;
        withBid.forEach(v => { text += vesselToWhatsApp(v, 'bid') + '\n'; });
      }
    }

    if (fixedInWindow.length > 0) {
      text += `_Recent fixtures:_\n`;
      fixedInWindow.forEach(v => { text += fixtureToWhatsApp(v) + '\n'; });
    }

    text += '\n';
  }

  copyToClipboard(text.trim());
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copyToast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const toast = document.getElementById('copyToast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
}
