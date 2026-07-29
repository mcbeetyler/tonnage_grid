#!/usr/bin/env node
/* ============================================================
   Test suite — run with `npm test` (or node tests/run-tests.cjs)

   The dashboard modules are classic browser scripts inside a
   "type": "module" package, so we load them by eval'ing their
   source into a stubbed browser-ish global scope rather than
   require()-ing them.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function A(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(name) { console.log('▸ ' + name); }

// ── browser stubs ─────────────────────────────────────────────────────────────
global.window = global;
global.self = global;
global.localStorage = {
  _s: {}, getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; },
};
global.document = {
  addEventListener() {}, getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return { style: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }; },
  head: { appendChild() {} },
};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ rev: 0, vessels: [] }) });

function load(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  module.exports = {};
  // eslint-disable-next-line no-eval
  eval(src);
  return module.exports;
}

// ═══ 1. fit-utils ═════════════════════════════════════════════════════════════
section('fit-utils');
const FU = load('fit-utils.js');
{
  const d = s => new Date(s + 'T00:00:00Z');
  const opts = { waitTolDays: 2, tightTolDays: 2 };
  A(FU.fitStatus(d('2026-07-25'), d('2026-07-24'), new Date('2026-07-29T23:59:59Z'), opts).status === 'FIT', 'in-window FIT');
  A(FU.fitStatus(d('2026-07-23'), d('2026-07-24'), new Date('2026-07-29T23:59:59Z'), opts).status === 'FIT', 'wait 1d still FIT');
  A(FU.fitStatus(d('2026-07-10'), d('2026-07-24'), new Date('2026-07-29T23:59:59Z'), opts).status === 'EARLY', 'long wait EARLY');
  A(FU.fitStatus(d('2026-07-31'), d('2026-07-24'), new Date('2026-07-29T23:59:59Z'), opts).status === 'TIGHT', 'miss by 1d TIGHT');
  A(FU.fitStatus(d('2026-08-10'), d('2026-07-24'), new Date('2026-07-29T23:59:59Z'), opts).status === 'MISSES', 'big miss MISSES');
  A(FU.fitStatus(d('2026-07-25'), null, null, opts).status === 'ETA', 'no laycan = ETA');
  A(FU.fitStatus(null, null, null, opts).status === 'NODATA', 'nothing = NODATA');
  const w = FU.parseLaycanWindow('11Jul-12Jul');
  A(w && w.from.endsWith('-07-11') && w.to.endsWith('-07-12'), 'laycan 11Jul-12Jul');
  A(FU.parseLaycanWindow('01-10 Aug').to.endsWith('-08-10'), 'laycan 01-10 Aug');
  A(FU.parseLaycanWindow('15 Jul').from === FU.parseLaycanWindow('15 Jul').to, 'single-day laycan');
  const onw = FU.parseLaycanWindow('22jul onw');
  A(onw && onw.from.endsWith('-07-22') && onw.to.endsWith('-08-11') && onw.onw, 'onw = 20-day window');
  A(FU.parseLaycanWindow('1 Jul onwards').from.endsWith('-07-01'), 'onwards long form');
  A(FU.parseLaycanWindow('garbage') === null, 'garbage laycan null');
}

// ═══ 1b. zones ════════════════════════════════════════════════════════════════
section('zones');
{
  const Z = load('zones.js');
  A(Z.zoneOfPort('SANTOS') === 'ECSA', 'santos ECSA');
  A(Z.zoneOfPort('LULEA') === 'N CONT', 'lulea N CONT');
  A(Z.zoneOfPort('LIVERPOOL (UK)') === 'N CONT', 'liverpool (UK)');
  A(Z.zoneOfPort('GIBRALTAR') === 'W MED', 'gibraltar W MED');
  A(Z.zoneOfPort('PORT SAID') === 'E MED', 'port said E MED');
  A(Z.zoneOfPort('BALBOA') === 'NCSA', 'balboa NCSA');
  A(Z.zoneOfPort('nola') === 'USG', 'nola USG');
  A(Z.zoneOfPort('Ust Luga') === 'BALTIC', 'ust luga BALTIC');
  A(Z.zoneOfPort('unknownport xyz') === null, 'unknown null');
  A(Z.zoneOfVessel({ dely_port: 'somewhere odd', region: 'EMED' }) === 'E MED', 'sheet-tag alias fallback');
  A(Z.zoneOfVessel({ dely_port: 'Itaqui', region: 'GONE' }) === 'NCSA', 'port beats status tag');
}

// ═══ 2. csv-import + app (parse, sync, merge) ═════════════════════════════════
section('csv-import + app');
{
  const csvSrc = fs.readFileSync(path.join(ROOT, 'csv-import.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const T = '\t';
  const hdr = ['UPDATE', 'VESSEL', 'DWT', 'AGE', 'DRAFT', 'DELY', 'LAYDAY', '"HIRE\n(offer)"', 'ETA', 'OWNER', 'BKI EQVT', 'COMMENTS', 'HIRE TA', 'SCRUB FIT', 'TPC', 'CUBIC', 'TYPE', 'STATUS', 'CARGO'].join(T);
  const r1 = ['08-Jul 10:46', 'Globe Danae', '80,306', ' Jan-2010', '14.47', 'Bin Qasim via CGH', '11-Jul', '$18,250', '10-Aug', 'GLOBE MARINE', '$18,219', 'test note', '', 'FALSE', '70.3', '95,172', 'KMX', '1', ''].join(T);
  const r2 = ['08-Jul 09:14', 'Minorca', '82,157', 'Jul-23', '14.50', 'Hazira via CGH', '13-Jul', '$23,250', '12-Aug', 'NORDEN', '$20,781', '', '$36,500', 'FALSE', '71.7', '98,670', 'KMX', '1', 'GRAIN CLEAN'].join(T);
  const TSV = [hdr, r1, r2].join('\n');

  const testBody = `
    A(parseDwtField('80,306') === 80306, 'dwt comma');
    A(parseDwtField('80.306') === 80306, 'dwt EU dot');
    A(parseDwtField('82') === 82000, 'dwt bare');
    A(parseAgeField(' Jan-2010') === 2010, 'age full');
    A(parseAgeField('Jan-10') === 2010, 'age mmm-yy');
    A(parseAgeField('10-Jan') === 2010, 'age flipped');
    A(parseAgeField('Oct-24') === 2024, 'age Oct-24');
    A(parseAgeField('Jun-98') === 1998, 'age pivot');
    A(parseAgeField('1-Jan') === null, 'age reject 1-digit');
    A(parseLaydayDate('21+ Aug') !== null && parseLaydayDate('21+ Aug').endsWith('-08-21'), "layday '21+ Aug' parses");
    A(parseLaydayDate('21+Aug') !== null && parseLaydayDate('21+Aug').endsWith('-08-21'), "layday '21+Aug' parses");

    // Darya Lachmi scenario: OPEN ship with stale April fixture residue,
    // ETA late Aug, no parseable open_date on the vessel record — the
    // Fixtures tab still lists her April fixture. Must NOT re-fix her.
    vessels.length = 0;
    vessels.push({ vessel_name: 'DARYA LACHMI', status: 'OPEN', eta_ecsa: '2026-08-25' });
    const dlHdr = ['LAST UPDATE', 'VESSEL', 'DWT', 'AGE', 'ETA', 'OWNER', 'BKI EQVT'].join('\\t');
    const dlFx = ['14-Apr 09:00', 'Darya Lachmi', '82,000', 'Jan-2022', '10-May', 'CHELLARAM', '$21,000'].join('\\t');
    markFixturesFromCSV(parseCSVVessels([dlHdr, dlFx].join('\\n')).vessels);
    A(vessels[0].status === 'OPEN', 'months-old fixture does not re-fix a ship with a far ETA');

    // archiveFixtureResidue: manual reopen clears the old fixture into history
    const dl = vessels[0];
    dl.date_fixed = '2026-04-14'; dl.fixed_price = 21000; dl.charterer = 'COFCO';
    A(archiveFixtureResidue(dl) === true, 'residue archived');
    A(dl.date_fixed === null && dl.charterer === null && dl.fixture_history.length === 1
      && dl.fixture_history[0].charterer === 'COFCO', 'fields cleared, history kept');

    // Self-healing sweep: already-OPEN ships wearing months-old fixtures
    // get cleaned on load; recent fixtures and non-OPEN ships untouched
    vessels.length = 0;
    vessels.push({ vessel_name: 'STUCK SHIP', status: 'OPEN', eta_ecsa: '2026-08-25',
      date_fixed: '2026-04-14', fixed_price: 21000, charterer: 'COFCO', route: 'ECSA TA' });
    vessels.push({ vessel_name: 'FRESH FIX', status: 'OPEN', eta_ecsa: '2026-08-25',
      date_fixed: '2026-07-20', fixed_price: 22000, charterer: 'BUNGE' });
    vessels.push({ vessel_name: 'STILL FIXED', status: 'FIXED', eta_ecsa: '2026-08-25',
      date_fixed: '2026-04-01', fixed_price: 20000 });
    // The actual Darya state: ON SUBS since April, ETA late Aug — the select
    // displayed 'OPEN' while the stored status excluded her everywhere
    vessels.push({ vessel_name: 'DARYA REAL', status: 'ON SUBS', eta_ecsa: '2026-08-25',
      date_fixed: '2026-04-14', charterer: 'COFCO' });
    const swept = sweepStaleFixtureResidue();
    A(swept === 2, 'sweep count incl stale ON SUBS: ' + swept);
    const dreal = vessels.find(v => v.vessel_name === 'DARYA REAL');
    A(dreal.status === 'OPEN' && dreal.date_fixed === null && dreal.charterer === null, 'stale ON SUBS reopened + cleaned');
    A(dreal.fixture_history[0].charterer === 'COFCO', 'April subs archived');
    const stuck = vessels[0];
    A(stuck.date_fixed === null && stuck.charterer === null && stuck.route === null, 'stuck ship cleaned incl route');
    A(stuck.fixture_history[0].route === 'ECSA TA', 'old route archived');
    A(vessels[1].date_fixed === '2026-07-20', 'recent fixture residue untouched (could be sheet lag)');
    A(vessels[2].status === 'FIXED' && vessels[2].date_fixed === '2026-04-01', 'FIXED ships never swept');
    A(parseAgeField('2010-01-01 00:00') === 2010, 'age iso');
    A(looksLikeCSV(TSV), 'looksLikeCSV');
    const { vessels: parsed } = parseCSVVessels(TSV);
    A(parsed.length === 2, 'row count');
    const g = parsed[0];
    A(g.dwt === 80306 && g.build_year === 2010, 'globe dwt/yr');
    A(g.hire_offer === 18250 && g.bki_eqvt === 18219, 'globe rates');
    A(g.eta_ecsa && g.eta_ecsa.endsWith('-08-10'), 'globe eta');
    A(g.specs.tpc === 70.3 && g.specs.cubic === 95172, 'globe specs');
    A(parsed[1].hire_ta === 36500 && parsed[1].last_cargo === 'GRAIN CLEAN', 'minorca extras');
    A(parsed[1].build_year === 2023, 'minorca 2-digit newbuild year');

    vessels.length = 0;
    vessels.push({
      vessel_name: 'GLOBE DANAE', status: 'OPEN', dwt: 1, build_year: 1,
      market_colour: [{ route: 'ECSA FH', bid_usd: 17000, p6_bid: 17000, offer_usd: null, p6_offer: null }],
      field_overrides: { notes: '2099-01-01T00:00:00Z' }, notes: 'MANUAL',
    });
    vessels.push({ vessel_name: 'GHOST', status: 'OPEN' });
    vessels.push({ vessel_name: 'DONE DEAL', status: 'FIXED' });
    const r = syncCSVVessels(parsed);
    A(r.added === 1 && r.updated === 1, 'sync add/update counts');
    const s = vessels.find(v => v.vessel_name === 'GLOBE DANAE');
    A(s.dwt === 80306, 'csv wins dwt');
    A(s.notes === 'MANUAL', 'newer manual override wins');
    A(s.market_colour[0].p6_bid === 17000, 'bid side preserved');
    A(s.market_colour[0].offer_usd === 18250, 'offer side updated');
    A(s.offer_history.length === 1, 'offer history pushed');
    A(vessels.find(v => v.vessel_name === 'DONE DEAL').status === 'FIXED', 'fixed never resurrected');
    A(r.withdrawCandidates.length === 1 && r.withdrawCandidates[0].name === 'GHOST', 'withdraw candidates');

    s.field_overrides = { owner: '2026-07-01T00:00:00Z' };
    s.owner = 'STALE MANUAL';
    syncCSVVessels(parseCSVVessels(TSV).vessels);
    A(s.owner === 'GLOBE MARINE', 'fresher csv reclaims stale override');

    // Feed sends whole tabs — header row may sit below decorative rows
    const junky = ['\\tFILTERING & SO\\t\\t', '\\tSantos/Qingdao\\t2026\\t', TSV].join('\\n');
    A(looksLikeCSV(junky), 'header found below junk rows');
    A(parseCSVVessels(junky).vessels.length === 2, 'parse with junk rows above header');

    // Feed auto-withdrawal: sheet-managed ships missing from the CSV get
    // withdrawn; manual ships stay candidates only
    vessels.length = 0;
    vessels.push({ vessel_name: 'SHEET SHIP', status: 'OPEN', csv_updated: '2026-07-08T08:00:00Z' });
    vessels.push({ vessel_name: 'WHATSAPP SHIP', status: 'OPEN' });
    vessels.push({ vessel_name: 'FIXED SHEET SHIP', status: 'FIXED', csv_updated: '2026-07-08T08:00:00Z' });
    const wr = syncCSVVessels(parseCSVVessels(TSV).vessels, { autoWithdraw: true });
    A(vessels.find(v => v.vessel_name === 'SHEET SHIP').status === 'WITHDRAWN', 'sheet-managed auto-withdrawn');
    A(vessels.find(v => v.vessel_name === 'WHATSAPP SHIP').status === 'OPEN', 'manual ship untouched');
    A(vessels.find(v => v.vessel_name === 'FIXED SHEET SHIP').status === 'FIXED', 'fixed never auto-touched');
    A(wr.autoWithdrawn === 1 && wr.withdrawCandidates.length === 1, 'counts: 1 auto, 1 candidate');

    // Fixtures feed: board ships matching the Fixtures tab go FIXED;
    // unknown fixtures don't create rows; manual judgments stand
    const fxHdr = ['LAST UPDATE', 'VESSEL', 'DWT', 'AGE', 'DELY', 'HIRE (offer)', 'ETA', 'OWNER', 'BKI EQVT', 'FIX MSG', 'COMMENTS'].join('\\t');
    const fxRow = ['29-Jun 09:54', 'Minoan Bay', '92,759', 'Jan-2012', 'Port Louis via CGH', '$20,000', '18-Jul', 'MODION', '$26,886', '', '20k +600gbb bss port louis'].join('\\t');
    const fxRow2 = ['06-Jul 07:12', 'Pegasus', '81,852', 'Jan-2012', 'Singapore via CGH', '$22,000', '27-Jul', 'DALNAVE', '$22,597', '', '22K FOR ECSA FH'].join('\\t');
    vessels.length = 0;
    vessels.push({ vessel_name: 'MINOAN BAY', status: 'OPEN', csv_updated: '2026-06-01T00:00:00Z' });
    vessels.push({ vessel_name: 'PEGASUS', status: 'FAILED' });  // desk marked failed — stands
    const fxParsed = parseCSVVessels([fxHdr, fxRow, fxRow2].join('\\n')).vessels;
    A(fxParsed.length === 2 && fxParsed[0].fix_msg === null, 'fixtures rows parse');
    const fr = markFixturesFromCSV(fxParsed);
    const mb = vessels.find(v => v.vessel_name === 'MINOAN BAY');
    A(mb.status === 'FIXED' && mb.fixed_price === 26886, 'board ship marked FIXED w/ BKI price');
    A(mb.date_fixed && mb.date_fixed.endsWith('-06-29'), 'fix date from LAST UPDATE');
    A(mb.fix_msg && /600gbb/.test(mb.fix_msg), 'fixture story captured');
    A(vessels.find(v => v.vessel_name === 'PEGASUS').status === 'FAILED', 'FAILED never overridden');
    A(vessels.length === 2 && fr.marked === 1 && fr.unmatched === 0, 'no new rows created; counts right');

    // Reopen cycle: fixed ship reappears with a clearly-later layday
    const roHdr = ['UPDATE', 'VESSEL', 'DWT', 'AGE', 'LAYDAY', 'ETA', 'OWNER', 'STATUS'].join('\\t');
    const roRow = ['08-Jul 10:00', 'Pacific Runner', '82,000', 'Jan-2018', '05-Sep', '03-Oct', 'OWNERCO', '1'].join('\\t');
    const roLag = ['08-Jul 10:00', 'Just Fixed', '82,000', 'Jan-2018', '12-Jul', '10-Aug', 'OWNERCO', '1'].join('\\t');
    vessels.length = 0;
    vessels.push({ vessel_name: 'PACIFIC RUNNER', status: 'FIXED', date_fixed: '2026-05-01', fixed_price: 21000, charterer: 'KOCH', csv_updated: '2026-05-01T00:00:00Z' });
    vessels.push({ vessel_name: 'JUST FIXED', status: 'FIXED', date_fixed: '2026-07-06', fixed_price: 22000, csv_updated: '2026-07-06T00:00:00Z' });
    const ro = syncCSVVessels(parseCSVVessels([roHdr, roRow, roLag].join('\\n')).vessels);
    const pr2 = vessels.find(v => v.vessel_name === 'PACIFIC RUNNER');
    A(pr2.status === 'OPEN' && ro.reopened === 1, 'reopened: layday 4 months after fixture');
    A(pr2.fixture_history.length === 1 && pr2.fixture_history[0].fixed_price === 21000 && pr2.fixture_history[0].charterer === 'KOCH', 'old fixture archived');
    A(pr2.fixed_price === null && pr2.charterer === null, 'fixture fields cleared for the new position');
    A(vessels.find(v => v.vessel_name === 'JUST FIXED').status === 'FIXED', 'sheet lag (6d gap) does NOT reopen');

    // Stale-fixture guard: her OLD fixture in the tab history must not re-fix her
    const roFx = ['29-Apr 09:00', 'Pacific Runner', '82,000', 'Jan-2018', '', '', 'OWNERCO', ''].join('\\t');
    const roFxHdr = ['LAST UPDATE', 'VESSEL', 'DWT', 'AGE', 'LAYDAY', 'ETA', 'OWNER', 'STATUS'].join('\\t');
    markFixturesFromCSV(parseCSVVessels([roFxHdr, roFx].join('\\n')).vessels);
    A(pr2.status === 'OPEN', 'old fixture (pre-reopen) does not re-fix her');
    // ...but a genuinely fresh fixture after the new opening does
    pr2.open_date = '2026-07-01';
    const freshFx = ['10-Jul 09:00', 'Pacific Runner', '82,000', 'Jan-2018', '', '', 'OWNERCO', ''].join('\\t');
    markFixturesFromCSV(parseCSVVessels([roFxHdr, freshFx].join('\\n')).vessels);
    A(pr2.status === 'FIXED', 'fresh fixture after reopening marks her again');

    // Manually-fixed ship: user's values stand, blanks get backfilled
    vessels.length = 0;
    vessels.push({ vessel_name: 'MINOAN BAY', status: 'FIXED', fixed_price: 27500, date_fixed: null, fix_msg: null });
    markFixturesFromCSV(parseCSVVessels([fxHdr, fxRow].join('\\n')).vessels);
    const mf = vessels[0];
    A(mf.fixed_price === 27500, 'manual fixed price never overwritten');
    A(mf.date_fixed && mf.date_fixed.endsWith('-06-29'), 'blank date backfilled from sheet');
    A(mf.fix_msg && /600gbb/.test(mf.fix_msg), 'blank fix msg backfilled');

    const merged = mergeVesselArrays(
      [{ vessel_name: 'A', last_updated: '2026-07-08T10:00:00Z', dwt: 1 }, { vessel_name: 'B', last_updated: '2026-07-08T09:00:00Z', dwt: 2 }],
      [{ vessel_name: 'B', last_updated: '2026-07-08T11:00:00Z', dwt: 3 }, { vessel_name: 'C', dwt: 4 }]);
    A(merged.length === 3, 'merge union');
    A(merged.find(v => v.vessel_name === 'B').dwt === 3, 'merge newer wins');
  `;
  global.TSV = TSV;
  // eslint-disable-next-line no-eval
  eval(csvSrc + '\n' + appSrc.replace(/\ninit\(\);\s*$/, '\n') + '\n;(function(){' + testBody + '})();');
}

// ═══ 2b. demand depth (cargo.js) ══════════════════════════════════════════════
section('demand depth');
{
  const cargoSrc = fs.readFileSync(path.join(ROOT, 'cargo.js'), 'utf8');
  const iso = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const testBody = `
    cargoHistory = [
      // KOCH: showed 2 in-window
      { charterer: 'Koch', stem: 'ECSA Fronthaul', load: 'santos', entered_market: '${'${A20}'}' },
      { charterer: 'koch', stem: 'ECSA TA', load: 'santos', entered_market: '${'${A10}'}' },
      // BUNGE re-quote: departed then re-entered 3d later
      { charterer: 'bunge', stem: 'NCSA TA', load: 'ncsa', entered_market: '${'${A30}'}', departed_at: '${'${A15}'}' },
      { charterer: 'bunge', stem: 'NCSA TA', load: 'ncsa', entered_market: '${'${A12}'}' },
      // stale (outside window)
      { charterer: 'Koch', stem: 'ECSA Fronthaul', load: 'itaqui', entered_market: '2025-01-01' },
    ];
    cargoCurrent = [];
    vessels.length = 0;
    // KOCH fixed 5 (2 live FIXED + 3 archived) vs 2 shown → dark 3, mult 2.5
    vessels.push({ vessel_name: 'A', status: 'FIXED', charterer: 'KOCH', date_fixed: '${'${A5}'}' });
    vessels.push({ vessel_name: 'B', status: 'FIXED', charterer: 'Koch Shipping', date_fixed: '${'${A8}'}' });
    vessels.push({ vessel_name: 'C', status: 'OPEN', fixture_history: [
      { charterer: 'KOCH', date_fixed: '${'${A18}'}' }, { charterer: 'KOCH', date_fixed: '${'${A25}'}' }, { charterer: 'KOCH', date_fixed: '${'${A40}'}' } ] });
    // CARGILL: dark bidder — never quoted, bids on an open ship
    vessels.push({ vessel_name: 'D', status: 'OPEN', bids: [{ charterer: 'Cargill', p6_bid: 19000 }] });
    global.getAllBids = v => v.bids || [];
    const depth = computeDemandDepth(56);
    const koch = depth.find(r => r.key === 'KOCH');
    A(koch && koch.shown === 2 && koch.fixed === 5, 'koch shown/fixed incl aliases + archive: ' + JSON.stringify(koch));
    A(koch.dark === 3 && Math.abs(koch.mult - 2.5) < 1e-9, 'koch dark 3, mult 2.5');
    const bunge = depth.find(r => r.key === 'BUNGE');
    A(bunge && bunge.requotes === 1, 'bunge re-quote detected');
    const cargill = depth.find(r => r.key === 'CARGILL');
    A(cargill && cargill.shown === 0 && cargill.bids === 1, 'cargill dark bidder');

    // Demand pulse: reconstructed daily live counts
    cargoCurrent = ['live1'];
    cargoHistory = [
      { id: 'old', charterer: 'x', entered_market: '${'${A10}'}', departed_at: '${'${A3}'}' },
      { id: 'live1', charterer: 'x', entered_market: '${'${A5}'}' },
      { id: 'ancient', charterer: 'x', entered_market: '${'${A80}'}', departed_at: '${'${A70}'}' },
    ];
    const pulse = computeDemandPulse(cargoHistory, 84);
    A(pulse.today === 1, 'pulse today: only the live cargo');

    // Re-touched cargo = several history entries for ONE physical cargo —
    // must count once (id includes the sheet's updated stamp)
    cargoCurrent = ['v2'];
    cargoHistory = [
      { id: 'v1', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '1-10aug', entered_market: '${'${A9}'}', departed_at: '${'${A4}'}', fixed: true },
      { id: 'v2', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '1-10aug', entered_market: '${'${A4}'}' },
    ];
    const dedup = computeDemandPulse(cargoHistory, 84);
    A(dedup.today === 1, 'retouched cargo counts once today');
    A(dedup.days[dedup.days.length - 7].live === 1, 'and once historically: ' + dedup.days[dedup.days.length - 7].live);

    // Chain merge: retouch that ALSO changed the laycan text still merges
    cargoCurrent = ['w2'];
    cargoHistory = [
      { id: 'w1', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '20-28aug', entered_market: '${'${A9}'}', departed_at: '${'${A4}'}', fixed: true },
      { id: 'w2', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '22-28aug', entered_market: '${'${A4}'}' },
    ];
    const chain = computeDemandPulse(cargoHistory, 84);
    A(chain.today === 1 && chain.days[chain.days.length - 7].live === 1, 'laycan-shifted retouch chains into one cargo');

    // Parallel liftings (overlapping for days) do NOT merge
    cargoCurrent = ['p1', 'p2'];
    cargoHistory = [
      { id: 'p1', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '1-10sep', entered_market: '${'${A10}'}' },
      { id: 'p2', charterer: 'koch', stem: 'ECSA Fronthaul', load: 'santos', laycan: '15-25sep', entered_market: '${'${A8}'}' },
    ];
    A(computeDemandPulse(cargoHistory, 84).today === 2, 'parallel liftings stay two cargoes');

    // Departure day exclusive: cargo that left today is not live today
    cargoCurrent = [];
    cargoHistory = [
      { id: 'q', charterer: 'x', stem: 'USG TA', load: 'nola', laycan: '5-10aug', entered_market: '${'${A6}'}', departed_at: '${'${A0}'}' },
    ];
    A(computeDemandPulse(cargoHistory, 84).today === 0, 'departed-today not counted today');
    const d4 = pulse.days[pulse.days.length - 5];   // 4 days ago: old + live1 both live
    A(d4.live === 2, 'pulse 4 days ago both live: ' + d4.live);
    A(pulse.days.length === 84 && pulse.avg28 > 0 && pulse.index != null, 'pulse series + index');
    A(pulse.dd === 0 && typeof pulse.ww === 'number', 'pulse deltas');
  `.replace(/\$\{A(\d+)\}/g, (_, d) => iso(parseInt(d, 10)));
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(ROOT, 'csv-import.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n') + '\n'
    + cargoSrc + '\n;(function(){' + testBody + '})();');
}

// ═══ 3. laycan-matcher ════════════════════════════════════════════════════════
section('laycan-matcher');
{
  const lm = load('laycan-matcher.js');
  // parseArrays with feed-shaped rows (ISO date strings, as JSON delivers them)
  const mvHdr = new Array(80).fill('');
  const mkRow = () => new Array(80).fill('');
  const v1 = mkRow();
  v1[4] = 'Test Ship'; v1[5] = '82,000/2020'; v1[6] = 'Gibraltar'; v1[8] = 'OWNER X';
  v1[12] = '2026-07-15T00:00:00.000Z'; v1[13] = '2026-07-16T00:00:00.000Z';
  v1[17] = 'WMED'; v1[19] = 82000; v1[21] = 2020; v1[48] = 14;
  const dHdr2 = new Array(40).fill('');
  dHdr2[1] = 'DELY PORT'; dHdr2[2] = 'Santos'; dHdr2[4] = 'Itaqui'; dHdr2[12] = 'Rouen';
  const dRow = new Array(40).fill('');
  dRow[0] = 'WMED'; dRow[1] = 'Gibraltar'; dRow[2] = 4397; dRow[4] = 3206; dRow[12] = 1282;
  // coverage filter needs >= 20 rows per port — replicate the dely row
  const drows = [new Array(40).fill(''), dHdr2];
  for (let i = 0; i < 25; i++) {
    const r = dRow.slice(); r[1] = i === 0 ? 'Gibraltar' : 'port' + i;
    drows.push(r);
  }
  const data = lm._test.parseArrays([mvHdr, v1], drows, 'test feed');
  A(data.vessels.length === 1, 'feed vessel parsed');
  A(data.vessels[0].lay === '2026-07-15', 'ISO date string handled');
  A(data.distances['gibraltar'] && data.distances['gibraltar']['Itaqui'] === 3206, 'feed distances');
  A(data.ports.includes('Itaqui') && data.ports.includes('Rouen'), 'ports kept');

  lm._test.setData(data);
  lm._test.setUi({ port: 'Itaqui', layFrom: '', layTo: '', includeGone: true, clampToday: false, seaMarginPct: 8, fixedSpeed: '', waitTolDays: 2, tolDays: 2, grainOnly: false, scrubOnly: false, fhOnly: false, minDwt: '', maxDwt: '', maxAge: '', search: '', extraDays: 0, sortKey: 'fit', sortDir: 1 });
  const rows = lm._test.computeRows();
  const expDays = 3206 / 14 / 24 * 1.08;
  A(Math.abs(rows[0].ballastDays - expDays) < 1e-9, 'ETA formula dist/spd/24*1.08');
  A(rows[0].eta.toISOString().slice(0, 10) === new Date(Date.UTC(2026, 6, 15) + expDays * 86400000).toISOString().slice(0, 10), 'ETA date');
  A(lm._test.parseNmInput('9.5d') === Math.round(9.5 * 24 * 13), 'NM input days form');
  A(lm._test.parseNmInput('4,600') === 4600, 'NM input comma');

  // Custom-area constants are keyed on canonical zones (zones.js): the test
  // ship opens Gibraltar → zone 'W MED' (derived from the port itself)
  // Zone-median fallback: unknown dely port borrows from same-zone matrix ports
  const estRows = [new Array(40).fill(''), dHdr2];
  const wmPorts = ['Gibraltar', 'Ceuta', 'Safi', 'Jorf Lasfar'];
  wmPorts.forEach((p, i) => { const r = dRow.slice(); r[1] = p; r[4] = 3100 + i * 100; estRows.push(r); });
  for (let i = 0; i < 22; i++) { const r = dRow.slice(); r[1] = 'filler' + i; r[4] = 5000; estRows.push(r); }
  const vUnknown = v1.slice(); vUnknown[4] = 'Mystery Ship'; vUnknown[6] = 'Tangier'; vUnknown[17] = 'WMED';
  // Tangier is in zones (W MED) but NOT in this matrix — median of Gib/Ceuta/Safi/Jorf = between 3200 and 3300
  const estData = lm._test.parseArrays([mvHdr, vUnknown], estRows, 'test');
  lm._test.setData(estData);
  lm._test.setCustom([]);
  lm._test.setUi({ port: 'Itaqui', layFrom: '', layTo: '', regionFilter: 'ALL', tierFilter: 'ALL' });
  const er = lm._test.computeRows();
  A(er[0].distSrc === 'zoneest' && er[0].dist >= 3200 && er[0].dist <= 3300, 'zone-median estimate applied: ' + er[0].dist);
  A(er[0].status !== 'NODATA' && er[0].eta != null, 'estimated ship flows into tiers');
  A(er[0].estN === 4 && er[0].estZone === 'W MED', 'estimate metadata');
  lm._test.setData(data);

  // Offer columns located by header name, even when the layout drifts,
  // and money strings parse ("$24,000" / "24,000")
  const shiftHdr = new Array(84).fill('');
  shiftHdr[75] = 'Rate TA'; shiftHdr[76] = 'BB TA'; shiftHdr[77] = 'Rate FH'; shiftHdr[78] = 'BB FH';
  const vShift = v1.slice(0, 80).concat(new Array(4).fill(''));
  vShift[75] = '$24,000'; vShift[76] = '350,000'; vShift[77] = 29500; vShift[78] = '';
  const shiftData = lm._test.parseArrays([shiftHdr, vShift], drows, 'test');
  A(shiftData.vessels[0].rate_ta === 24000, 'Rate TA by header name + $ string: ' + shiftData.vessels[0].rate_ta);
  A(shiftData.vessels[0].bb_ta === 350000, 'BB TA comma string');
  A(shiftData.vessels[0].rate_fh === 29500, 'Rate FH numeric');
  A(shiftData.vessels[0].bb_fh === null, 'empty BB null');

  // Desk corrections: PDM ≡ Itaqui alias; Cristobal→Itaqui desk constant
  const vPdm = v1.slice(); vPdm[4] = 'Pdm Ship'; vPdm[6] = 'PDM';
  const vCri = v1.slice(); vCri[4] = 'Canal Ship'; vCri[6] = 'Cristobal'; vCri[48] = 13;
  const dItaqui = dRow.slice(); dItaqui[1] = 'Itaqui'; dItaqui[2] = 4400; dItaqui[4] = 1;
  const deskData = lm._test.parseArrays([mvHdr, vPdm, vCri], [new Array(40).fill(''), dHdr2, dItaqui].concat(drows.slice(2)), 'test');
  lm._test.setData(deskData);
  lm._test.setUi({ port: 'Santos', regionFilter: 'ALL', tierFilter: 'ALL' });
  const dr1 = lm._test.computeRows().find(r => r.v.name === 'Pdm Ship');
  A(dr1.dist === 4400 && dr1.distSrc === 'matrix', 'PDM aliased to Itaqui matrix row');
  lm._test.setUi({ port: 'Itaqui' });
  const dr2 = lm._test.computeRows().find(r => r.v.name === 'Canal Ship');
  A(dr2.dist === 2600, 'Cristobal desk constant used: ' + dr2.dist);
  A(Math.abs(dr2.ballastDays - (2600 / 13 / 24 * 1.08)) < 1e-9 && Math.abs(dr2.ballastDays - 9) < 0.05, 'shows ~9.0d at 13kn');
  lm._test.setData(data);

  lm._test.setCustom([{ name: 'NCSA', base: 'Itaqui', offsetNm: -300, regionNm: { 'W MED': 4400 } }]);
  lm._test.setUi({ port: 'custom:NCSA' });
  const cr = lm._test.computeRows();
  A(cr[0].dist === 4400 && cr[0].distSrc === 'zone', 'custom area zone constant');
}

// ═══ 4. pairings ══════════════════════════════════════════════════════════════
section('pairings');
{
  const p = load('pairings.js');
  const mkShip = (name, eta, p6o) => ({ vessel_name: name, status: 'OPEN', dwt: 81000, build_year: 2019, delivery_basis: 'X', eta_ecsa: eta, market_colour: [{ p6_offer: p6o, p6_bid: null }] });
  p._test.setGlobals({
    vessels: [mkShip('CHEAP', '2026-07-25', 15000), mkShip('DEAR', '2026-07-24', 17000), mkShip('LATE', '2026-08-15', 13000)],
    cargoHistory: [{ id: 'c1', charterer: 'Koch', stem: 'ECSA Fronthaul', load: 'Santos', laycan: '24Jul-29Jul', fixed: false }],
    cargoCurrent: ['c1'],
  });
  p._test.setUi({ mode: 'cargo2ship', cargoId: 'c1', waitTolDays: 2, tightTolDays: 2, etaAdjDays: 0, ecsaOnly: true, showAll: true });
  const r = p._test.computeCargo2Ship();
  A(r.rows[0].v.vessel_name === 'CHEAP' && r.rows[1].v.vessel_name === 'DEAR', 'tier then price order');
  A(r.rows[2].status === 'MISSES', 'late ship misses');
  A(p._test.isEcsa({ stem: 'ECSA Fronthaul', load: '' }) && !p._test.isEcsa({ stem: 'USG Fronthaul', load: 'Nola' }), 'ecsa detector');

  // Load-basis adjustment: Santos-basis ETA corrected for the actual load
  A(p._test.loadBasisAdj({ load: 'santos' }).days === 0, 'santos basis 0');
  A(p._test.loadBasisAdj({ load: 'itaqui' }).days === 2, 'n brazil +2');
  A(p._test.loadBasisAdj({ load: 'pdm' }).days === 6.5 && p._test.loadBasisAdj({ load: 'puerto drummond' }).days === 6.5, 'caribbean +6.5 incl pdm shorthand');
  A(p._test.loadBasisAdj({ load: 'ncsa (int amazon)' }).days === 5.5, 'ncsa zone token fallback');
  A(p._test.loadBasisAdj({ load: 'rotterdam' }).days === null, 'out-of-reach load warns');
  // FIT flips when basis applied: cargo laycan tight against unadjusted ETA
  p._test.setGlobals({
    vessels: [mkShip('EDGE CASE', '2026-07-27', 15000)],
    cargoHistory: [{ id: 'c9', charterer: 'X', stem: 'NCSA Fronthaul', load: 'puerto drummond', laycan: '24Jul-29Jul', fixed: false }],
    cargoCurrent: ['c9'],
  });
  p._test.setUi({ mode: 'cargo2ship', cargoId: 'c9', autoBasis: true, etaAdjDays: 0 });
  A(p._test.computeCargo2Ship().rows[0].status !== 'FIT', 'basis adj pushes 27Jul+6.5d past 29Jul cancelling');
  p._test.setUi({ autoBasis: false });
  A(p._test.computeCargo2Ship().rows[0].status === 'FIT', 'without adj it would (misleadingly) fit');

  // Manual window + DWT range, no cargo attached
  p._test.setGlobals({
    vessels: [
      { vessel_name: 'IN WINDOW', status: 'OPEN', dwt: 82000, eta_ecsa: '2026-08-10', market_colour: [{}] },
      { vessel_name: 'OUT WINDOW', status: 'OPEN', dwt: 82000, eta_ecsa: '2026-09-20', market_colour: [{}] },
      { vessel_name: 'TOO SMALL', status: 'OPEN', dwt: 63000, eta_ecsa: '2026-08-11', market_colour: [{}] },
    ],
    cargoHistory: [], cargoCurrent: [],
  });
  p._test.setUi({ mode: 'cargo2ship', cargoId: '', manFrom: '2026-08-05', manTo: '2026-08-15', minDwt: '75000', maxDwt: '90000', autoBasis: true, etaAdjDays: 0 });
  const mw = p._test.computeCargo2Ship();
  A(mw.window && mw.window.manual, 'manual window active without cargo');
  A(mw.rows.length === 2, 'dwt filter drops the 63k');
  A(mw.rows.find(r => r.v.vessel_name === 'IN WINDOW').status === 'FIT', 'in-window FIT');
  A(mw.rows.find(r => r.v.vessel_name === 'OUT WINDOW').status === 'MISSES', 'out-window MISSES');
  p._test.setUi({ manFrom: '', manTo: '', minDwt: '', maxDwt: '' });
}

// ═══ 5. supply + feeds ════════════════════════════════════════════════════════
section('supply + feeds');
{
  const sp = load('supply.js');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = d => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
  sp._test.setVessels([
    { vessel_name: 'A', status: 'OPEN', dwt: 81000, bki_eqvt: 19000, hire_offer: 19500, eta_ecsa: iso(5) },
    { vessel_name: 'B', status: 'OPEN', dwt: 81000, arrow_eqvt: 18000, eta_ecsa: iso(15) },
    { vessel_name: 'C', status: 'FIXED', dwt: 81000, bki_eqvt: 10000, eta_ecsa: iso(5) },
  ]);
  sp._test.setUi({ includeUnrated: true, layFrom: '', layTo: '', etaFrom: '', etaTo: '', minDwt: '', maxDwt: '', scrubOnly: false, search: '', p6Ref: '' });
  const r = sp._test.computeSupply();
  A(r.ships.length === 2, 'fixed excluded');
  A(r.buckets.b0_10 === 1 && r.buckets.b10_20 === 1 && r.buckets.next30 === 2, 'buckets');
  A(r.ratedBuckets.b0_10 === 1 && r.ratedBuckets.b10_20 === 0, 'rated buckets');
  A(r.ladder[0].rate === 18000 && !r.ladder[0].rated, 'ladder implied first (cheaper)');
  const fd = load('feeds.js');
  A(fd._test.rowsToTsv([['a', 'b'], ['c\td', null]]) === 'a\tb\nc d\t', 'rowsToTsv');
  // Header cells with embedded newlines ("HIRE\n(offer)") must not split rows
  A(fd._test.rowsToTsv([['HIRE\n(offer)', 'x']]) === 'HIRE (offer)\tx', 'rowsToTsv flattens newlines');
}

// ═══ 6. scrubber calc ═════════════════════════════════════════════════════════
section('scrubber calc');
{
  const sc = load('scrubber-calc.js');
  // Hand-checked case: 10d ballast at sea only (dist 3360nm @ 14kn, 0% margin),
  // Zhen May figures, HSFO 453 / VLSFO 647 / MGO 925
  const r = sc.computeScrubber({
    ballastDist: 3360, ballastKn: 14, ballastMe: 25,
    ladenDist: 0, ladenKn: 0, ladenMe: 28,
    geBase: 2.5, geScrub: 3.25, mdoSea: 0.1,
    portIdleDays: 0, portIdleCons: 4.5, portWorkDays: 0, portWorkCons: 6,
    seaMarginPct: 0, ecaPct: 0,
    pxHSFO: 453, pxVLSFO: 647, pxMGO: 925, hire: 20000, split: 'chtr',
  });
  A(Math.abs(r.daysB - 10) < 1e-9, 'ballast days 10');
  // scrub: 10 × 28.25 = 282.5t HSFO = $127,972.5 (+1t MGO $925)
  // comp:  10 × 27.5  = 275t VLSFO = $177,925  (+1t MGO $925)
  A(Math.abs(r.scrubCost - (282.5 * 453 + 1 * 925)) < 1e-6, 'scrub cost');
  A(Math.abs(r.compCost - (275 * 647 + 1 * 925)) < 1e-6, 'comp cost');
  A(Math.abs(r.benefitTotal - (275 * 647 - 282.5 * 453)) < 1e-6, 'benefit total');
  A(Math.abs(r.benefitPerDay - r.benefitTotal / 10) < 1e-6, 'benefit per day');
  // naive: spread 194 × 275t all-in compliant = $53,350 → 5,335/day; always
  // overstates the true number by extraTonnes × HSFO (7.5t × 453 = $3,397.5)
  A(Math.abs(r.naivePerDay - 5335) < 1e-6, 'naive per day 5335');
  A(r.naivePerDay > r.benefitPerDay, 'naive overstates');
  A(Math.abs(r.parasiticPenaltyPerDay - 7.5 * 453 / 10) < 1e-6, 'overstatement = parasitic × HSFO');
  A(Math.abs(r.effectiveHire - (20000 - r.benefitPerDay)) < 1e-6, 'chtr account hire equivalence');
  // ECA share washes out sea benefit: 100% ECA → benefit only from... no port, so ≈0
  const r2 = sc.computeScrubber({ ...{
    ballastDist: 3360, ballastKn: 14, ballastMe: 25,
    ladenDist: 0, ladenKn: 0, ladenMe: 28,
    geBase: 2.5, geScrub: 3.25, mdoSea: 0.1,
    portIdleDays: 0, portIdleCons: 4.5, portWorkDays: 0, portWorkCons: 6,
    seaMarginPct: 0, pxHSFO: 453, pxVLSFO: 647, pxMGO: 925, hire: 20000, split: 'chtr',
  }, ecaPct: 100 });
  A(Math.abs(r2.benefitTotal) < 1e-6, 'full-ECA voyage: no benefit');
  // port-only: benefit = tonnes × spread exactly
  const r3 = sc.computeScrubber({
    ballastDist: 0, ballastKn: 0, ballastMe: 0, ladenDist: 0, ladenKn: 0, ladenMe: 0,
    geBase: 2.5, geScrub: 3.25, mdoSea: 0, portIdleDays: 2, portIdleCons: 4.5,
    portWorkDays: 8, portWorkCons: 6, seaMarginPct: 0, ecaPct: 0,
    pxHSFO: 453, pxVLSFO: 647, pxMGO: 925, hire: 0, split: 'owner',
  });
  A(Math.abs(r3.benefitTotal - 57 * 194) < 1e-6, 'port benefit = tonnes × spread');
}

// ═══ result ═══════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
