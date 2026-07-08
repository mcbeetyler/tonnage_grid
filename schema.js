/* ============================================================
   schema.js — data shapes (documentation only; not loaded by
   dashboard.html). Restored after the file was accidentally
   overwritten with README content.
   ============================================================ */

/**
 * A vessel on the Tonnage Board. Sources: WhatsApp parser (parser.js /
 * api/parse.js), CSV grid sync (csv-import.js), or manual entry.
 *
 * @typedef {Object} Vessel
 * @property {string}  vessel_name
 * @property {number|null} dwt              — deadweight in mt (e.g. 81708)
 * @property {number|null} build_year
 * @property {number|null} draft
 * @property {string|null} yard
 * @property {string|null} origin           — build country (KR/CN/JP/...)
 * @property {string|null} delivery_basis   — e.g. "SINGAPORE VIA CGH"
 * @property {string|null} open_date        — ISO date; layday / open from
 * @property {string|null} laycan_date      — raw layday text from CSV
 * @property {string|null} eta_ecsa         — ISO date; ETA to ECSA load area
 * @property {string|null} eta_type         — 'EXACT' | 'ONW' (may slip later)
 * @property {string|null} owner
 * @property {number|null} hire_offer       — raw TC offer $/day
 * @property {number|null} bb_offer         — ballast bonus offer (lump sum)
 * @property {number|null} hire_ta          — transatlantic offer, if quoted
 * @property {number|null} bki_eqvt         — offer normalised to BKI/P6 $/day
 * @property {number|null} rate_pmt         — freight equivalent $/mt
 * @property {number|null} arrow_eqvt       — Arrow's implied rate (no offer needed)
 * @property {boolean|null} scrubber
 * @property {boolean|null} scrub_chart_acc — scrubber benefit to charterer's acct
 * @property {string|null} vessel_type      — KMX | PMX | PPMX | 87DWT
 * @property {string|null} last_cargo       — GRAIN CLEAN / COAL / X DD ...
 * @property {string|null} bunker           — BOD "IFO/MDO" text, e.g. "1250/240"
 * @property {Object}      specs            — from CSV: tpc, cubic, speed_b,
 *                                            ifo_b, mdo_b, speed_l, ifo_l,
 *                                            mdo_l, ifo_port, mdo_port,
 *                                            duration, final_intake, oa
 * @property {MarketColour[]} market_colour — [0] is the live route quote
 * @property {Object[]} offer_history       — {ts, p6_offer, offer_usd, bb_usd}
 * @property {Object[]} bid_history         — {ts, p6_bid, bid_usd}
 * @property {Object}   field_overrides     — {field: isoTs} manual edits; CSV
 *                                            sync skips fields edited after
 *                                            the CSV row's UPDATE timestamp
 * @property {string}   status              — OPEN | FIXED | FAILED | WITHDRAWN
 * @property {string|null} csv_updated      — UPDATE ts of the last CSV row
 * @property {string|null} user             — desk initials from CSV
 * @property {string|null} notes
 * @property {string|null} last_updated     — ISO ts
 */

/**
 * Market colour for one route (bid = what owner claims to see, offer = ask).
 *
 * @typedef {Object} MarketColour
 * @property {string} route          — e.g. 'ECSA FH'
 * @property {number|null} bid_usd
 * @property {number|null} offer_usd
 * @property {number|null} bb_usd
 * @property {number|null} p6_bid    — P6-normalised bid (universal comparator)
 * @property {number|null} p6_offer
 * @property {boolean} bid_multiple_claims — owner emphasising depth (sceptical)
 */

/**
 * A cargo in the Cargo Book (cargo.js).
 *
 * @typedef {Object} Cargo
 * @property {string} id
 * @property {string} charterer
 * @property {string} stem        — 'ECSA Fronthaul' | 'USG Fronthaul' | ...
 * @property {string|null} cargo  — commodity
 * @property {string|null} size
 * @property {string|null} load
 * @property {string|null} disch
 * @property {string|null} laycan — raw text, e.g. "11Jul-12Jul"
 * @property {string|null} slot   — parsed laycan bucket, e.g. "Jul FH"
 * @property {boolean} fixed
 */

/** Example vessel (WhatsApp-parsed, the canonical parser test case) */
const EXAMPLE_VESSEL = {
  source: 'QUADRA',
  owner: 'CENTROFIN',
  vessel_name: 'SAKIZAYA MIRACLE',
  dwt: 76847,
  build_year: 2013,
  delivery_basis: 'SANTOS',
  open_date: '2026-03-31',
  eta_ecsa: '2026-04-21',
  eta_type: 'ONW',
  market_colour: [{
    route: 'ECSA FH', bid_usd: 20000, offer_usd: 21500,
    p6_bid: 16700, p6_offer: 18000, bid_multiple_claims: true,
  }],
  status: 'OPEN',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EXAMPLE_VESSEL };
}
