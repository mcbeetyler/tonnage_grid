// ─── Panamax Tonnage Parser ──────────────────────────────────────────────────
// Parses WhatsApp tonnage messages into structured vessel objects.
// Handles the wide variety of formats seen across brokers and owners.

const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  march:3,april:4,june:6,july:7};
const CURRENT_YEAR = new Date().getFullYear();

// ─── Utility Parsers ─────────────────────────────────────────────────────────

function parseRate(str) {
  if (!str) return null;
  const s = str.replace(/,/g, '').trim().toLowerCase();
  // "20k" → 20000, "1.5k" → 1500
  const kMatch = s.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // "1m" or "1.025m" → 1000000 / 1025000
  const mMatch = s.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
  const plain = parseFloat(s);
  return isNaN(plain) ? null : plain;
}

function parseDate(str) {
  if (!str) return null;
  const clean = str.trim().toLowerCase().replace(/[.,]/g, '');
  // Handle "19 MAR", "31 MARCH", "15 APR 2026"
  const match = clean.match(/(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const monthStr = match[2].slice(0, 3);
  const month = MONTH_MAP[monthStr] || MONTH_MAP[match[2]];
  const year = match[3] ? parseInt(match[3], 10) : CURRENT_YEAR;
  if (!month || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Parse range dates like "10-15 APR", "8-9 APR", "16-18 APR"
// Returns { earliest: "2026-04-10", latest: "2026-04-15" }
function parseDateRange(str) {
  if (!str) return null;
  const clean = str.trim().toLowerCase().replace(/[.,]/g, '');
  // "10-15 apr" or "8-9 apr"
  const rangeMatch = clean.match(/(\d{1,2})\s*[-\/]\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/);
  if (rangeMatch) {
    const day1 = parseInt(rangeMatch[1], 10);
    const day2 = parseInt(rangeMatch[2], 10);
    const monthStr = rangeMatch[3].slice(0, 3);
    const month = MONTH_MAP[monthStr] || MONTH_MAP[rangeMatch[3]];
    const year = rangeMatch[4] ? parseInt(rangeMatch[4], 10) : CURRENT_YEAR;
    if (!month) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return {
      earliest: `${year}-${pad(month)}-${pad(day1)}`,
      latest: `${year}-${pad(month)}-${pad(day2)}`
    };
  }
  // Single date fallback
  const single = parseDate(str);
  if (single) return { earliest: single, latest: single };
  return null;
}

function detectScrubber(text) {
  if (/\bscr(ubber)?\b|\+s\b/i.test(text)) return true;
  return null;
}

// ─── Laycan Period Helpers ───────────────────────────────────────────────────

function getLaycanPeriod(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const half = d <= 15 ? 'FH' : 'LH';
  return `${half} ${months[m]}`;
}

function laycanSortKey(isoDate) {
  if (!isoDate) return '9999-99-99';
  return isoDate;
}

// ─── Vessel Line Parser ──────────────────────────────────────────────────────

function parseVesselLine(line) {
  const result = {
    source: null, owner: null, vessel_name: null, dwt: null, build_year: null,
    scrubber: null, current_position: null, open_date: null, open_date_end: null,
    eta_ecsa: null, eta_ecsa_end: null, eta_type: null, delivery_basis: null
  };

  // Source/broker before " - "
  const dashIdx = line.indexOf(' - ');
  if (dashIdx !== -1) {
    result.source = line.slice(0, dashIdx).trim();
    line = line.slice(dashIdx + 3);
  }

  // DWT/year in parens: (81/17), (82/2013), (77095/14)
  const sizeMatch = line.match(/\((\d+(?:,\d+)?)\/(\d{2,4})\)/);
  if (sizeMatch) {
    const dwtRaw = parseInt(sizeMatch[1].replace(/,/g, ''), 10);
    result.dwt = dwtRaw < 1000 ? dwtRaw * 1000 : dwtRaw;
    const yearRaw = parseInt(sizeMatch[2], 10);
    result.build_year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    line = line.replace(sizeMatch[0], '').trim();
  }

  // Scrubber detection
  result.scrubber = detectScrubber(line);
  line = line.replace(/\bscr(ubber)?\b|\+s\b/gi, '').trim();

  // ETA extraction: "/ ETA 25 APR ONW" or "/ ETA ECSA 11 MAY ONW" or "/ ETA SANTOS 13 APR"
  const etaMatch = line.match(/\/\s*ETA\s+(?:(?:ECSA|SANTOS|PARANAGUA|TUBARAO)\s+)?(.+)$/i);
  if (etaMatch) {
    const etaStr = etaMatch[1].trim();
    const onw = /\bonw\b/i.test(etaStr);
    result.eta_type = onw ? 'ONW' : 'EXACT';
    const cleanEta = etaStr.replace(/\bonw\b/gi, '').trim();
    const dateRange = parseDateRange(cleanEta);
    if (dateRange) {
      result.eta_ecsa = dateRange.earliest;
      result.eta_ecsa_end = dateRange.latest !== dateRange.earliest ? dateRange.latest : null;
    }
    line = line.slice(0, line.search(/\/\s*ETA/i)).trim();
  }

  // Remove MV/MT prefix (handle "MVNavios" with no space too)
  line = line.replace(/^M[VT]\s*/i, '').trim();

  // Delivery basis: APS ECSA, APS SANTOS, DLOSP, SANTOS, PARANAGUA etc.
  const deliveryMatch = line.match(/\b(APS\s+\w+|DLOSP|PASSING\s+\w+)\b/i);
  if (deliveryMatch) {
    result.delivery_basis = deliveryMatch[1].toUpperCase();
    line = line.replace(deliveryMatch[0], '').replace(/\s{2,}/g, ' ').trim();
  }

  // Open date (possibly range): "GANGAVARAM 19 MAR", "PARADIP 10-15 APR"
  const rangeDatePattern = /(\d{1,2}\s*[-\/]\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)/gi;
  const singleDatePattern = /(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)/gi;

  let dateMatches = [...line.matchAll(rangeDatePattern)];
  if (dateMatches.length > 0) {
    const lastDate = dateMatches[dateMatches.length - 1];
    const range = parseDateRange(lastDate[0]);
    if (range) {
      result.open_date = range.earliest;
      result.open_date_end = range.latest !== range.earliest ? range.latest : null;
    }
    const beforeDate = line.slice(0, lastDate.index).trim();
    const parts = beforeDate.split(/\s+/).filter(Boolean);
    if (parts.length >= 1) {
      result.current_position = parts[parts.length - 1];
      result.vessel_name = parts.slice(0, parts.length - 1).join(' ') || beforeDate;
    }
  } else {
    dateMatches = [...line.matchAll(singleDatePattern)];
    if (dateMatches.length > 0) {
      const lastDate = dateMatches[dateMatches.length - 1];
      result.open_date = parseDate(lastDate[0]);
      const beforeDate = line.slice(0, lastDate.index).trim();
      const parts = beforeDate.split(/\s+/).filter(Boolean);
      if (parts.length >= 1) {
        result.current_position = parts[parts.length - 1];
        result.vessel_name = parts.slice(0, parts.length - 1).join(' ') || beforeDate;
      }
    } else {
      // No date found — try to extract port from end
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 1 && /^[A-Z]+$/.test(parts[parts.length - 1]) && parts[parts.length - 1].length <= 12) {
        // Check if last word looks like a port/delivery
        const lastWord = parts[parts.length - 1];
        const knownPorts = ['SANTOS', 'PARANAGUA', 'TUBARAO', 'SINGAPORE', 'GOA', 'HALDIA', 'GANGAVARAM', 'PARADIP', 'ENNORE', 'HAZIRA', 'MUNDRA', 'KANDLA'];
        if (knownPorts.includes(lastWord)) {
          result.current_position = lastWord;
          result.vessel_name = parts.slice(0, parts.length - 1).join(' ');
        } else {
          result.vessel_name = line.trim() || null;
        }
      } else {
        result.vessel_name = line.trim() || null;
      }
    }
  }

  // Clean vessel name
  if (result.vessel_name) {
    result.vessel_name = result.vessel_name.replace(/^\s*[-/]\s*|\s*[-/]\s*$/g, '').trim();
    // If delivery_basis wasn't caught earlier but vessel name ends with port
    if (!result.delivery_basis && result.current_position) {
      const port = result.current_position.toUpperCase();
      if (['SANTOS', 'PARANAGUA'].includes(port)) {
        result.delivery_basis = port;
      }
    }
  }

  return result;
}

// ─── BOD Line Parser ─────────────────────────────────────────────────────────

function parseBODLine(line) {
  const result = { bod_ifo: null, bod_mdo: null, bod_basis: null, bod_fuel_type: null };

  // Extract basis: "BSS SANTOS", "BSS ENNORE", "bss Santos"
  const basisMatch = line.match(/\bbss\s+([A-Za-z]+)/i);
  if (basisMatch) {
    result.bod_basis = basisMatch[1].toUpperCase();
  }

  // Detect fuel type: LSFO/LSMGO vs IFO/MDO (default)
  if (/\bLSFO\b/i.test(line)) {
    result.bod_fuel_type = 'LSFO/LSMGO';
  }

  // Handle ranges: "1400-1500 / 180-200" → take midpoint
  const rangeMatch = line.match(/(\d+(?:,\d+)?)\s*[-–]\s*(\d+(?:,\d+)?)\s*\/\s*(\d+(?:,\d+)?)\s*[-–]\s*(\d+(?:,\d+)?)/);
  if (rangeMatch) {
    const v1 = parseFloat(rangeMatch[1].replace(/,/g, ''));
    const v2 = parseFloat(rangeMatch[2].replace(/,/g, ''));
    const v3 = parseFloat(rangeMatch[3].replace(/,/g, ''));
    const v4 = parseFloat(rangeMatch[4].replace(/,/g, ''));
    result.bod_ifo = Math.round((v1 + v2) / 2);
    result.bod_mdo = Math.round((v3 + v4) / 2);
    return result;
  }

  // Handle fuel-type prefix: "LSFO 670 / LSMGO 185"
  const fuelMatch = line.match(/(?:LSFO|IFO|HFO)?\s*(\d+(?:,\d+)?(?:\.\d+)?)\s*\/\s*(?:LSMGO|MDO|MGO)?\s*(\d+(?:,\d+)?(?:\.\d+)?)/i);
  if (fuelMatch) {
    result.bod_ifo = parseFloat(fuelMatch[1].replace(/,/g, ''));
    result.bod_mdo = parseFloat(fuelMatch[2].replace(/,/g, ''));
    return result;
  }

  // Standard: "BOD ABT 1250/240"
  const stdMatch = line.match(/(\d+(?:,\d+)?(?:\.\d+)?)\s*\/\s*(\d+(?:,\d+)?(?:\.\d+)?)/);
  if (stdMatch) {
    result.bod_ifo = parseFloat(stdMatch[1].replace(/,/g, ''));
    result.bod_mdo = parseFloat(stdMatch[2].replace(/,/g, ''));
  }

  return result;
}

// ─── Market Colour Line Parser ───────────────────────────────────────────────

function parseMarketColourLine(line) {
  line = line.replace(/^[=\s]+/, '').trim();

  let route = null;
  let bid_usd = null;
  let offer_usd = null;
  let bb_usd = null;
  let bid_bb_usd = null;
  let bid_multiple_claims = false;
  let p6_bid = null;
  let p6_offer = null;
  let delivery_basis = null;
  let offer_date = null;
  let is_bid = false;
  let is_idea = false;
  let notes = null;

  // Detect if this is a bid line: "Bidding here MV XXX @ 19k..."
  if (/\bbid(ding|s)?\b/i.test(line)) {
    is_bid = true;
  }

  // Route detection: "ECSA FH:", "Friday:" (day = timing note), "Pref ECSA FH"
  const colonIdx = line.indexOf(':');
  if (colonIdx !== -1 && colonIdx < 30) {
    const beforeColon = line.slice(0, colonIdx).trim().toUpperCase();
    // Check if it's a known route or timing reference
    const routePatterns = ['ECSA FH', 'ECSA TA', 'USG FH', 'USG TA', 'NCSA FH', 'USEC TA', 'WAFR', 'BSEA', 'MED'];
    const matchedRoute = routePatterns.find(r => beforeColon.includes(r));
    if (matchedRoute) {
      route = matchedRoute;
    } else if (/PREF/i.test(beforeColon)) {
      const prefRoute = routePatterns.find(r => beforeColon.includes(r));
      if (prefRoute) route = prefRoute;
    }
    // Keep non-route prefix as timing note
    if (!route && /^(MON|TUE|WED|THU|FRI|SAT|SUN|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)/i.test(beforeColon)) {
      notes = `(${line.slice(0, colonIdx).trim()})`;
    }
    line = line.slice(colonIdx + 1).trim();
  }

  // "Pref ECSA FH" without colon
  if (!route) {
    const prefMatch = line.match(/\bpref\s+(ECSA\s+FH|ECSA\s+TA|USG\s+FH)/i);
    if (prefMatch) route = prefMatch[1].toUpperCase();
  }

  // Default route for ECSA-related content
  if (!route && /\b(ECSA|Santos|Paranagua|China|Qingdao)\b/i.test(line)) {
    route = 'ECSA FH';
  }

  // "multiple times"
  bid_multiple_claims = /multiple\s+times/i.test(line);

  // P6 extraction: "(p6: 16,700 vs 18k)" or "(p6: 17,150)" or "(p6 assuming 18,250 = 19,300)"
  const p6Match = line.match(/\(\s*p6\s*(?:assuming\s+)?(?::\s*)?([0-9k,.\s]+?)(?:\s*[=]\s*([0-9k,.\s]+?))?\s*(?:\s+vs\s+([0-9k,.\s]+?))?\s*(?:…|\.{3})?\s*\)/i);
  if (p6Match) {
    if (p6Match[3]) {
      // "(p6: 16,700 vs 18k)" → bid vs offer
      p6_bid = parseRate(p6Match[1].trim());
      p6_offer = parseRate(p6Match[3].trim());
    } else if (p6Match[2]) {
      // "(p6 assuming 18,250 = 19,300)" → the = value is the p6 equiv
      p6_offer = parseRate(p6Match[2].trim());
    } else if (p6Match[1]) {
      // "(p6: 17,150)" → single value, context determines bid or offer
      const val = parseRate(p6Match[1].trim());
      if (is_bid) {
        p6_bid = val;
      } else {
        p6_offer = val;
      }
    }
    line = line.replace(p6Match[0], '').trim();
  }

  // TC + BB pattern: "19k + 900k" or "19,750 + 975" or "19600+1.025m"
  // Format: TC_RATE + BB_LUMPSUM [bss BASIS] [from DATE]
  const tcBbMatch = line.match(/(?:offers?\s+|was\s+|@\s*)?([0-9k,.]+)\s*\+\s*([0-9k,.m]+)/i);
  if (tcBbMatch) {
    const rate1 = parseRate(tcBbMatch[1].trim());
    const lump1 = parseRate(tcBbMatch[2].trim());

    // Check if there's a "vs" with another TC+BB pair
    const vsMatch = line.match(/vs\s+([0-9k,.]+)\s*\+\s*([0-9k,.m]+)/i);
    if (vsMatch) {
      bid_usd = rate1;
      bid_bb_usd = lump1;
      offer_usd = parseRate(vsMatch[1].trim());
      bb_usd = parseRate(vsMatch[2].trim());
    } else if (is_bid) {
      bid_usd = rate1;
      bid_bb_usd = lump1;
    } else {
      offer_usd = rate1;
      bb_usd = lump1;
    }
  }

  // Delivery basis from offer line: "bss APS Santos", "bss 15th April"
  const bssMatch = line.match(/\bbss\s+(APS\s+\w+|\w+)/i);
  if (bssMatch) {
    const bssVal = bssMatch[1].trim();
    // Check if it's a date reference
    if (!/\d/.test(bssVal)) {
      delivery_basis = bssVal.toUpperCase();
    }
  }

  // Date from offer: "from 21st", "bss 15th April", "bss 21 April onw"
  const fromMatch = line.match(/(?:from|bss)\s+(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]*)/i);
  if (fromMatch && fromMatch[2]) {
    offer_date = parseDate(`${fromMatch[1]} ${fromMatch[2]}`);
  }

  // Standard "claims seeing X vs Y" or just "X vs Y"
  if (!tcBbMatch) {
    const claimsMatch = line.match(/claims\s+seeing\s+([0-9k,.\s]+?)(?:\s+multiple\s+times)?\s+vs\s+([0-9k,.\s]+)/i);
    if (claimsMatch) {
      bid_usd = parseRate(claimsMatch[1].trim());
      offer_usd = parseRate(claimsMatch[2].trim());
    } else {
      const vsMatch2 = line.match(/(?:was\s+)?([0-9k,.]+)\s+vs\s+([0-9k,.]+)/i);
      if (vsMatch2) {
        bid_usd = parseRate(vsMatch2[1].trim());
        offer_usd = parseRate(vsMatch2[2].trim());
      }
    }
  }

  // "Ideas 21,500" or "Ideas X" — single offer
  if (!offer_usd && !bid_usd) {
    const ideasMatch = line.match(/\b(?:ideas?|thinking|loosely\s+thinking)\s+([0-9k,.]+)/i);
    if (ideasMatch) {
      is_idea = true;
      offer_usd = parseRate(ideasMatch[1].trim());
    }
  }

  // "Offers 19750+975" already handled above
  // "Offers X" single rate
  if (!offer_usd && !tcBbMatch) {
    const offersMatch = line.match(/\boffers?\s+([0-9k,.]+)/i);
    if (offersMatch) {
      offer_usd = parseRate(offersMatch[1].trim());
    }
  }

  // "@ 19k" for bid lines
  if (is_bid && !bid_usd && !tcBbMatch) {
    const atMatch = line.match(/@\s*([0-9k,.]+)/i);
    if (atMatch) {
      bid_usd = parseRate(atMatch[1].trim());
    }
  }

  // "Collecting" or "rvtng ideas" = early stage, no rates
  const collecting = /\b(collecting|rvtng|reverting)\b/i.test(line);

  return {
    route,
    bid_usd,
    offer_usd,
    bb_usd,
    bid_bb_usd,
    bid_multiple_claims,
    p6_bid,
    p6_offer,
    delivery_basis,
    offer_date,
    is_bid,
    is_idea,
    collecting,
    notes
  };
}

// ─── Status Detection ────────────────────────────────────────────────────────

function detectStatus(lines) {
  const text = lines.join(' ').toUpperCase();
  if (/\bOFF[\s-]?MKT\b|\bOFF[\s-]?MARKET\b/i.test(text)) return 'WITHDRAWN';
  if (/\bFIXED\b/i.test(text)) return 'FIXED';
  if (/\bFAILED\b/i.test(text)) return 'FAILED';
  if (/\bEX[\s-]?OUR[\s-]?CP\b/i.test(text)) return 'WITHDRAWN';
  return 'OPEN';
}

// ─── Main Message Parser ─────────────────────────────────────────────────────

function parseTonnageMessage(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  const vessel = {
    source: null, owner: null, vessel_name: null, dwt: null, build_year: null,
    scrubber: null, current_position: null, open_date: null, open_date_end: null,
    eta_ecsa: null, eta_ecsa_end: null, eta_type: null, delivery_basis: null,
    bod_ifo: null, bod_mdo: null, bod_basis: null, bod_fuel_type: null,
    market_colour: [],
    tc_offer: null, bb_offer: null,
    status: 'OPEN',
    fixed_route: null, fixed_rate_p6: null, fixed_at: null,
    notes: null,
    raw: rawText,
    parsed_at: new Date().toISOString(),
    parse_warnings: []
  };

  // Detect overall status from the full message
  vessel.status = detectStatus(lines);

  // Check if this is a cargo-side bid (different structure)
  const isCargoBid = /\bbid(ding)?\s+(here|on)\b/i.test(rawText);

  for (const line of lines) {
    // BOD line
    if (/^BOD\b/i.test(line) || /\bBOD\b.*\d+.*\/.*\d+/i.test(line)) {
      const bod = parseBODLine(line);
      Object.assign(vessel, bod);
      continue;
    }

    // Market colour / rate lines (start with = or contain "claims seeing", "offers", "ideas", "bidding")
    if (/^=/.test(line) || /claims\s+seeing/i.test(line) || /\b(loosely\s+)?thinking\b/i.test(line)) {
      const mc = parseMarketColourLine(line);
      if (mc.route || mc.bid_usd || mc.offer_usd || mc.p6_bid || mc.p6_offer || mc.collecting) {
        vessel.market_colour.push(mc);
        // Capture BB offer at vessel level
        if (mc.bb_usd && !vessel.bb_offer) vessel.bb_offer = mc.bb_usd;
      }
      continue;
    }

    // Status lines: "OFF-MKT & EX-OUR CP", "FIXED KOCH..."
    if (/\bOFF[\s-]?MKT\b|\bEX[\s-]?OUR[\s-]?CP\b|\bFIXED\b|\bFAILED\b|\bWITHDRAWN\b/i.test(line) && vessel.vessel_name) {
      // Extract notes from the status line
      const statusNotes = line.replace(/\bOFF[\s-]?MKT\b|\bEX[\s-]?OUR[\s-]?CP\b/gi, '').replace(/[&]/g, '').trim();
      if (statusNotes) {
        vessel.notes = vessel.notes ? vessel.notes + '; ' + statusNotes : statusNotes;
      }
      continue;
    }

    // Cargo-side bid line with vessel reference
    if (isCargoBid && /\bbid(ding)?\b/i.test(line)) {
      const mc = parseMarketColourLine(line);
      if (mc.route || mc.bid_usd || mc.p6_bid) {
        mc.is_bid = true;
        vessel.market_colour.push(mc);
      }
      // Try to extract vessel name from bid line if not yet parsed
      if (!vessel.vessel_name) {
        const mvMatch = line.match(/M[VT]\s+(.+?)\s*\(/);
        if (mvMatch) vessel.vessel_name = mvMatch[1].trim();
      }
      continue;
    }

    // First unmatched line = vessel line
    if (!vessel.vessel_name && !vessel.source) {
      const parsed = parseVesselLine(line);
      Object.assign(vessel, parsed);

      // For cargo-side bids, the source before " - " is the cargo interest, not vessel owner
      if (isCargoBid) {
        vessel.notes = vessel.notes
          ? vessel.notes + '; Cargo bid from ' + (vessel.source || 'unknown')
          : 'Cargo bid from ' + (vessel.source || 'unknown');
      }
      continue;
    }

    // Additional info lines
    vessel.parse_warnings.push(`Unmatched line: "${line}"`);
  }

  // Collect delivery basis from market colour if vessel level is empty
  if (!vessel.delivery_basis) {
    for (const mc of vessel.market_colour) {
      if (mc.delivery_basis) {
        vessel.delivery_basis = mc.delivery_basis;
        break;
      }
    }
  }

  // Validation warnings
  if (!vessel.vessel_name) vessel.parse_warnings.push('Could not extract vessel name');
  if (!vessel.eta_ecsa) vessel.parse_warnings.push('No ETA extracted');
  if (vessel.market_colour.length === 0) vessel.parse_warnings.push('No market colour parsed');

  return vessel;
}

function parseMultipleMessages(rawBlock) {
  return rawBlock
    .split(/\n{2,}/)
    .map(m => m.trim())
    .filter(Boolean)
    .map(parseTonnageMessage);
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseRate, parseDate, parseDateRange, detectScrubber, getLaycanPeriod,
    laycanSortKey, parseVesselLine, parseBODLine, parseMarketColourLine,
    parseTonnageMessage, parseMultipleMessages
  };
}
