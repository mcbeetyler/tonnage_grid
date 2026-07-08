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
  A(FU.parseLaycanWindow('garbage') === null, 'garbage laycan null');
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

  lm._test.setCustom([{ name: 'NCSA', base: 'Itaqui', offsetNm: -300, regionNm: { WMED: 4400 } }]);
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

// ═══ result ═══════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
