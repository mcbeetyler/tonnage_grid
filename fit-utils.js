/* ============================================================
   fit-utils.js — shared laycan-fit logic
   Used by the Laycan Matcher (NATL positional tool) and the
   Pairings tab (Tonnage Board ↔ Cargo Book matcher) so the two
   can never drift apart.

   Status semantics:
     FIT    — arrives on or before cancelling, AND no more than
              waitTolDays before layfrom (a ship few owners would
              have to keep idle → genuinely fixable)
     EARLY  — makes cancelling but would sit idle past the wait
              tolerance; needs waiting priced in
     TIGHT  — misses cancelling by <= tightTolDays; worth a call
     MISSES — misses by more
     ETA    — ETA known but no laycan given to compare against
     NODATA — can't compute (no ETA / no laycan)
   ============================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.FitUtils = api;
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  const DAY = 86400000;

  /**
   * @param eta      Date|null  arrival at load port
   * @param layFrom  Date|null  laycan opens (00:00 UTC)
   * @param layTo    Date|null  cancelling (use end of day)
   * @param opts     {waitTolDays=2, tightTolDays=2}
   * @returns {status, marginDays, waitDays}
   */
  function fitStatus(eta, layFrom, layTo, opts) {
    const waitTol = opts && opts.waitTolDays != null ? parseFloat(opts.waitTolDays) : 2;
    const tightTol = opts && opts.tightTolDays != null ? parseFloat(opts.tightTolDays) : 2;
    let status = 'NODATA', marginDays = null, waitDays = null;
    if (eta && layTo) {
      marginDays = (layTo - eta) / DAY;
      if (layFrom && eta < layFrom) waitDays = (layFrom - eta) / DAY;
      if (eta <= layTo) {
        status = (waitDays != null && !isNaN(waitTol) && waitDays > waitTol) ? 'EARLY' : 'FIT';
      } else if ((eta - layTo) / DAY <= (isNaN(tightTol) ? 0 : tightTol)) {
        status = 'TIGHT';
      } else {
        status = 'MISSES';
      }
    } else if (eta) {
      status = 'ETA';
    }
    return { status, marginDays, waitDays };
  }

  // Sort priority: fixable first
  const FIT_ORDER = { FIT: 0, TIGHT: 1, EARLY: 2, ETA: 3, MISSES: 4, NODATA: 5 };

  // ── Laycan string parsing ("11Jul-12Jul", "01-10 Aug", "15 Jul", "Jul11-12")
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseLaycanWindow(str) {
    if (!str) return null;
    const t = String(str).toLowerCase().replace(/\s+/g, '');
    const yearNow = new Date().getFullYear();
    const mk = (d, m) => {
      let dt = new Date(Date.UTC(yearNow, m, d));
      const now = new Date();
      if (dt < now && (now - dt) / DAY > 180) dt = new Date(Date.UTC(yearNow + 1, m, d));
      return dt.toISOString().slice(0, 10);
    };
    let m;
    if ((m = t.match(/^(\d{1,2})([a-z]{3})[-–\/](\d{1,2})([a-z]{3})/)) && MONTHS[m[2]] != null && MONTHS[m[4]] != null)
      return { from: mk(+m[1], MONTHS[m[2]]), to: mk(+m[3], MONTHS[m[4]]) };
    if ((m = t.match(/^(\d{1,2})[-–\/](\d{1,2})([a-z]{3})/)) && MONTHS[m[3]] != null)
      return { from: mk(+m[1], MONTHS[m[3]]), to: mk(+m[2], MONTHS[m[3]]) };
    if ((m = t.match(/^(\d{1,2})([a-z]{3})$/)) && MONTHS[m[2]] != null)
      return { from: mk(+m[1], MONTHS[m[2]]), to: mk(+m[1], MONTHS[m[2]]) };
    if ((m = t.match(/^([a-z]{3})(\d{1,2})[-–\/](\d{1,2})$/)) && MONTHS[m[1]] != null)
      return { from: mk(+m[2], MONTHS[m[1]]), to: mk(+m[3], MONTHS[m[1]]) };
    return null;
  }

  return { fitStatus, parseLaycanWindow, FIT_ORDER, DAY };
});
