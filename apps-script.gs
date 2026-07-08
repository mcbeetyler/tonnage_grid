/* ============================================================
   Tonnage Grid — Google Sheets feed
   Runs in YOUR Google account (script.google.com), READ-ONLY on
   the source sheets. Nothing is installed in or written to the
   sheets themselves — to their owner this is indistinguishable
   from you opening them, which you already do daily.

   Every run it reads the three sheets and POSTs their contents
   to your dashboard's /api/import endpoint, where the dashboard
   picks them up through the same pipelines as a manual paste.

   Setup: see FEEDS_SETUP.md (≈10 minutes, one time).
   ============================================================ */

const CONFIG = {
  // Your dashboard URL — no trailing slash
  appUrl: 'https://YOUR-APP.vercel.app',
  // The dashboard's Basic-auth password (same one you type in the browser)
  appPassword: 'PASTE_YOUR_DASHBOARD_PASSWORD',
  // Where to email you if a run fails (leave '' to disable)
  alertEmail: 'mcbee.tyler@gmail.com',

  sheets: {
    ecsa: {
      id: '1zyvCTNtsyahMjhdtshKjaDcww-9Y9HFlmh6hjyoYc24',
      gid: 2067801444,
    },
    natl: {
      id: '18ygxAGZp8NAJV3SPYz1O4QvqtCtLSw_LvfaxMXMXYK8',
      gid: 1687236034,          // NEW MAINVIEW tab
      distancesTab: 'Distances', // located by name
    },
    cargo: {
      id: '1JlusYmcm6-0PRPDvI9U6pBJuJ3g4XHgy63SQe3jWEz0',
      gid: 1641067976,
    },
  },
};

/** Run this. Reads all three sheets and pushes them to the dashboard. */
function syncAll() {
  const errors = [];
  for (const source of ['ecsa', 'natl', 'cargo']) {
    try {
      pushSource_(source);
    } catch (e) {
      errors.push(source + ': ' + e.message);
    }
  }
  if (errors.length) {
    if (CONFIG.alertEmail) {
      MailApp.sendEmail(CONFIG.alertEmail, 'Tonnage feed failed',
        'The following feeds failed:\n\n' + errors.join('\n') +
        '\n\nCommon causes: tab renamed, access revoked, dashboard offline.');
    }
    throw new Error(errors.join(' | '));
  }
}

/** One-time: installs the every-30-minutes trigger (replaces old ones). */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncAll')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(30).create();
  Logger.log('Trigger installed: syncAll every 30 minutes.');
}

// ─── internals ───────────────────────────────────────────────────────────────

function pushSource_(source) {
  const cfg = CONFIG.sheets[source];
  const ss = SpreadsheetApp.openById(cfg.id);
  const tab = findByGid_(ss, cfg.gid);
  if (!tab) throw new Error('tab gid ' + cfg.gid + ' not found');

  let data;
  if (source === 'ecsa') {
    // Grid header sits below decorative rows — slice from the header row when
    // we can find it, otherwise send the whole tab (the dashboard's parser
    // locates the header itself). Display values so rates/dates arrive
    // exactly as a manual paste would.
    const rows = tab.getDataRange().getDisplayValues();
    const hdrIdx = rows.findIndex(r =>
      r.some(c => /^vessel/i.test(String(c).trim())) &&
      r.some(c => /dwt/i.test(String(c).trim())));
    data = hdrIdx >= 0 ? rows.slice(hdrIdx) : rows;
  } else if (source === 'cargo') {
    data = tab.getDataRange().getDisplayValues();
  } else { // natl — raw values so dates stay dates (serialised to ISO in JSON)
    const distances = ss.getSheetByName(cfg.distancesTab);
    if (!distances) throw new Error('tab "' + cfg.distancesTab + '" not found');
    data = {
      mainview: tab.getDataRange().getValues(),
      distances: distances.getDataRange().getValues(),
    };
  }

  const resp = UrlFetchApp.fetch(CONFIG.appUrl + '/api/import', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ source: source, data: data }),
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode('feed:' + CONFIG.appPassword),
    },
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code !== 200) throw new Error('dashboard answered ' + code + ': ' + resp.getContentText().slice(0, 200));
}

function findByGid_(ss, gid) {
  return ss.getSheets().filter(s => s.getSheetId() === gid)[0] || null;
}
