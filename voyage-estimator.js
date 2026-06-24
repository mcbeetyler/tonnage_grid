// ─── Voyage Estimator Tab ────────────────────────────────────────────────────
// Two layers:
//   Layer 1 — standalone calculator ported from voyage-estimator.html.
//             Always works regardless of live data. Uses VoyageCalc engine.
//   Layer 2 — vessel picker (reads `vessels` global from app.js),
//             cargo picker (reads `cargoHistory`/`cargoCurrent` from cargo.js),
//             and an export hook so market.js can plot computed TCE as a
//             reference line on the P6 scatter (window.voyageEstimatorComputedTce).

const VE = {
  mode: 'rate2tce',       // 'rate2tce' | 'tce2rate'
  scrubSplit: 'owner',    // 'owner' | '5050' | 'chtr'
  initialised: false,
};

// Numeric input ids — same keys as P8_TESS82_DEFAULTS where possible.
const VE_INPUT_IDS = [
  'intake','rate','targetTce','comm',
  'loadCost','dischCost','canalCost','miscCost',
  'ballDist','ladenDist','ballSpd','ladenSpd','wxMargin',
  'ballCons','ladenCons','ballMgo','ladenMgo',
  'loadDays','dischDays','idleDays','portCons',
  'pxVlsfo','pxMgo','pxHsfo',
];

function veEl(id) { return document.getElementById('ve_' + id); }
function veVal(id) {
  const el = veEl(id);
  if (!el) return 0;
  const n = parseFloat(el.value);
  return isNaN(n) ? 0 : n;
}
function veFmt(n)  { return n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function veFmt2(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Build the inputs object the engine expects from the current DOM.
function veGatherInputs() {
  return {
    intake: veVal('intake'),
    commPct: veVal('comm') / 100,
    ballDist: veVal('ballDist'), ladenDist: veVal('ladenDist'),
    ballSpd:  veVal('ballSpd'),  ladenSpd:  veVal('ladenSpd'),
    wxMarginPct: veVal('wxMargin') / 100,
    ballCons: veVal('ballCons'), ladenCons: veVal('ladenCons'),
    ballMgo:  veVal('ballMgo'),  ladenMgo:  veVal('ladenMgo'),
    loadDays: veVal('loadDays'), dischDays: veVal('dischDays'),
    idleDays: veVal('idleDays'), portCons:  veVal('portCons'),
    pxVlsfo:  veVal('pxVlsfo'),  pxMgo:     veVal('pxMgo'),
    pxHsfo:   veVal('pxHsfo'),
    loadCost: veVal('loadCost'), dischCost: veVal('dischCost'),
    canalCost: veVal('canalCost'), miscCost: veVal('miscCost'),
    scrubberFitted: veEl('scrubFitted')?.value === 'yes',
    scrubSplit: VE.scrubSplit,
  };
}

// Main render. Runs on every input change.
function veRender() {
  const i = veGatherInputs();
  const breakdown = document.getElementById('ve_breakdown');
  const hLbl = document.getElementById('ve_hLbl');
  const hBig = document.getElementById('ve_hBig');
  const hAlt = document.getElementById('ve_hAlt');
  const copyBtn = document.getElementById('ve_copyBtn');
  if (!breakdown || !hBig || !window.VoyageCalc) return;

  if (VE.mode === 'rate2tce') {
    const r = window.VoyageCalc.rateToTce(Object.assign({}, i, { rate: veVal('rate') }));
    hLbl.textContent = 'Time-charter equivalent';
    hBig.classList.remove('amber');
    hBig.innerHTML = '<span class="cur">$</span>' + veFmt(r.tce) +
      ' <span style="font-size:15px;color:var(--text-dim)">/day</span>';
    hAlt.textContent = veFmt2(veVal('rate')) + ' $/mt · ' + r.totalDays.toFixed(1) + ' voyage days';

    breakdown.innerHTML =
      `<div class="ve-bd-row"><span class="k">Gross freight (${veFmt(i.intake)}mt × ${veFmt2(veVal('rate'))})</span><span class="v">$${veFmt(r.gross)}</span></div>` +
      `<div class="ve-bd-row neg"><span class="k">Commission (${veVal('comm')}%)</span><span class="v">−$${veFmt(r.commission)}</span></div>` +
      `<div class="ve-bd-row"><span class="k">Net freight</span><span class="v">$${veFmt(r.netFreight)}</span></div>` +
      `<div class="ve-bd-row neg"><span class="k">Bunkers</span><span class="v">−$${veFmt(r.bunkerCost)}</span></div>` +
      `<div class="ve-bd-row neg"><span class="k">Port / canal / misc</span><span class="v">−$${veFmt(r.portCharges)}</span></div>` +
      (i.scrubberFitted ? `<div class="ve-bd-row"><span class="k">Scrubber benefit (owner)</span><span class="v" style="color:var(--amber)">+$${veFmt(r.ownerScrubBenefit)}</span></div>` : '') +
      `<div class="ve-bd-row"><span class="k">Voyage days</span><span class="v">${r.totalDays.toFixed(1)}</span></div>` +
      `<div class="ve-bd-row total"><span class="k">TCE</span><span class="v">$${veFmt(r.tce)}/day</span></div>`;

    veBuildSensitivity('rate', veVal('rate'), i.intake, i.commPct, r.voyageCost, r.ownerScrubBenefit, r.totalDays);
    copyBtn.dataset.copy = `P8 Santos/Qingdao est · ${veFmt(i.intake)}mt @ ${veFmt2(veVal('rate'))}/mt · ${veVal('comm')}%ttl → TCE $${veFmt(r.tce)}/day basis ${r.totalDays.toFixed(1)} days`;

    // Layer 2 export: expose computed TCE for market.js reference line.
    window.voyageEstimatorComputedTce = { tce: r.tce, rate: veVal('rate'), intake: i.intake, mode: 'rate2tce' };
  } else {
    const r = window.VoyageCalc.tceToRate(Object.assign({}, i, { targetTce: veVal('targetTce') }));
    hLbl.textContent = 'Breakeven freight rate';
    hBig.classList.add('amber');
    hBig.innerHTML = '<span class="cur">$</span>' + veFmt2(r.rate) +
      ' <span style="font-size:15px;color:var(--text-dim)">/mt</span>';
    hAlt.textContent = 'to earn $' + veFmt(veVal('targetTce')) + '/day · ' + r.totalDays.toFixed(1) + ' voyage days';

    breakdown.innerHTML =
      `<div class="ve-bd-row"><span class="k">Target TCE</span><span class="v">$${veFmt(veVal('targetTce'))}/day</span></div>` +
      `<div class="ve-bd-row"><span class="k">× voyage days (${r.totalDays.toFixed(1)})</span><span class="v">$${veFmt(veVal('targetTce') * r.totalDays)}</span></div>` +
      `<div class="ve-bd-row"><span class="k">+ bunkers</span><span class="v">$${veFmt(r.bunkerCost)}</span></div>` +
      `<div class="ve-bd-row"><span class="k">+ port / canal / misc</span><span class="v">$${veFmt(r.portCharges)}</span></div>` +
      (i.scrubberFitted ? `<div class="ve-bd-row"><span class="k">− scrubber benefit (owner)</span><span class="v" style="color:var(--amber)">−$${veFmt(r.ownerScrubBenefit)}</span></div>` : '') +
      `<div class="ve-bd-row"><span class="k">= net freight needed</span><span class="v">$${veFmt(r.netNeeded)}</span></div>` +
      `<div class="ve-bd-row"><span class="k">÷ (1 − ${veVal('comm')}% comm) = gross</span><span class="v">$${veFmt(r.grossNeeded)}</span></div>` +
      `<div class="ve-bd-row total"><span class="k">Breakeven rate</span><span class="v">$${veFmt2(r.rate)}/mt</span></div>`;

    veBuildSensitivity('tce', veVal('targetTce'), i.intake, i.commPct, r.voyageCost, r.ownerScrubBenefit, r.totalDays);
    copyBtn.dataset.copy = `P8 Santos/Qingdao est · target TCE $${veFmt(veVal('targetTce'))}/day → breakeven ${veFmt2(r.rate)}/mt on ${veFmt(i.intake)}mt · ${veVal('comm')}%ttl`;

    window.voyageEstimatorComputedTce = { tce: veVal('targetTce'), rate: r.rate, intake: i.intake, mode: 'tce2rate' };
  }

  // Notify any chart that wants to refresh its reference line.
  if (typeof window.onVoyageEstimatorUpdate === 'function') {
    try { window.onVoyageEstimatorUpdate(window.voyageEstimatorComputedTce); } catch (e) {}
  }
}

function veBuildSensitivity(kind, base, intake, commPct, voyageCost, ownerScrub, days) {
  const tbl = document.getElementById('ve_sensTbl');
  const note = document.getElementById('ve_sensNote');
  const title = document.getElementById('ve_sensTitle');
  if (!tbl) return;

  if (kind === 'rate') {
    title.textContent = 'Sensitivity · rate → TCE';
    const steps = [-1.0, -0.5, -0.25, 0, 0.25, 0.5, 1.0];
    const midTce = ((base * intake) * (1 - commPct) - voyageCost + ownerScrub) / days;
    let html = '<tr><th>Rate $/mt</th><th>TCE $/day</th><th>Δ vs mid</th></tr>';
    steps.forEach(s => {
      const r = base + s;
      const tce = ((r * intake) * (1 - commPct) - voyageCost + ownerScrub) / days;
      const delta = tce - midTce;
      const cls = s === 0 ? 'mid' : '';
      const dcls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
      html += `<tr class="${cls}"><td>${veFmt2(r)}</td><td>$${veFmt(tce)}</td><td class="${dcls}">${delta > 0 ? '+' : ''}${veFmt(delta)}</td></tr>`;
    });
    tbl.innerHTML = html;
    note.innerHTML = 'Each $0.25/mt → <strong>$' + veFmt(0.25 * intake * (1 - commPct) / days) + '/day</strong> of TCE on this voyage.';
  } else {
    title.textContent = 'Sensitivity · TCE → rate';
    const steps = [-2000, -1000, -500, 0, 500, 1000, 2000];
    const midRate = (base * days + voyageCost - ownerScrub) / (1 - commPct) / intake;
    let html = '<tr><th>Target $/day</th><th>Rate $/mt</th><th>Δ vs mid</th></tr>';
    steps.forEach(s => {
      const t = base + s;
      const rate = (t * days + voyageCost - ownerScrub) / (1 - commPct) / intake;
      const delta = rate - midRate;
      const cls = s === 0 ? 'mid' : '';
      const dcls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
      html += `<tr class="${cls}"><td>$${veFmt(t)}</td><td>${veFmt2(rate)}</td><td class="${dcls}">${delta > 0 ? '+' : ''}${veFmt2(delta)}</td></tr>`;
    });
    tbl.innerHTML = html;
    note.innerHTML = 'Each $1,000/day of target → <strong>' + veFmt2(1000 * days / (1 - commPct) / intake) + ' $/mt</strong> on the rate.';
  }
}

// ─── Layer 2: live wiring ────────────────────────────────────────────────────

// Populate the vessel picker with OPEN vessels from the tonnage tracker.
function vePopulateVesselPicker() {
  const sel = document.getElementById('ve_vesselPicker');
  if (!sel) return;
  if (typeof vessels === 'undefined' || !Array.isArray(vessels)) {
    sel.innerHTML = '<option value="">No vessels loaded yet</option>';
    return;
  }
  const open = vessels.filter(v => v.status === 'OPEN' && v.vessel_name)
    .sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''));
  let html = '<option value="">— select vessel —</option>';
  open.forEach((v, idx) => {
    const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) + 'K' : '?'}/${v.build_year || '?'}`;
    const route = (typeof getEffectiveRoute === 'function') ? getEffectiveRoute(v) : '';
    html += `<option value="${idx}">${v.vessel_name} (${specs})${route ? ' · ' + route : ''}</option>`;
  });
  sel.innerHTML = html;
  sel._openVessels = open;
}

function veApplyVessel() {
  const sel = document.getElementById('ve_vesselPicker');
  if (!sel) return;
  const idx = parseInt(sel.value, 10);
  if (isNaN(idx)) { vePickerNote(''); return; }
  const v = sel._openVessels && sel._openVessels[idx];
  if (!v) return;

  // DWT → intake. NOTE: DWT is full deadweight; for draft-restricted ECSA loads
  // the realised intake is typically 80-90% of DWT. We seed with DWT and let the
  // user trim — better than guessing a stowage factor.
  if (v.dwt) veEl('intake').value = v.dwt;

  // P6 offer is in $/day, not $/mt — can't seed the rate directly. The market
  // hook below works the other direction (TCE → reference line on the chart).

  // TODO: vessel records don't carry speed/consumption fields today
  //       (see voyageCalc inputs ballCons/ladenCons/ballSpd/ladenSpd/portCons).
  //       Tess-82 defaults stay in place.
  const notes = [];
  notes.push(`Intake seeded from DWT (${veFmt(v.dwt || 0)} mt). Trim if draft-restricted.`);
  const route = (typeof getEffectiveRoute === 'function') ? getEffectiveRoute(v) : null;
  if (route && route.toUpperCase() !== 'ECSA FH') {
    notes.push(`⚠ Vessel route is ${route}, P8 defaults are Santos/Qingdao — review distances.`);
  }
  notes.push('Speed/consumption not on record — Tess-82 defaults in use.');
  vePickerNote(notes.join(' '));

  veRender();
}

// Populate the cargo picker with currently-live cargoes (status OPEN equivalent).
function vePopulateCargoPicker() {
  const sel = document.getElementById('ve_cargoPicker');
  if (!sel) return;
  if (typeof cargoHistory === 'undefined' || typeof cargoCurrent === 'undefined') {
    sel.innerHTML = '<option value="">No cargo book loaded yet</option>';
    return;
  }
  const live = cargoHistory.filter(c => cargoCurrent.includes(c.id) && !c.fixed);
  // Prioritise ECSA Fronthaul (P8) and USG Fronthaul (P7) since engine defaults match those.
  const isP8 = c => (c.stem || '').toLowerCase().includes('ecsa fronthaul');
  const isP7 = c => (c.stem || '').toLowerCase().includes('usg fronthaul');
  live.sort((a, b) => {
    const aPri = isP8(a) ? 0 : isP7(a) ? 1 : 2;
    const bPri = isP8(b) ? 0 : isP7(b) ? 1 : 2;
    if (aPri !== bPri) return aPri - bPri;
    return (a.charterer || '').localeCompare(b.charterer || '');
  });
  let html = '<option value="">— select cargo —</option>';
  live.forEach(c => {
    const label = `${(c.charterer || '?').toUpperCase()} · ${c.stem || 'Unknown'} · ${c.laycan || '?'} · ${c.cargo || ''}`;
    html += `<option value="${c.id}">${label}</option>`;
  });
  sel.innerHTML = html;
}

// Parse a cargo "size" string like "60-55000/10", "pmx/kmx", "80000/10" → MT.
// Returns null if no usable number found.
function veIntakeFromSize(sizeStr) {
  if (!sizeStr) return null;
  // Look for explicit numbers ≥ 40000 first (real tonnage like 60000, 80000)
  const matches = sizeStr.match(/\d{5,6}/g);
  if (matches) {
    const nums = matches.map(Number).filter(n => n >= 40000 && n <= 220000);
    if (nums.length) return Math.min(...nums); // conservative — first/lowest figure
  }
  // Fallback: vessel class abbreviations
  const lc = sizeStr.toLowerCase();
  if (lc.includes('ppmx')) return 85000;
  if (lc.includes('pmx'))  return 75000;
  if (lc.includes('kmx'))  return 82000;
  if (lc.includes('lme'))  return 60000;
  if (lc.includes('smx'))  return 55000;
  return null;
}

function veApplyCargo() {
  const sel = document.getElementById('ve_cargoPicker');
  if (!sel) return;
  const id = sel.value;
  if (!id) { vePickerNote(''); return; }
  const c = (typeof cargoHistory !== 'undefined') ? cargoHistory.find(x => x.id === id) : null;
  if (!c) return;

  const intake = veIntakeFromSize(c.size);
  if (intake) veEl('intake').value = intake;

  // TODO: cargo records don't carry a working bid / rate / P6 equivalent.
  //       If the cargo book later gains a `working_bid` or `target_p6` field,
  //       prefill veEl('rate') or veEl('targetTce') here.
  const notes = [];
  if (intake) notes.push(`Intake set to ${veFmt(intake)} mt (parsed from "${c.size}").`);
  else notes.push(`Couldn't parse intake from "${c.size || 'empty'}" — left unchanged.`);
  const stemLc = (c.stem || '').toLowerCase();
  if (stemLc.includes('usg fronthaul')) notes.push('⚠ Cargo is P7 (USG→N.China); P8 defaults loaded — adjust distances.');
  else if (!stemLc.includes('ecsa fronthaul')) notes.push(`⚠ Cargo stem "${c.stem}" not P8 — review distances/port costs.`);
  notes.push('No rate/working-bid on cargo record — rate input unchanged.');
  vePickerNote(notes.join(' '));

  veRender();
}

function vePickerNote(msg) {
  const el = document.getElementById('ve_pickerNote');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// Seed bunker prices from the existing voyages.js bunkers panel if available.
function veSeedBunkersFromGlobals() {
  if (typeof getBunkers !== 'function') return;
  const b = getBunkers();
  if (b && b.vlsfo && veEl('pxVlsfo') && !veEl('pxVlsfo').dataset.userTouched) {
    veEl('pxVlsfo').value = b.vlsfo;
  }
  if (b && b.lsmgo && veEl('pxMgo') && !veEl('pxMgo').dataset.userTouched) {
    veEl('pxMgo').value = b.lsmgo;
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

function veSeedDefaults() {
  const D = window.VoyageCalc && window.VoyageCalc.P8_TESS82_DEFAULTS;
  if (!D) return;
  const map = {
    intake: D.intake, comm: D.commPct * 100,
    ballDist: D.ballDist, ladenDist: D.ladenDist,
    ballSpd: D.ballSpd, ladenSpd: D.ladenSpd,
    wxMargin: D.wxMarginPct * 100,
    ballCons: D.ballCons, ladenCons: D.ladenCons,
    ballMgo: D.ballMgo, ladenMgo: D.ladenMgo,
    loadDays: D.loadDays, dischDays: D.dischDays,
    idleDays: D.idleDays, portCons: D.portCons,
    pxVlsfo: D.pxVlsfo, pxMgo: D.pxMgo, pxHsfo: D.pxHsfo,
    loadCost: D.loadCost, dischCost: D.dischCost,
    canalCost: D.canalCost, miscCost: D.miscCost,
    rate: 49.50, targetTce: 14000,
  };
  Object.entries(map).forEach(([k, v]) => {
    const el = veEl(k);
    if (el && el.value === '') el.value = v;
  });
}

function veInit() {
  if (VE.initialised) return;
  if (!document.getElementById('ve_intake')) return; // panel not in DOM yet
  if (!window.VoyageCalc) { console.warn('VoyageCalc engine not loaded'); return; }

  veSeedDefaults();
  veSeedBunkersFromGlobals();

  // Mode toggle
  document.getElementById('ve_modeToggle').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    VE.mode = b.dataset.mode;
    [...document.getElementById('ve_modeToggle').children].forEach(x => x.classList.toggle('active', x === b));
    document.getElementById('ve_rateRow').style.display   = VE.mode === 'rate2tce' ? 'flex' : 'none';
    document.getElementById('ve_targetRow').style.display = VE.mode === 'tce2rate' ? 'flex' : 'none';
    document.getElementById('ve_commTermHead').textContent = VE.mode === 'rate2tce' ? 'Freight rate (offer)' : 'Target earnings';
    veRender();
  });

  // Scrubber toggle
  document.getElementById('ve_scrubFitted').addEventListener('change', e => {
    const on = e.target.value === 'yes';
    document.getElementById('ve_hsfoRow').style.display      = on ? 'flex' : 'none';
    document.getElementById('ve_scrubSplitRow').style.display = on ? 'flex' : 'none';
    document.getElementById('ve_seaFuelLbl').textContent = on ? 'HSFO' : 'VLSFO';
    veRender();
  });

  // Scrub split
  document.getElementById('ve_scrubSplit').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    VE.scrubSplit = b.dataset.split;
    [...document.getElementById('ve_scrubSplit').children].forEach(x => x.classList.toggle('active', x === b));
    veRender();
  });

  // All numeric inputs re-render on input
  VE_INPUT_IDS.forEach(id => {
    const el = veEl(id);
    if (el) {
      el.addEventListener('input', () => { el.dataset.userTouched = '1'; veRender(); });
    }
  });

  // Pickers
  document.getElementById('ve_vesselPicker').addEventListener('change', veApplyVessel);
  document.getElementById('ve_cargoPicker').addEventListener('change', veApplyCargo);

  // Copy button
  document.getElementById('ve_copyBtn').addEventListener('click', () => {
    const btn = document.getElementById('ve_copyBtn');
    navigator.clipboard.writeText(btn.dataset.copy || '').then(() => {
      const t = btn.textContent;
      btn.textContent = 'Copied ✓';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = t; btn.classList.remove('done'); }, 1400);
    });
  });

  VE.initialised = true;
  veRender();
}

// Hook into the existing tab switcher (same decorator pattern as voyages.js/report.js)
const _origSwitchTabEstimator = window.switchTab;
window.switchTab = function (tab) {
  if (_origSwitchTabEstimator) _origSwitchTabEstimator(tab);
  if (tab === 'estimator') {
    veInit();
    vePopulateVesselPicker();
    vePopulateCargoPicker();
    veSeedBunkersFromGlobals();
    veRender();
  }
};
