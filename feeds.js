/* ============================================================
   feeds.js — applies the Google Sheets feeds pushed by the
   Apps Script (see apps-script.gs / FEEDS_SETUP.md).

   On page load (and via the "Feeds" button) it asks /api/import
   which sources have fresh payloads, then routes each through
   the SAME pipeline the manual paste uses:

     ecsa  → TSV text  → parseCSVVessels + syncCSVVessels (grid)
     cargo → TSV text  → parseCargoData + applyParsedCargoes (book)
     natl  → row arrays → LaycanMatcher.applyNatlFeed (matcher)

   Manual pastes keep working exactly as before — this is just a
   robot doing the same paste every 30 minutes.
   ============================================================ */

(function () {
'use strict';

const LS_APPLIED = 'feeds_applied';

function appliedStamps() {
  try { return JSON.parse(localStorage.getItem(LS_APPLIED) || '{}'); }
  catch { return {}; }
}
function markApplied(src, ts) {
  const a = appliedStamps();
  a[src] = ts;
  localStorage.setItem(LS_APPLIED, JSON.stringify(a));
}

function setBadge(text, color, title) {
  const el = document.getElementById('feedsBadge');
  if (!el) return;
  el.textContent = text;
  el.title = title || '';
  el.style.cssText = `font-size:10px;padding:3px 8px;border-radius:10px;font-weight:500;cursor:pointer;background:${color === 'ok' ? '#EAF3DE' : color === 'err' ? '#FAEAEA' : '#FAEEDA'};color:${color === 'ok' ? '#3B6D11' : color === 'err' ? '#A32D2D' : '#BA7517'}`;
}

// 2D array → TSV text (what the manual-paste parsers expect).
// Cells can contain literal newlines (e.g. the "HIRE\n(offer)" header) —
// flatten them to spaces or they'd split the row and shift every column.
function rowsToTsv(rows) {
  return rows.map(r => (r || []).map(c =>
    c == null ? '' : String(c).replace(/[\t\r\n]+/g, ' ')
  ).join('\t')).join('\n');
}

async function fetchSource(src) {
  const resp = await fetch('/api/import?src=' + src);
  if (!resp.ok) throw new Error(src + ': server ' + resp.status);
  return resp.json();
}

function applyEcsa(data) {
  const tsv = typeof data === 'string' ? data : rowsToTsv(data);
  if (typeof parseCSVVessels !== 'function') throw new Error('csv engine not loaded');
  const { vessels: parsed } = parseCSVVessels(tsv);
  if (!parsed.length) throw new Error('ecsa feed parsed 0 rows');
  // autoWithdraw: sheet-managed ships that vanished from the sheet get
  // marked WITHDRAWN; manually-added ships are never auto-touched
  const r = syncCSVVessels(parsed, { autoWithdraw: true });
  save();
  if (typeof renderTable === 'function') renderTable();
  if (typeof updateStats === 'function') updateStats();
  const suspects = (typeof isFixSuspect === 'function') ? vessels.filter(isFixSuspect).length : 0;
  return `${parsed.length} rows (${r.added} new, ${r.updated} updated${r.autoWithdrawn ? ', ' + r.autoWithdrawn + ' auto-withdrawn' : ''}${r.reopened ? ', ' + r.reopened + ' reopened after fixture' : ''})${suspects ? ` · ⚠ ${suspects} FIXED but still trading — review FAILED? flags` : ''}`;
}

function applyCargo(data) {
  const tsv = typeof data === 'string' ? data : rowsToTsv(data);
  if (typeof parseCargoData !== 'function') throw new Error('cargo parser not loaded');
  const parsed = parseCargoData(tsv);
  if (!parsed.length) throw new Error('cargo feed parsed 0 rows');
  const r = applyParsedCargoes(parsed);
  return `${parsed.length} cargoes (${r.addedCount} new, ${r.autoFixedCount} auto-fixed)`;
}

function applyNatl(data) {
  if (!window.LaycanMatcher) throw new Error('laycan matcher not loaded');
  if (!data || !data.mainview) throw new Error('natl feed missing mainview');
  // distances arrive once a day; in between the cached matrix is reused
  const r = window.LaycanMatcher.applyNatlFeed(data.mainview, data.distances || null);
  return `${r.vessels} vessels, ${r.ports} dely ports${data.distances ? '' : ' (cached matrix)'}`;
}

function applyFixtures(data) {
  const tsv = typeof data === 'string' ? data : rowsToTsv(data);
  if (typeof parseCSVVessels !== 'function' || typeof markFixturesFromCSV !== 'function') throw new Error('csv engine not loaded');
  const { vessels: parsed } = parseCSVVessels(tsv);
  if (!parsed.length) throw new Error('fixtures feed parsed 0 rows');
  const r = markFixturesFromCSV(parsed);
  if (r.marked) {
    save();
    if (typeof renderTable === 'function') renderTable();
    if (typeof updateStats === 'function') updateStats();
  }
  return `${parsed.length} fixtures (${r.marked} newly marked FIXED${r.retracted ? ', ' + r.retracted + ' retracted → OPEN' : ''})`;
}

const APPLIERS = { ecsa: applyEcsa, fixtures: applyFixtures, cargo: applyCargo, natl: applyNatl };

async function refreshFeeds(manual) {
  setBadge('Feeds…', 'pend');
  let results = [], anyFresh = false, anyErr = false;
  try {
    const stamps = await fetch('/api/import').then(r => {
      if (!r.ok) throw new Error('server ' + r.status);
      return r.json();
    });
    const applied = appliedStamps();
    for (const src of ['ecsa', 'fixtures', 'natl', 'cargo']) {
      if (!stamps[src]) { results.push(src + ': no feed yet'); continue; }
      if (applied[src] === stamps[src] && !manual) continue;   // already applied
      try {
        const payload = await fetchSource(src);
        if (!payload.ts || payload.data == null) { results.push(src + ': empty'); continue; }
        if (applied[src] === payload.ts && !manual) continue;
        const summary = APPLIERS[src](payload.data);
        markApplied(src, payload.ts);
        anyFresh = true;
        const local = new Date(payload.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        results.push(`${src}: ${summary} @ ${local}`);
      } catch (e) {
        anyErr = true;
        results.push(`${src}: FAILED — ${e.message}`);
      }
    }
    const oldest = Math.min(...['ecsa', 'fixtures', 'natl', 'cargo'].map(s => stamps[s] ? new Date(stamps[s]).getTime() : Infinity));
    const ageMin = isFinite(oldest) ? Math.round((Date.now() - oldest) / 60000) : null;
    setBadge(
      anyErr ? 'Feeds: error' : ageMin == null ? 'Feeds: none' : `Feeds: ${ageMin}m`,
      anyErr ? 'err' : ageMin == null ? 'pend' : 'ok',
      results.join('\n') || 'All feeds already applied.'
    );
    if (manual && results.length) console.log('[feeds]\n' + results.join('\n'));
  } catch (e) {
    setBadge('Feeds: offline', 'err', e.message);
  }
}

// ─── On-demand fresh read ────────────────────────────────────────────────────
// The badge used to re-apply the last payload the robot POSTED — it couldn't
// make the robot re-READ the sheets. With the Apps Script deployed as a web
// app, a click now pings it (fire-and-forget; the response is CORS-opaque
// but the run happens), then polls for fresher payloads and applies them.
const LS_WEBAPP = 'feeds_webapp_url';

function webappUrl() {
  const v = localStorage.getItem(LS_WEBAPP);
  return v === null ? undefined : v;   // '' = user declined, don't nag
}

function promptWebappUrl() {
  const v = prompt(
    'Optional — enable TRUE fresh reads:\n\n' +
    'In the Apps Script editor: Deploy → New deployment → Web app → ' +
    'execute as Me, access "Anyone with the link". Paste the /exec URL here.\n\n' +
    'Leave empty to skip (the button will keep applying the last 30-min feed).');
  localStorage.setItem(LS_WEBAPP, (v || '').trim());
  return (v || '').trim();
}

async function freshRead() {
  let url = webappUrl();
  if (url === undefined) url = promptWebappUrl();
  if (!url) { refreshFeeds(true); return; }   // not configured — old behaviour

  const clickTs = new Date().toISOString();
  setBadge('Reading sheets…', 'pend', 'Asked the Apps Script for a fresh read — applying as soon as new payloads land');
  try {
    // CORS-opaque by design: the GET still executes the script server-side
    await fetch(url, { mode: 'no-cors' });
  } catch (e) { /* opaque failures are expected; the poll decides */ }

  // Poll for payloads newer than the click, up to ~90s (4 sheets take a while)
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const stamps = await fetch('/api/import').then(r => r.json());
      if (Object.values(stamps).some(ts => ts && ts > clickTs)) {
        await refreshFeeds(true);
        return;
      }
    } catch (e) { /* keep polling */ }
  }
  setBadge('Feeds: no fresh data', 'err',
    'The web-app ping produced nothing new within 90s. Check the Apps Script executions panel — or the sheets simply have not changed.');
}

function injectBadge() {
  const syncBadge = document.getElementById('syncBadge');
  if (!syncBadge || document.getElementById('feedsBadge')) return;
  const el = document.createElement('span');
  el.id = 'feedsBadge';
  el.addEventListener('click', () => freshRead());
  el.addEventListener('contextmenu', e => { e.preventDefault(); localStorage.removeItem(LS_WEBAPP); promptWebappUrl(); });
  syncBadge.parentNode.insertBefore(el, syncBadge.nextSibling);
  setBadge('Feeds', 'pend', 'Click: fresh sheet read (if web app configured) · right-click: set the web-app URL');
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    injectBadge();
    refreshFeeds(false);                       // apply anything fresh on load
    setInterval(() => refreshFeeds(false), 10 * 60 * 1000);  // re-check every 10 min
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _test: { rowsToTsv } };
}

})();
