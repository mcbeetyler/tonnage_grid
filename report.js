// ─── Tonnage Report ──────────────────────────────────────────────────────────
// Shows best (cheapest) offers and best bids per ETA window.
// Windows are relative to today: Spot (0-10d), Near (11-20d), 21-30d, 31-40d, 41-50d, 50d+
// Also supports filtering by specific month.

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

  // Build options: "Relative" (spot/near/etc) + next 6 months
  let html = '<option value="relative">By Days Out (Spot / Near / ...)</option>';
  for (let i = 0; i < 8; i++) {
    const m = (curMonth + i) % 12;
    const y = curYear + Math.floor((curMonth + i) / 12);
    html += `<option value="${y}-${String(m + 1).padStart(2, '0')}">${months[m]} ${y}</option>`;
  }
  sel.innerHTML = html;
}

function getEtaWindows(mode) {
  if (mode === 'relative') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return [
      { label: 'Spot (0-10 days)', from: addDays(today, 0), to: addDays(today, 10) },
      { label: 'Near (11-20 days)', from: addDays(today, 11), to: addDays(today, 20) },
      { label: '21-30 days out', from: addDays(today, 21), to: addDays(today, 30) },
      { label: '31-40 days out', from: addDays(today, 31), to: addDays(today, 40) },
      { label: '41-50 days out', from: addDays(today, 41), to: addDays(today, 50) },
      { label: '50+ days out', from: addDays(today, 51), to: addDays(today, 365) },
    ];
  }
  // Monthly mode: split into 1-10, 11-20, 21+
  const [y, m] = mode.split('-').map(Number);
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const lastDay = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
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
  const eligible = vessels.filter(v => v.status === 'OPEN');

  let html = '';
  for (const win of windows) {
    // Find vessels whose ETA falls in this window
    const inWindow = eligible.filter(v => {
      if (!v.eta_ecsa) return false;
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    });

    if (inWindow.length === 0) continue;

    // Split into those with p6_offer and those with p6_bid
    const withOffer = inWindow
      .filter(v => { const p = getP6Values(v); return p.offer != null; })
      .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
      .slice(0, topN);

    const withBid = inWindow
      .filter(v => { const p = getP6Values(v); return p.bid != null; })
      .sort((a, b) => getP6Values(a).bid - getP6Values(b).bid)
      .slice(0, topN);

    if (withOffer.length === 0 && withBid.length === 0) continue;

    html += `<div class="report-window">
      <div class="report-window-header">
        <span class="report-window-title">${win.label}</span>
        <span class="report-window-meta">${inWindow.length} vessel${inWindow.length === 1 ? '' : 's'} in window</span>
        <button class="report-copy-btn" onclick="copyWindowReport('${win.label}', '${mode}')">Copy</button>
      </div>`;

    if ((showType === 'both' || showType === 'offers') && withOffer.length > 0) {
      html += `<div class="report-section">
        <div class="report-section-label offers">Best Offers (lowest P6)</div>`;
      withOffer.forEach((v, i) => { html += renderReportCard(v, i + 1, 'offer'); });
      html += '</div>';
    }

    if ((showType === 'both' || showType === 'bids') && withBid.length > 0) {
      html += `<div class="report-section">
        <div class="report-section-label">Best Bids (lowest P6)</div>`;
      withBid.forEach((v, i) => { html += renderReportCard(v, i + 1, 'bid'); });
      html += '</div>';
    }

    html += '</div>';
  }

  if (!html) {
    html = '<div class="report-empty" style="padding:40px;font-size:14px;text-align:center">No vessels with ETA data in the selected time frame.</div>';
  }

  container.innerHTML = html;
}

function renderReportCard(v, rank, type) {
  const p6 = getP6Values(v);
  const val = type === 'offer' ? p6.offer : p6.bid;
  const delivery = v.delivery_basis || v.current_position || '';
  const etaStr = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const etaType = v.eta_type === 'ONW' ? ' (ONW)' : '';
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) + 'K' : '?'}/${v.build_year || '?'}`;
  const hire = v.hire_offer ? '$' + v.hire_offer.toLocaleString() : '';
  const bki = v.bki_eqvt ? '$' + v.bki_eqvt.toLocaleString() : '';

  return `<div class="report-card">
    <span class="report-rank">#${rank}</span>
    <div>
      <div class="report-vessel-name">${v.vessel_name || '—'} ${specs}</div>
      <div class="report-detail">
        <strong>${v.owner || '—'}</strong> — ${delivery}${delivery && etaStr ? ' — ' : ''}ETA: ${etaStr}${etaType}
        ${hire ? '<br>Hire: ' + hire : ''}${bki ? ' · BKI: ' + bki : ''}
        ${v.notes ? '<br>' + v.notes : ''}
      </div>
    </div>
    <span class="report-p6 ${type}">${val != null ? '$' + val.toLocaleString() : '—'}</span>
  </div>`;
}

// ─── WhatsApp-format clipboard copy ──────────────────────────────────────────

function vesselToWhatsApp(v, type) {
  const p6 = getP6Values(v);
  const val = type === 'offer' ? p6.offer : p6.bid;
  const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
  const delivery = v.delivery_basis || v.current_position || '';
  const etaStr = v.eta_ecsa ? fmtDateReport(v.eta_ecsa) : '';
  const etaType = v.eta_type === 'ONW' ? ' (ONW)' : '';
  const typeLabel = type === 'bid' ? ' [BID]' : '';

  let text = `*${v.vessel_name || '?'} ${specs}*${typeLabel} — ${v.owner || '?'}`;
  if (delivery) text += ` — ${delivery}`;
  if (etaStr) text += ` — ETA: ${etaStr}${etaType}`;
  text += '\n';
  if (v.hire_offer) text += `HIRE: $${v.hire_offer.toLocaleString()}\n`;
  if (v.bb_offer) text += `BB: $${v.bb_offer.toLocaleString()}\n`;
  if (v.bki_eqvt) text += `BKI EQVLT: $${v.bki_eqvt.toLocaleString()}\n`;
  if (val != null) text += `P6 EQVLT: $${val.toLocaleString()}\n`;
  if (v.notes) text += `${v.notes}\n`;
  return text;
}

function copyWindowReport(winLabel, mode) {
  const windows = getEtaWindows(mode);
  const win = windows.find(w => w.label === winLabel);
  if (!win) return;

  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const showType = document.getElementById('reportType').value;
  const eligible = vessels.filter(v => v.status === 'OPEN');
  const inWindow = eligible.filter(v => {
    if (!v.eta_ecsa) return false;
    const eta = new Date(v.eta_ecsa);
    return eta >= win.from && eta <= win.to;
  });

  let text = `*${winLabel}*\n\n`;

  if (showType === 'both' || showType === 'offers') {
    const withOffer = inWindow
      .filter(v => getP6Values(v).offer != null)
      .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
      .slice(0, topN);
    if (withOffer.length > 0) {
      text += `*Best Offers:*\n`;
      withOffer.forEach(v => { text += vesselToWhatsApp(v, 'offer') + '\n'; });
    }
  }

  if (showType === 'both' || showType === 'bids') {
    const withBid = inWindow
      .filter(v => getP6Values(v).bid != null)
      .sort((a, b) => getP6Values(a).bid - getP6Values(b).bid)
      .slice(0, topN);
    if (withBid.length > 0) {
      text += `*Best Bids:*\n`;
      withBid.forEach(v => { text += vesselToWhatsApp(v, 'bid') + '\n'; });
    }
  }

  copyToClipboard(text.trim());
}

function copyFullReport() {
  const mode = document.getElementById('reportMonth').value;
  const topN = parseInt(document.getElementById('reportTopN').value, 10);
  const showType = document.getElementById('reportType').value;
  const windows = getEtaWindows(mode);
  const eligible = vessels.filter(v => v.status === 'OPEN');

  let text = `*Tonnage Report — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}*\n\n`;

  for (const win of windows) {
    const inWindow = eligible.filter(v => {
      if (!v.eta_ecsa) return false;
      const eta = new Date(v.eta_ecsa);
      return eta >= win.from && eta <= win.to;
    });
    if (inWindow.length === 0) continue;

    text += `━━━ *${win.label}* ━━━\n\n`;

    if (showType === 'both' || showType === 'offers') {
      const withOffer = inWindow
        .filter(v => getP6Values(v).offer != null)
        .sort((a, b) => getP6Values(a).offer - getP6Values(b).offer)
        .slice(0, topN);
      if (withOffer.length > 0) {
        text += `*OFFERS:*\n`;
        withOffer.forEach(v => { text += vesselToWhatsApp(v, 'offer') + '\n'; });
      }
    }

    if (showType === 'both' || showType === 'bids') {
      const withBid = inWindow
        .filter(v => getP6Values(v).bid != null)
        .sort((a, b) => getP6Values(a).bid - getP6Values(b).bid)
        .slice(0, topN);
      if (withBid.length > 0) {
        text += `*BIDS:*\n`;
        withBid.forEach(v => { text += vesselToWhatsApp(v, 'bid') + '\n'; });
      }
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
