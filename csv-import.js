/* ============================================================
   csv-import.js — CSV/TSV grid sync engine
   Extracted verbatim from app.js. Loaded as a classic script
   BEFORE app.js — top-level declarations share the global
   lexical scope, so handleParse() and inline onclick handlers
   keep working unchanged.
   ============================================================ */

// ─── CSV/TSV Paste Parser ───────────────────────────────────────────────────
// Paste from spreadsheet (tab-separated) or CSV. First row must be headers.
// Known headers (case-insensitive, flexible whitespace/punctuation):
//   vessel, dwt, age, draft, yard, origin, dely (delivery), layday, hire (offer),
//   bb (offer), eta, owner, bki eqvt, rate $/pmt, arrow eqvt, comments, bunker

const CSV_HEADER_MAP = {
  'vessel': 'vessel_name',
  'vessel name': 'vessel_name',
  'name': 'vessel_name',
  'dwt': 'dwt',
  'age': 'build_year_raw', // special parsing
  'built': 'build_year_raw',
  'year': 'build_year_raw',
  'draft': 'draft',
  'yard': 'yard',
  'origin': 'origin',
  'flag': 'origin',
  'dely': 'delivery_basis',
  'delivery': 'delivery_basis',
  'layday': 'laycan_date',
  'laycan': 'laycan_date',
  'open': 'open_date_raw',
  'hire': 'hire_offer',
  'hire (offer)': 'hire_offer',
  'hire offer': 'hire_offer',
  'bb': 'bb_offer',
  'bb (offer)': 'bb_offer',
  'bb offer': 'bb_offer',
  'ballast bonus': 'bb_offer',
  'eta': 'eta_ecsa_raw',
  'owner': 'owner',
  'bki eqvt': 'bki_eqvt',
  'bki equivalent': 'bki_eqvt',
  'bki': 'bki_eqvt',
  'rate $/pmt': 'rate_pmt',
  'rate': 'rate_pmt',
  'rate $': 'rate_pmt',
  '$/pmt': 'rate_pmt',
  'arrow eqvt': 'arrow_eqvt',
  'arrow equivalent': 'arrow_eqvt',
  'arrow': 'arrow_eqvt',
  'comments': 'notes',
  'comment': 'notes',
  'bunker': 'bunker',
  'bunkers': 'bunker',
  'scrubber': 'scrubber_raw',
  'scr': 'scrubber_raw',
  // Extended desk-sheet columns
  'update': 'csv_updated_raw',      // row freshness — drives sync conflict resolution
  'updated': 'csv_updated_raw',
  'last update': 'csv_updated_raw', // Fixtures tab uses this header (= fix date)
  'fix msg': 'fix_msg',
  'hire ta': 'hire_ta',
  'hire (ta)': 'hire_ta',
  'user': 'user',
  'scrub fit': 'scrubber_raw',
  'scrub chart acc': 'scrub_chart_acc_raw',
  'oa': 'spec_oa',
  'duration': 'spec_duration',
  'final intake': 'spec_final_intake',
  'best speed': null,               // lookup label column ("Globe Danae 1") — not a speed
  'tpc': 'spec_tpc',
  'cubic': 'spec_cubic',
  'speed b': 'spec_speed_b',
  'ifo day b': 'spec_ifo_b',
  'mdo day b': 'spec_mdo_b',
  'speed l': 'spec_speed_l',
  'ifo day l': 'spec_ifo_l',
  'mdo day l': 'spec_mdo_l',
  'ifo at port wking': 'spec_ifo_port',
  'mdo at port wking': 'spec_mdo_port',
  'type': 'vessel_type',            // KMX / PMX / PPMX / 87DWT
  'added to grid': 'added_to_grid',
  'status': 'csv_status_raw',       // 1 = active
  'cargo': 'last_cargo',            // GRAIN CLEAN / COAL / X DD ...
};

function normalizeHeader(h) {
  return (h || '')
    .toLowerCase()
    .replace(/[\n\r]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectDelimiter(line) {
  // Prefer tabs; fall back to comma if no tabs
  if (line.indexOf('\t') !== -1) return '\t';
  return ',';
}

// Proper CSV/TSV tokenizer that respects quoted fields spanning multiple lines.
// Returns a 2D array: rows of cells. This is the fix for multi-line headers
// like "HIRE\n(offer)" that would otherwise break a naive line split.
function tokenizeCSV(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && c === delim) {
      row.push(field);
      field = '';
      continue;
    }
    if (!inQuotes && (c === '\n' || c === '\r')) {
      // Handle \r\n as a single line break
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Skip entirely-empty rows
      if (row.some(f => f && f.trim())) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  // Flush last field/row
  if (field || row.length) {
    row.push(field);
    if (row.some(f => f && f.trim())) rows.push(row);
  }
  return rows;
}

// Simple CSV splitter that respects double-quoted fields (for single-line usage)
function splitCSVRow(line, delim) {
  if (delim === '\t') return line.split('\t');
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === delim && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(s.toString().replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function parseAgeField(s) {
  // "Jan-2006" → 2006;  "2016" → 2016;  "16" → 2016;  "Jan-10" → 2010 (Excel
  // 2-digit year display);  "Oct-24" → 2024.
  // Reject "1-Jan" etc. where Excel has dropped the year — would otherwise be misread as 2001.
  if (!s) return null;
  const trimmed = s.trim();
  const m = trimmed.match(/(19|20)\d{2}/);
  if (m) return parseInt(m[0], 10);
  const pivot = yy => yy <= (new Date().getFullYear() % 100) + 3 ? 2000 + yy : 1900 + yy;
  // "Jan-10" / "Jan 10" / "jan10" — month name + 2-digit year (Excel mmm-yy display)
  const my = trimmed.match(/^[A-Za-z]{3,}[-\s]?(\d{2})$/);
  if (my) return pivot(parseInt(my[1], 10));
  // "10-Jan" — same thing flipped by some export paths. Only 2-digit numbers:
  // "1-Jan" stays rejected (that's a real date with the year dropped).
  const ym = trimmed.match(/^(\d{2})[-\s]?[A-Za-z]{3,}$/);
  if (ym) return pivot(parseInt(ym[1], 10));
  if (/^\d{1,2}$/.test(trimmed)) return 2000 + parseInt(trimmed, 10);
  return null;
}

function parseDwtField(s) {
  // "80,306" → 80306;  "80.306" (EU thousands) → 80306;  "82" → 82000;
  // "76,483 " → 76483. Sanity range for this desk: 10k–250k.
  if (!s) return null;
  const t = s.toString().trim();
  // Digit groups separated by , or . in thousands pattern
  const grp = t.match(/^(\d{1,3})[.,](\d{3})(?:[.,](\d{3}))?$/);
  if (grp) {
    const n = parseInt(grp[1] + grp[2] + (grp[3] || ''), 10);
    if (n >= 10000 && n <= 250000) return n;
  }
  const n = parseFloat(t.replace(/[,\s]/g, ''));
  if (isNaN(n)) return null;
  if (n < 1000) return Math.round(n * 1000);   // "82" / "76.5" → 82,000 / 76,500
  return Math.round(n);
}

// "08-Jul 10:46" → ISO timestamp (current year, rolled back a year if it would
// land in the future — a Dec sheet read in Jan).
function parseCsvUpdateTs(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3,})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const mo = monthMap[m[2].slice(0, 3).toLowerCase()];
  if (mo == null) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), mo, parseInt(m[1], 10), parseInt(m[3] || '0', 10), parseInt(m[4] || '0', 10));
  if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

function parseLaydayDate(s) {
  if (!s) return null;
  // Accept "15-Apr", "15 Apr", "15-Apr-26", "2026-04-15", "21+ Aug" / "21+Aug"
  // (the '+' means onwards — the date part still parses)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/(\d{1,2})\+?[\s-]*([A-Za-z]{3,})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthMap = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const monthKey = m[2].slice(0, 3).toLowerCase();
  const month = monthMap[monthKey];
  if (!month) return null;
  // Year-roll: "15-Jan" pasted in December means next year, not 11 months ago
  let year = new Date().getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (Date.now() - candidate.getTime() > 180 * 86400000) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Find the header row: first row (searching the top 50) whose cells map to
// vessel_name plus at least two other known fields. Tolerates decorative
// rows above the grid — the Google Sheets feed sends whole tabs, and manual
// pastes sometimes include the rows above the header too.
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 50);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(c => normalizeHeader(c));
    const vesselHit = cells.some(c => CSV_HEADER_MAP[c] === 'vessel_name');
    const others = cells.filter(c => CSV_HEADER_MAP[c] && CSV_HEADER_MAP[c] !== 'vessel_name').length;
    if (vesselHit && others >= 2) return i;
  }
  return -1;
}

// Detect if the input looks like tabular data (CSV/TSV with a header row)
function looksLikeCSV(raw) {
  const firstLine = raw.split('\n')[0];
  if (!firstLine) return false;
  const delim = detectDelimiter(firstLine);
  // Use tokenizer so multi-line headers don't break detection
  const rows = tokenizeCSV(raw, delim);
  if (rows.length < 2) return false;
  return findHeaderRow(rows) >= 0;
}

function parseCSVVessels(raw) {
  const firstLine = raw.split('\n')[0];
  const delim = detectDelimiter(firstLine);
  let rows = tokenizeCSV(raw, delim);
  const hdrIdx = findHeaderRow(rows);
  if (hdrIdx < 0 || rows.length < hdrIdx + 2) return { vessels: [], headers: [], mapping: {} };
  rows = rows.slice(hdrIdx);

  // Build column map from header row
  const headerCells = rows[0].map(normalizeHeader);
  const colMap = headerCells.map(h => CSV_HEADER_MAP[h] || null);
  const mapping = {};
  headerCells.forEach((h, i) => { mapping[h || `col${i}`] = colMap[i] || '(skipped)'; });

  const vessels = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].map(c => (c || '').trim());
    if (cells.every(c => !c)) continue;

    const v = {
      vessel_name: null, dwt: null, build_year: null, draft: null, yard: null,
      origin: null, delivery_basis: null, laycan_date: null,
      hire_offer: null, bb_offer: null, eta_ecsa: null, eta_type: null,
      owner: null, bki_eqvt: null, rate_pmt: null, arrow_eqvt: null,
      notes: null, bunker: null, scrubber: null,
      hire_ta: null, scrub_chart_acc: null, vessel_type: null,
      last_cargo: null, added_to_grid: null, user: null, fix_msg: null,
      csv_updated: null, csv_status: null, specs: {},
      market_colour: [],
      status: 'OPEN',
      raw: cells.join('\t'),
      parsed_at: new Date().toISOString(),
      parse_warnings: [],
    };

    for (let j = 0; j < cells.length; j++) {
      const field = colMap[j];
      const val = cells[j];
      if (!field || !val) continue;

      // Spec columns (TPC, cubic, speeds/consumptions...) → v.specs.*
      if (field.startsWith('spec_')) {
        const n = parseFloat(val.toString().replace(/[,\s]/g, ''));
        if (!isNaN(n)) v.specs[field.slice(5)] = n;
        continue;
      }

      switch (field) {
        case 'vessel_name':
          v.vessel_name = val.replace(/\s+\d+\s*dwt$/i, '').trim();
          break;
        case 'dwt': {
          const n = parseDwtField(val);
          if (n != null) v.dwt = n;
          break;
        }
        case 'build_year_raw': {
          const y = parseAgeField(val);
          if (y) v.build_year = y;   // don't clobber a good parse with a bad duplicate column
          break;
        }
        case 'draft': {
          const n = parseFloat(val);
          if (!isNaN(n)) v.draft = n;
          break;
        }
        case 'yard': v.yard = val; break;
        case 'origin': v.origin = val; break;
        case 'delivery_basis': v.delivery_basis = val.toUpperCase(); break;
        case 'laycan_date': {
          v.laycan_date = val;
          const d = parseLaydayDate(val);
          if (d) v.open_date = d;
          break;
        }
        case 'open_date_raw': {
          const d = parseLaydayDate(val);
          if (d) v.open_date = d;
          break;
        }
        case 'hire_offer': v.hire_offer = parseMoney(val); break;
        case 'bb_offer': v.bb_offer = parseMoney(val); break;
        case 'eta_ecsa_raw': {
          const d = parseLaydayDate(val);
          if (d) { v.eta_ecsa = d; v.eta_type = 'EXACT'; }
          else { v.notes = (v.notes ? v.notes + ' · ' : '') + 'ETA: ' + val; }
          break;
        }
        case 'owner': v.owner = val; break;
        case 'bki_eqvt': v.bki_eqvt = parseMoney(val); break;
        case 'rate_pmt': v.rate_pmt = parseMoney(val); break;
        case 'arrow_eqvt': v.arrow_eqvt = parseMoney(val); break;
        case 'notes': v.notes = val; break;
        case 'bunker': v.bunker = val; break;
        case 'scrubber_raw': {
          const s = val.toLowerCase();
          if (/yes|true|scr|fitted/.test(s)) v.scrubber = true;
          else if (/no|false|none/.test(s)) v.scrubber = false;
          break;
        }
        case 'csv_updated_raw': v.csv_updated = parseCsvUpdateTs(val); break;
        case 'hire_ta': v.hire_ta = parseMoney(val); break;
        case 'user': v.user = val; break;
        case 'scrub_chart_acc_raw': v.scrub_chart_acc = /true|yes|1/i.test(val); break;
        case 'vessel_type': v.vessel_type = val.toUpperCase(); break;
        case 'added_to_grid': {
          const d = parseLaydayDate(val);
          if (d) v.added_to_grid = d;
          break;
        }
        case 'csv_status_raw': v.csv_status = val.trim(); break;
        case 'last_cargo': v.last_cargo = val.toUpperCase(); break;
        case 'fix_msg': v.fix_msg = val; break;
      }
    }

    if (v.hire_offer || v.bki_eqvt) {
      v.market_colour = [{
        route: 'ECSA FH',
        bid_usd: null, offer_usd: v.hire_offer, bb_usd: v.bb_offer,
        p6_bid: null, p6_offer: v.bki_eqvt || null,
        bid_multiple_claims: false, is_bid: false, is_idea: false,
        collecting: false, notes: null,
      }];
    }
    if (v.csv_updated) v.last_updated = v.csv_updated;

    if (v.vessel_name) vessels.push(v);
  }

  return { vessels, headers: headerCells, mapping };
}

// Reconcile CSV upload against the board — CSV IS THE SOURCE OF TRUTH.
// - New vessel names → added
// - Existing vessels → CSV-owned fields UPDATED, except fields the user
//   manually edited AFTER the CSV row's UPDATE timestamp (field_overrides,
//   stamped by applyEdit). A fresher CSV row later wins those back.
// - Bid-side intel (p6_bid, bid_usd, bidding_charterer, bid_history) and
//   fixture fields are NEVER touched by CSV — that's desk knowledge.
// - Status: CSV never flips a FIXED/FAILED/WITHDRAWN ship back to OPEN.
// - Existing OPEN vessels NOT in the CSV → returned as withdraw CANDIDATES
//   (caller must explicitly confirm before applying).

// Scalar fields the CSV owns (copied when present on the CSV row)
const CSV_SYNC_FIELDS = ['dwt', 'build_year', 'draft', 'yard', 'origin', 'delivery_basis',
  'laycan_date', 'open_date', 'eta_ecsa', 'eta_type', 'owner', 'bki_eqvt', 'rate_pmt',
  'arrow_eqvt', 'notes', 'bunker', 'scrubber', 'hire_offer', 'bb_offer', 'hire_ta',
  'scrub_chart_acc', 'vessel_type', 'last_cargo', 'added_to_grid', 'user'];

function syncCSVVessels(newVessels, opts) {
  const autoWithdraw = !!(opts && opts.autoWithdraw);
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const csvNames = new Set(newVessels.map(v => norm(v.vessel_name)).filter(Boolean));
  let added = 0, updated = 0, unchanged = 0, protectedFields = 0, reopened = 0;

  for (const nv of newVessels) {
    const existing = vessels.find(v => norm(v.vessel_name) === norm(nv.vessel_name));
    if (!existing) {
      if (nv.csv_status === '0') nv.status = 'WITHDRAWN';
      vessels.push(nv);
      added++;
      continue;
    }

    const rowTs = nv.csv_updated || new Date().toISOString();
    const overrides = existing.field_overrides || {};
    // A manual edit newer than this CSV row wins; otherwise CSV wins.
    const isProtected = f => overrides[f] && overrides[f] > rowTs;
    let changed = false;

    for (const f of CSV_SYNC_FIELDS) {
      if (nv[f] == null || nv[f] === '') continue;
      if (isProtected(f)) { protectedFields++; continue; }
      if (existing[f] !== nv[f]) { existing[f] = nv[f]; changed = true; }
    }
    // Specs merge (TPC, cubic, speeds/consumptions)
    if (nv.specs && Object.keys(nv.specs).length) {
      existing.specs = Object.assign({}, existing.specs, nv.specs);
    }

    // market_colour: CSV owns the OFFER side only; bid side is desk intel.
    if (nv.hire_offer != null || nv.bki_eqvt != null || nv.bb_offer != null) {
      if (!existing.market_colour || !existing.market_colour[0]) {
        existing.market_colour = [{ route: 'ECSA FH', bid_usd: null, p6_bid: null,
          offer_usd: null, p6_offer: null, bb_usd: null,
          bid_multiple_claims: false, is_bid: false, is_idea: false, collecting: false, notes: null }];
      }
      const mc = existing.market_colour[0];
      const beforeOffer = { p6: mc.p6_offer, raw: mc.offer_usd, bb: mc.bb_usd };
      if (nv.hire_offer != null && !isProtected('hire_offer')) mc.offer_usd = nv.hire_offer;
      if (nv.bki_eqvt != null && !isProtected('p6_offer') && !isProtected('bki_eqvt')) mc.p6_offer = nv.bki_eqvt;
      if (nv.bb_offer != null && !isProtected('bb_offer')) mc.bb_usd = nv.bb_offer;
      if (mc.p6_offer !== beforeOffer.p6 || mc.offer_usd !== beforeOffer.raw || mc.bb_usd !== beforeOffer.bb) {
        existing.offer_history = existing.offer_history || [];
        existing.offer_history.push({ ts: rowTs, p6_offer: mc.p6_offer, offer_usd: mc.offer_usd, bb_usd: mc.bb_usd });
        existing.offer_updated_at = rowTs;
        changed = true;
      }
    }

    // Status: '1' = active.
    if (nv.csv_status === '0' && existing.status === 'OPEN' && !isProtected('status')) {
      existing.status = 'WITHDRAWN'; changed = true;
    } else if (nv.csv_status === '1' && existing.status === 'WITHDRAWN' && !isProtected('status')) {
      existing.status = 'OPEN';
      // Back on the sheet as a live position: old fixture residue (she may
      // have gone FIXED → withdrawn-from-grid → returned) is history now
      if (existing.date_fixed && nv.open_date && nv.open_date > existing.date_fixed) {
        archiveFixtureResidue(existing);
      }
      // Her return row has no rate → the sheet says no rate. Don't let a
      // quote from her previous cycle walk back in with her.
      if (!rowHasRate(nv)) clearQuoteResidue(existing);
      changed = true;
    } else if (nv.csv_status === '1' && (existing.status === 'FIXED' || existing.status === 'ON SUBS') && !isProtected('status')) {
      // A fixed (or long-stuck on-subs) ship back on the grid: reopen ONLY if her new layday is
      // clearly after the fixture (Pacific round done, ballasting back) —
      // not when the sheet is just lagging behind a fresh fixture.
      // The old fixture is archived, never destroyed: it's rate history.
      const REOPEN_GAP_DAYS = 21;
      const newOpen = nv.open_date || null;
      const fixedOn = existing.date_fixed || null;
      const gap = (newOpen && fixedOn)
        ? (new Date(newOpen + 'T00:00:00Z') - new Date(fixedOn + 'T00:00:00Z')) / 86400000
        : null;
      if (gap != null && gap >= REOPEN_GAP_DAYS) {
        existing.fixture_history = existing.fixture_history || [];
        existing.fixture_history.push({
          date_fixed: existing.date_fixed, fixed_price: existing.fixed_price ?? null,
          charterer: existing.charterer ?? null, fix_msg: existing.fix_msg ?? null,
        });
        existing.status = 'OPEN';
        existing.date_fixed = null; existing.fixed_price = null;
        existing.fix_msg = null; existing.charterer = null;
        existing.reopened_at = rowTs;
        // Fresh position after the round trip — quotes from the cycle she
        // just completed are dead unless her return row carries a new rate
        if (!rowHasRate(nv)) clearQuoteResidue(existing);
        reopened++;
        changed = true;
      }
    }

    // Fix-and-fail detection: a genuinely fixed ship LEAVES the grid.
    // One still trading there days after her fixture likely failed on
    // subs — count the distinct days she's been seen post-fixture.
    if (existing.status === 'FIXED' && existing.date_fixed
        && nv.csv_status === '1' && rowTs.slice(0, 10) > existing.date_fixed) {
      existing.post_fix_days = existing.post_fix_days || [];
      const d = rowTs.slice(0, 10);
      if (!existing.post_fix_days.includes(d)) {
        existing.post_fix_days.push(d);
        if (existing.post_fix_days.length > 10) existing.post_fix_days.shift();
        changed = true;
      }
    }

    if (changed) { existing.last_updated = rowTs; updated++; }
    else unchanged++;
  }

  // Ships on the board but missing from this CSV.
  // - autoWithdraw (feed): ships the SHEET manages (they have a csv_updated
  //   stamp from an earlier sync) are auto-marked WITHDRAWN — the sheet
  //   dropped them, so the board follows. Manually-added ships (WhatsApp /
  //   manual entry — no csv stamp) are NEVER touched automatically.
  // - manual paste: everything stays a candidate for the confirm button.
  const withdrawCandidates = [];
  let autoWithdrawn = 0;
  const nowIso = new Date().toISOString();
  for (const v of vessels) {
    if (v.status !== 'OPEN') continue;
    if (csvNames.has(norm(v.vessel_name))) continue;
    if (autoWithdraw && v.csv_updated) {
      v.status = 'WITHDRAWN';
      v.withdrawn_reason = 'dropped from sheet feed';
      v.last_updated = nowIso;
      autoWithdrawn++;
    } else {
      withdrawCandidates.push({ vessel: v, name: v.vessel_name || '(unnamed)' });
    }
  }

  return { added, updated, unchanged, protectedFields, withdrawCandidates, autoWithdrawn, reopened };
}

// Archive a previous fixture's residue when a ship comes back as a fresh
// position — date_fixed/price/charterer move to fixture_history, the live
// fields clear. Shared by the CSV reopen paths and the manual status flip.
function archiveFixtureResidue(v) {
  if (!v.date_fixed && v.fixed_price == null && !v.charterer && !v.fix_msg) return false;
  v.fixture_history = v.fixture_history || [];
  v.fixture_history.push({
    date_fixed: v.date_fixed || null, fixed_price: v.fixed_price ?? null,
    charterer: v.charterer ?? null, fix_msg: v.fix_msg ?? null,
    route: v.route ?? null,
  });
  v.date_fixed = null; v.fixed_price = null; v.charterer = null; v.fix_msg = null;
  // Stale route hides the ship from the Report tab (ECSA FH-only filter) —
  // a reopened ship's route is unknown until quoted again
  v.route = null; v.fixed_route = null;
  // Fresh position: fail-detection counters reset too
  v.post_fix_days = []; v.fix_suspect_dismissed = false;
  return true;
}

// A reentering ship's quotes died with her previous cycle. If the sheet row
// that brings her back carries NO rate, clearing prevents a months-old rate
// from resurrecting alongside her (sheet is truth: blank rate = no rate).
// Both offer AND bid side go — a bid on her old position is meaningless now.
function clearQuoteResidue(v, opts) {
  const offerOnly = !!(opts && opts.offerOnly);
  v.hire_offer = null; v.hire_ta = null; v.bb_offer = null; v.bki_eqvt = null;
  v.offer_updated_at = null;
  if (!offerOnly) v.bidding_charterer = null;
  if (v.market_colour && v.market_colour[0]) {
    const mc = v.market_colour[0];
    mc.offer_usd = null; mc.p6_offer = null; mc.bb_usd = null;
    if (!offerOnly) { mc.bid_usd = null; mc.p6_bid = null; }
  }
}

// Does this parsed CSV row carry any rate at all?
function rowHasRate(nv) {
  return nv.hire_offer != null || nv.hire_ta != null
    || nv.bki_eqvt != null || nv.bb_offer != null;
}

// Is this FIXED ship suspiciously still trading on the grid? (>=3 distinct
// post-fixture days seen, feed-made fix, not dismissed by the user)
function isFixSuspect(v) {
  return v.status === 'FIXED'
    && !(v.field_overrides || {}).status
    && (v.post_fix_days || []).length >= 3
    && !v.fix_suspect_dismissed;
}

// Self-healing sweep, run on every load: OPEN ships still wearing a fixture
// from months ago (fixture >60d older than the current ETA) get their
// residue archived automatically — no clicking required. This is what
// un-sticks ships that reopened BEFORE the archive logic existed.
function sweepStaleFixtureResidue() {
  let swept = 0;
  for (const v of vessels) {
    // OPEN ships wearing an old fixture, AND ships stuck ON SUBS from months
    // ago (nobody is on subs for 60+ days — that fixture either happened or
    // failed; either way the current position is a fresh opening)
    if (v.status !== 'OPEN' && v.status !== 'ON SUBS') continue;
    if (!v.date_fixed || !v.eta_ecsa) continue;
    const gap = (new Date(String(v.eta_ecsa).slice(0, 10)) - new Date(String(v.date_fixed).slice(0, 10))) / 86400000;
    if (gap > 60 && archiveFixtureResidue(v)) {
      if (v.status === 'ON SUBS') v.status = 'OPEN';
      swept++;
    }
  }

  // Retro-repair: ships that reentered BEFORE quote-clearing existed can be
  // wearing a rate from their previous cycle. An offer is provably stale when
  //  · offer_updated_at predates the reopening, OR
  //  · there is NO offer_updated_at at all — every feed-applied offer since
  //    stamping existed carries one, and every manual quote stamps
  //    field_overrides; unstamped + reopened + no fresh override = pre-stamp
  //    era, i.e. older than any reopening.
  // Offer side only — bids Tyler entered post-reopen can't be dated reliably.
  const OFFER_FIELDS = ['hire_offer', 'hire_ta', 'bb_offer', 'bki_eqvt', 'p6_offer'];
  for (const v of vessels) {
    if (v.status !== 'OPEN' || !v.reopened_at) continue;
    const mc = (v.market_colour || [])[0] || {};
    const hasOffer = v.hire_offer != null || v.hire_ta != null || v.bki_eqvt != null
      || v.bb_offer != null || mc.p6_offer != null || mc.offer_usd != null;
    if (!hasOffer) continue;
    const ov = v.field_overrides || {};
    if (OFFER_FIELDS.some(f => ov[f] && ov[f] > v.reopened_at)) continue;  // fresh manual quote
    if (v.offer_updated_at && v.offer_updated_at >= v.reopened_at) continue;  // fresh feed quote
    clearQuoteResidue(v, { offerOnly: true });
    swept++;
  }
  return swept;
}

// Mark board ships FIXED from the Fixtures-tab feed. Only touches ships
// already on the board (149 rows of fixture history shouldn't flood the
// grid); never overrides FAILED or a manual status edit newer than the fix.
function markFixturesFromCSV(parsed) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const payloadNames = new Set(parsed.map(f => norm(f.vessel_name)).filter(Boolean));
  let marked = 0, already = 0, unmatched = 0, retracted = 0;
  for (const f of parsed) {
    const v = vessels.find(x => norm(x.vessel_name) === norm(f.vessel_name));
    if (!v) { unmatched++; continue; }
    if (v.status === 'FIXED') {
      // Manually-fixed ship: never overwrite anything the user set, but
      // backfill fixture details they left blank
      const fixTs0 = f.csv_updated || null;
      if (v.fixed_price == null && f.bki_eqvt != null) v.fixed_price = Math.round(f.bki_eqvt);
      if (!v.date_fixed && fixTs0) v.date_fixed = fixTs0.slice(0, 10);
      if (!v.fix_msg && (f.fix_msg || f.notes)) v.fix_msg = f.fix_msg || f.notes;
      already++;
      continue;
    }
    if (v.status === 'FAILED') continue;                    // desk judgment stands
    // A fixture row with no parseable date can't be judged fresh or stale —
    // acting on it stamps a phantom "fixed today". Skip it.
    if (!f.csv_updated) continue;
    const fixTs = f.csv_updated;
    const o = v.field_overrides || {};
    if (o.status && o.status > fixTs) continue;             // manual status is newer
    // Stale fixture guard: a ship that reopened after a Pacific round would
    // otherwise be instantly re-fixed by her OLD fixture still sitting in
    // the tab's history. A fixture dated before her current opening is
    // about the previous employment — skip it.
    const openRef = v.open_date || (v.reopened_at ? String(v.reopened_at).slice(0, 10) : null);
    if (openRef && fixTs.slice(0, 10) < openRef) continue;
    // Second guard when open_date is missing: a fixture months older than
    // the ship's current ETA is plainly the previous voyage (Darya Lachmi:
    // Apr fixture vs 25 Aug ETA)
    if (!openRef && v.eta_ecsa) {
      const gapDays = (new Date(String(v.eta_ecsa).slice(0, 10)) - new Date(fixTs.slice(0, 10))) / 86400000;
      if (gapDays > 60) continue;
    }
    v.status = 'FIXED';
    v.date_fixed = fixTs.slice(0, 10);
    if (f.bki_eqvt != null) v.fixed_price = Math.round(f.bki_eqvt);
    if (f.fix_msg || f.notes) v.fix_msg = f.fix_msg || f.notes;
    v.last_updated = fixTs;
    marked++;
  }

  // RETRACTION: a mistaken entry in the Fixtures tab gets deleted by the
  // desk — the mark it left must go too. Revert to OPEN only when ALL hold:
  //  · the fix is recent (<=14d — real fixtures are still in the tab then;
  //    only deletions aren't)
  //  · it was feed-made (no manual status override — user fixes are theirs)
  //  · the name is absent from today's fixtures payload
  //  · the ECSA grid still lists her as active (fresh csv_updated) — a real
  //    fixture drops off the grid instead
  const nowT = Date.now();
  for (const v of vessels) {
    if (v.status !== 'FIXED' || !v.date_fixed) continue;
    if ((v.field_overrides || {}).status) continue;
    if ((nowT - new Date(String(v.date_fixed).slice(0, 10)).getTime()) / 86400000 > 14) continue;
    if (payloadNames.has(norm(v.vessel_name))) continue;
    if (!v.csv_updated || (nowT - new Date(v.csv_updated).getTime()) / 86400000 > 3) continue;
    archiveFixtureResidue(v);
    v.status = 'OPEN';
    v.last_updated = new Date().toISOString();
    retracted++;
  }

  return { marked, already, unmatched, retracted };
}

// Pending withdrawal queue — populated by a CSV parse, applied by user click.
let pendingCSVWithdrawals = [];

function applyCSVWithdrawals() {
  if (!pendingCSVWithdrawals.length) return;
  const nowIso = new Date().toISOString();
  let count = 0;
  for (const c of pendingCSVWithdrawals) {
    if (c.vessel && c.vessel.status === 'OPEN') {
      c.vessel.status = 'WITHDRAWN';
      c.vessel.last_updated = nowIso;
      count++;
    }
  }
  pendingCSVWithdrawals = [];
  save();
  renderTable();
  updateStats();
  const preview = document.getElementById('previewBox');
  preview.textContent = `Confirmed: ${count} vessel(s) marked WITHDRAWN.`;
  preview.className = 'preview-box has-content';
}

function cancelCSVWithdrawals() {
  const n = pendingCSVWithdrawals.length;
  pendingCSVWithdrawals = [];
  const preview = document.getElementById('previewBox');
  preview.textContent = `Withdrawal cancelled — ${n} OPEN vessel(s) left as-is. New additions were kept.`;
  preview.className = 'preview-box has-content';
}
