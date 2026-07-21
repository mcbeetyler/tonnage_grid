/* ============================================================
   scrubber-calc.js — "Scrubber" tab
   An honest scrubber-ship calculator, built around how quotes
   actually arrive (see MV Zhen May particulars, the calibration
   example):

   THE TRAPS THIS ENGINE AVOIDS
   1. Quoted spd/cons are "M/E only" — the generator rides on
      top. All-in = M/E + G/E (+ incinerator MDO).
   2. The scrubber has a parasitic load: the G/E burns MORE when
      the scrubber runs (Zhen May: 3.25 vs 2.50 mt/day). Naive
      "spread × tonnes" overstates the benefit.
   3. The benefit is a SCENARIO DIFFERENCE, not an arithmetic
      shortcut: cost as scrubber ship on HSFO (scrubber G/E)
      minus cost of the same voyage compliant on VLSFO (base
      G/E).
   4. ECA legs wash out: both scenarios burn MGO there, scrubber
      idle (base G/E both sides).

   Engine is pure and unit-tested; UI prefills Zhen May + the
   desk's bunker prices.
   ============================================================ */

(function () {
'use strict';

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const LS_UI = 'sc_ui';

// ─── Engine ──────────────────────────────────────────────────────────────────
/**
 * @param i {
 *   ballastDist, ballastKn, ballastMe,   // nm, knots, M/E-only mt/day
 *   ladenDist, ladenKn, ladenMe,
 *   geBase, geScrub,                     // G/E mt/day: normal vs scrubber running
 *   mdoSea,                              // incinerator etc, mt/day at sea
 *   portIdleDays, portIdleCons, portWorkDays, portWorkCons,
 *   seaMarginPct,                        // weather allowance on sea days
 *   ecaPct,                              // % of sea time inside ECA (both burn MGO)
 *   pxHSFO, pxVLSFO, pxMGO,
 *   hire, split                          // split: 'owner' | '5050' | 'chtr'
 * }
 */
function computeScrubber(i) {
  const m = 1 + (num(i.seaMarginPct) || 0) / 100;
  const daysB = i.ballastDist > 0 && i.ballastKn > 0 ? i.ballastDist / i.ballastKn / 24 * m : 0;
  const daysL = i.ladenDist > 0 && i.ladenKn > 0 ? i.ladenDist / i.ladenKn / 24 * m : 0;
  const seaDays = daysB + daysL;
  const portDays = (num(i.portIdleDays) || 0) + (num(i.portWorkDays) || 0);
  const totalDays = seaDays + portDays;
  const eca = Math.min(Math.max(num(i.ecaPct) || 0, 0), 100) / 100;

  // Daily all-in at sea (the number the quote does NOT give you)
  const dailyScrubB = i.ballastMe + i.geScrub;
  const dailyScrubL = i.ladenMe + i.geScrub;
  const dailyCompB = i.ballastMe + i.geBase;
  const dailyCompL = i.ladenMe + i.geBase;

  // Sea tonnes outside ECA (scrubber running vs compliant)
  const scrubSeaIfo = (dailyScrubB * daysB + dailyScrubL * daysL) * (1 - eca);
  const compSeaIfo = (dailyCompB * daysB + dailyCompL * daysL) * (1 - eca);
  // ECA: scrubber off (base G/E), both burn MGO — identical tonnes
  const ecaMgo = (dailyCompB * daysB + dailyCompL * daysL) * eca;
  // Incinerator/aux MDO at sea, both scenarios
  const seaMdo = (num(i.mdoSea) || 0) * seaDays;
  // Port: same tonnes, different fuel (scrubber runs in port where permitted)
  const portTonnes = (num(i.portIdleDays) || 0) * (num(i.portIdleCons) || 0)
    + (num(i.portWorkDays) || 0) * (num(i.portWorkCons) || 0);

  const scrubCost = scrubSeaIfo * i.pxHSFO + portTonnes * i.pxHSFO + (ecaMgo + seaMdo) * i.pxMGO;
  const compCost = compSeaIfo * i.pxVLSFO + portTonnes * i.pxVLSFO + (ecaMgo + seaMdo) * i.pxMGO;

  const benefitTotal = compCost - scrubCost;
  const benefitPerDay = totalDays > 0 ? benefitTotal / totalDays : 0;

  // The naive number (spread × all-in tonnes) ALWAYS overstates: it prices
  // the fuel as if the scrubber ship burned the compliant ship's tonnes.
  // Identity: true benefit = compliantTonnes × spread − extraScrubberTonnes × HSFO
  const spread = i.pxVLSFO - i.pxHSFO;
  const naivePerDay = totalDays > 0 ? spread * (compSeaIfo + portTonnes) / totalDays : 0;

  // Who pockets it
  const split = i.split || 'owner';
  const toCharterer = split === 'chtr' ? benefitPerDay : split === '5050' ? benefitPerDay / 2 : 0;
  const hire = num(i.hire) || 0;
  const effectiveHire = hire - toCharterer;   // what the hire "feels like" vs a non-scrubber ship

  return {
    daysB, daysL, seaDays, portDays, totalDays,
    dailyScrubB, dailyScrubL, dailyCompB, dailyCompL,
    scrubSeaIfo, compSeaIfo, ecaMgo, seaMdo, portTonnes,
    scrubCost, compCost, benefitTotal, benefitPerDay,
    naivePerDay, parasiticPenaltyPerDay: naivePerDay - benefitPerDay,
    spread, toCharterer, effectiveHire,
  };
}
function num(v) { const f = parseFloat(v); return isNaN(f) ? 0 : f; }

// ─── Defaults: MV Zhen May + desk bunker prices ─────────────────────────────
const ZHEN_MAY = {
  ballastDist: 3000, ballastKn: 14.0, ballastMe: 25.0,
  ladenDist: 6000, ladenKn: 13.5, ladenMe: 28.0,
  geBase: 2.5, geScrub: 3.25, mdoSea: 0.1,
  portIdleDays: 2, portIdleCons: 4.5, portWorkDays: 8, portWorkCons: 6.0,
  seaMarginPct: 5, ecaPct: 0,
  pxHSFO: 453, pxVLSFO: 647, pxMGO: 925,   // desk sheet: VLSFO 647, spread -194, MGO 925
  hire: 20000, split: 'chtr',
};

let ui = Object.assign({}, ZHEN_MAY, IS_BROWSER ? JSON.parse(localStorage.getItem(LS_UI) || '{}') : {});
function saveUi() { if (IS_BROWSER) localStorage.setItem(LS_UI, JSON.stringify(ui)); }

// ─── UI ──────────────────────────────────────────────────────────────────────
let SC = { initialised: false };
const F = [ // id, label, hint, group
  ['ballastDist', 'Ballast dist NM'], ['ballastKn', 'Ballast kn'], ['ballastMe', 'Ballast M/E mt/d'],
  ['ladenDist', 'Laden dist NM'], ['ladenKn', 'Laden kn'], ['ladenMe', 'Laden M/E mt/d'],
  ['geBase', 'G/E normal mt/d'], ['geScrub', 'G/E scrubber ON mt/d'], ['mdoSea', 'MDO at sea mt/d'],
  ['portIdleDays', 'Idle days'], ['portIdleCons', 'Idle mt/d'], ['portWorkDays', 'Working days'], ['portWorkCons', 'Working mt/d'],
  ['seaMarginPct', 'Sea margin %'], ['ecaPct', 'ECA % of sea time'],
  ['pxHSFO', 'HSFO $/mt'], ['pxVLSFO', 'VLSFO $/mt'], ['pxMGO', 'MGO $/mt'],
  ['hire', 'Hire $/day'],
];

function fmt$(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
function fmt1(n) { return (Math.round(n * 10) / 10).toLocaleString(); }

function render() {
  const out = document.getElementById('sc_out');
  if (!out) return;
  const r = computeScrubber(ui);
  const splitLabel = { owner: 'owner keeps all', '5050': '50/50 split', chtr: "charterers' account" }[ui.split || 'owner'];
  out.innerHTML = `
    <div class="ve-card"><h3>Daily all-in consumption <span style="text-transform:none;font-weight:400">(the quote is M/E only)</span></h3>
      <div class="ve-body" style="font-size:13px;line-height:2">
        Ballast, scrubber on: <b>${fmt1(r.dailyScrubB)} mt HSFO</b> + ${ui.mdoSea} MDO &nbsp;·&nbsp; compliant would be ${fmt1(r.dailyCompB)} mt VLSFO<br>
        Laden, scrubber on: <b>${fmt1(r.dailyScrubL)} mt HSFO</b> + ${ui.mdoSea} MDO &nbsp;·&nbsp; compliant would be ${fmt1(r.dailyCompL)} mt VLSFO<br>
        <span style="color:var(--text-dim)">Voyage: ${fmt1(r.daysB)}d ballast + ${fmt1(r.daysL)}d laden + ${fmt1(r.portDays)}d port = ${fmt1(r.totalDays)}d</span>
      </div></div>
    <div class="ve-card"><h3>Scrubber benefit — scenario difference, not spread × tonnes</h3>
      <div class="ve-body" style="font-size:13px;line-height:2">
        Voyage on HSFO (scrubber): <b>${fmt$(r.scrubCost)}</b> &nbsp;(${fmt1(r.scrubSeaIfo + r.portTonnes)} mt HSFO${r.ecaMgo + r.seaMdo > 0 ? ' + ' + fmt1(r.ecaMgo + r.seaMdo) + ' mt MGO' : ''})<br>
        Same voyage compliant (VLSFO): <b>${fmt$(r.compCost)}</b><br>
        <span style="font-size:16px">Net benefit: <b style="color:var(--green)">${fmt$(r.benefitPerDay)}/day</b> &nbsp;(${fmt$(r.benefitTotal)} total)</span><br>
        <span style="color:var(--text-dim)" title="spread × tonnes, ignoring that the scrubber itself burns extra fuel">Spread × tonnes says ${fmt$(r.naivePerDay)}/day — the scrubber's own appetite eats ${fmt$(r.parasiticPenaltyPerDay)}/day of that</span>
      </div></div>
    <div class="ve-card"><h3>Hire equivalence (${splitLabel})</h3>
      <div class="ve-body" style="font-size:13px;line-height:2">
        Benefit to charterer: <b>${fmt$(r.toCharterer)}/day</b><br>
        Her ${fmt$(num(ui.hire))} hire ≈ a <b>${fmt$(r.effectiveHire)}</b> non-scrubber ship<br>
        <span style="color:var(--text-dim)">Max scrubber premium worth paying at this spread (chtr account): ${fmt$(r.benefitPerDay)}/day</span>
      </div></div>`;
}

function buildUI() {
  const root = document.getElementById('sc_root');
  if (!root) return;
  root.innerHTML = `
    <div style="padding:20px 28px;max-width:1200px">
      <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:6px;flex-wrap:wrap">
        <h2 style="font-size:16px;font-weight:700;color:var(--text-bright)">Scrubber Calc</h2>
        <div style="font-size:12px;color:var(--text-dim)">enter the quote's M/E-only figures — the engine adds G/E, parasitic scrubber load, MDO, port and ECA properly</div>
        <div style="flex:1"></div>
        <button class="lm-mini" id="sc_example" style="padding:6px 14px" title="MV Zhen May (Oshima 2021 Kamsarmax) + desk bunker prices">Load Zhen May example</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0" id="sc_fields">
        ${F.map(([id, label]) => `<div class="pr-field"><label>${label}</label>
          <input type="number" step="any" id="sc_${id}" style="width:110px" value="${ui[id] ?? ''}"></div>`).join('')}
        <div class="pr-field"><label>Benefit split</label>
          <select id="sc_split">
            <option value="owner"${ui.split === 'owner' ? ' selected' : ''}>Owner keeps</option>
            <option value="5050"${ui.split === '5050' ? ' selected' : ''}>50 / 50</option>
            <option value="chtr"${ui.split === 'chtr' ? ' selected' : ''}>Charterers' account</option>
          </select></div>
      </div>
      <div id="sc_out" style="display:flex;flex-direction:column;gap:12px"></div>
    </div>`;

  F.forEach(([id]) => document.getElementById('sc_' + id).addEventListener('input', e => {
    ui[id] = parseFloat(e.target.value);
    saveUi(); render();
  }));
  document.getElementById('sc_split').addEventListener('change', e => { ui.split = e.target.value; saveUi(); render(); });
  document.getElementById('sc_example').addEventListener('click', () => {
    ui = Object.assign({}, ZHEN_MAY);
    saveUi();
    F.forEach(([id]) => { const el = document.getElementById('sc_' + id); if (el) el.value = ui[id]; });
    document.getElementById('sc_split').value = ui.split;
    render();
  });
}

function scInit() {
  if (!SC.initialised) { buildUI(); SC.initialised = true; }
  render();
}

if (IS_BROWSER) {
  const _origSwitchTabSc = window.switchTab;
  window.switchTab = function (tab) {
    if (_origSwitchTabSc) _origSwitchTabSc(tab);
    if (tab === 'scrubber') scInit();
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeScrubber, ZHEN_MAY };
}

})();
