/* ============================================================
   voyageCalc.js — voyage estimation engine (pure functions)
   Dry bulk round-voyage TCE <-> freight rate.
   No DOM, no state, no dependencies. Safe to require/import anywhere.
   Calibrated to Baltic P8 / "Tess 82" conventions.
   ============================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.VoyageCalc = api;
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {

  /** Days + cost decomposition shared by both directions. */
  function computeVoyage(i) {
    const wx = 1 + (i.wxMarginPct || 0);
    const ballSeaDays  = (i.ballDist  / Math.max(i.ballSpd,  0.1)) / 24 * wx;
    const ladenSeaDays = (i.ladenDist / Math.max(i.ladenSpd, 0.1)) / 24 * wx;
    const portDays = (i.loadDays || 0) + (i.dischDays || 0);
    const idleDays = i.idleDays || 0;
    const totalDays = ballSeaDays + ladenSeaDays + portDays + idleDays;

    const seaMainPx = i.scrubberFitted ? i.pxHsfo : i.pxVlsfo;

    const ballMainMt  = ballSeaDays  * i.ballCons;
    const ladenMainMt = ladenSeaDays * i.ladenCons;
    const portMainMt  = (portDays + idleDays) * i.portCons;
    const mgoMt = ballSeaDays * i.ballMgo + ladenSeaDays * i.ladenMgo;

    const mainCost = (ballMainMt + ladenMainMt + portMainMt) * seaMainPx;
    const mgoCost  = mgoMt * i.pxMgo;
    const bunkerCost = mainCost + mgoCost;

    const portCharges = (i.loadCost || 0) + (i.dischCost || 0) + (i.canalCost || 0) + (i.miscCost || 0);

    // Scrubber benefit: VLSFO-HSFO spread captured on all main fuel when fitted.
    let scrubBenefit = 0, scrubToCharterer = 0;
    if (i.scrubberFitted) {
      const spread = i.pxVlsfo - i.pxHsfo;
      const mainMt = ballMainMt + ladenMainMt + portMainMt;
      scrubBenefit = spread * mainMt;
      if (i.scrubSplit === '5050') scrubToCharterer = scrubBenefit * 0.5;
      else if (i.scrubSplit === 'chtr') scrubToCharterer = scrubBenefit;
      // 'owner' (default) → charterer keeps 0
    }
    const ownerScrubBenefit = scrubBenefit - scrubToCharterer;

    return {
      ballSeaDays, ladenSeaDays, portDays, idleDays, totalDays,
      bunkerCost, portCharges, scrubBenefit, ownerScrubBenefit,
      voyageCost: bunkerCost + portCharges,
      ballMainMt, ladenMainMt, portMainMt, mgoMt, mainCost, mgoCost
    };
  }

  /** Rate → TCE. Given a freight rate ($/mt), return $/day the vessel earns. */
  function rateToTce(i) {
    const v = computeVoyage(i);
    const gross = i.rate * i.intake;
    const commission = gross * i.commPct;
    const netFreight = gross - commission;
    const tce = (netFreight - v.voyageCost + v.ownerScrubBenefit) / Math.max(v.totalDays, 0.1);
    return Object.assign({ tce, gross, commission, netFreight }, v);
  }

  /** TCE → Rate. Given a target $/day, return the breakeven freight rate ($/mt). */
  function tceToRate(i) {
    const v = computeVoyage(i);
    const netNeeded = i.targetTce * v.totalDays + v.voyageCost - v.ownerScrubBenefit;
    const grossNeeded = netNeeded / (1 - i.commPct);
    const rate = grossNeeded / Math.max(i.intake, 1);
    return Object.assign({ rate, grossNeeded, netNeeded }, v);
  }

  /** Baltic P8 / "Tess 82" reference defaults. Spread/overwrite as needed. */
  const P8_TESS82_DEFAULTS = {
    intake: 66000,
    commPct: 0.05,
    ballDist: 2500, ladenDist: 11400,
    ballSpd: 14.0, ladenSpd: 13.5,
    wxMarginPct: 0.05,
    ballCons: 31.0, ladenCons: 33.0,
    ballMgo: 0.1, ladenMgo: 0.1,
    loadDays: 9.25, dischDays: 8.75, idleDays: 0, portCons: 5.0,
    pxVlsfo: 560, pxMgo: 720, pxHsfo: 420,
    loadCost: 180000, dischCost: 150000, canalCost: 0, miscCost: 15000,
    scrubberFitted: false, scrubSplit: 'owner'
  };

  return { rateToTce, tceToRate, computeVoyage, P8_TESS82_DEFAULTS };
});
