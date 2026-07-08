/* ============================================================
   overview.js — morning glance strip on the ECSA board page.
   One row of pills, each a click-through:
     feeds age · ECSA open ships · NATL open · live cargoes ·
     next-30d supply · cheapest ECSA offer · cheapest NATL offers
   Pure read: computed from data already in the page.
   ============================================================ */

(function () {
'use strict';

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
if (!IS_BROWSER) return;

const NATL_EXCLUDED = ['GONE', 'FIXED', 'ONSUB'];

function natlData() {
  try {
    const stored = localStorage.getItem('lm_data');
    if (stored) return JSON.parse(stored);
  } catch (e) { /* ignore */ }
  return window.NA_SEED || null;
}

function fmtK(n) { return n == null ? '—' : '$' + (Math.round(n / 100) / 10).toFixed(1) + 'k'; }

function pill(label, value, tab, opts) {
  const o = opts || {};
  return `<span class="ov-pill${o.hot ? ' ov-hot' : ''}" data-tab="${tab || ''}" title="${o.title || ''}">` +
    `<b>${value}</b> <span class="ov-label">${label}</span></span>`;
}

function render() {
  const el = document.getElementById('ov_strip');
  if (!el) return;
  const pills = [];

  // ECSA board
  if (typeof vessels !== 'undefined' && Array.isArray(vessels) && vessels.length) {
    const open = vessels.filter(v => v.status === 'OPEN');
    pills.push(pill('ECSA open', open.length, 'tonnage'));
    const priced = open.map(v => (typeof getP6Values === 'function' ? getP6Values(v).offer : null))
      .filter(x => x != null).sort((a, b) => a - b);
    if (priced.length) pills.push(pill('cheapest P6 offer', fmtK(priced[0]), 'tonnage', { title: 'Lowest P6-equivalent offer among open ECSA ships' }));
  }

  // NATL board
  const nd = natlData();
  if (nd) {
    const live = nd.vessels.filter(v => !NATL_EXCLUDED.includes((v.region || '').toUpperCase()));
    pills.push(pill('NATL open', live.length, 'natlboard'));
    const ta = live.map(v => v.rate_ta).filter(x => x != null).sort((a, b) => a - b);
    const fh = live.map(v => v.rate_fh).filter(x => x != null).sort((a, b) => a - b);
    if (ta.length || fh.length) {
      pills.push(pill('cheapest TA / FH', `${fmtK(ta[0])} / ${fmtK(fh[0])}`, 'natlboard',
        { title: 'Lowest quoted NATL offers (TA / fronthaul)' }));
    }
  }

  // Cargo book
  if (typeof cargoHistory !== 'undefined' && typeof cargoCurrent !== 'undefined') {
    const liveCargo = cargoHistory.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
    pills.push(pill('live cargoes', liveCargo.length, 'cargo'));
    const fresh = liveCargo.filter(c => c.fresh).length;
    if (fresh) pills.push(pill('fresh today', fresh, 'cargo', { hot: true, title: 'Cargoes flagged FRESH in the latest book' }));
  }

  // Supply next-30 (ECSA ETAs)
  if (typeof vessels !== 'undefined' && Array.isArray(vessels)) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const n30 = vessels.filter(v => {
      if (v.status !== 'OPEN' || !v.eta_ecsa) return false;
      const d = (new Date(String(v.eta_ecsa).slice(0, 10) + 'T00:00:00') - today) / 86400000;
      return d >= 0 && d < 30;
    }).length;
    pills.push(pill('arriving 30d', n30, 'supply', { title: 'Open ECSA ships with ETA inside 30 days — click for the supply curve' }));
  }

  if (!pills.length) { el.style.display = 'none'; return; }
  el.innerHTML = pills.join('');
  el.style.display = '';
  el.querySelectorAll('.ov-pill').forEach(p => p.addEventListener('click', () => {
    if (p.dataset.tab) window.switchTab(p.dataset.tab);
  }));
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(render, 1200);          // let init() finish its fetch first
  setInterval(render, 60 * 1000);
});
// Re-render when returning to the board
const _origSwitchTabOv = window.switchTab;
window.switchTab = function (tab) {
  if (_origSwitchTabOv) _origSwitchTabOv(tab);
  if (tab === 'tonnage') render();
};

})();
