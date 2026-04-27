// ─── Panamax Tonnage Parser ──────────────────────────────────────────────────
// Parses WhatsApp tonnage messages into structured vessel objects.
// Handles the wide variety of formats seen across brokers and owners.

const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  march:3,april:4,june:6,july:7};
const CURRENT_YEAR = new Date().getFullYear();

// ─── Utility Parsers ─────────────────────────────────────────────────────────

function parseRate(str, context) {
  if (!str) return null;
  const s = str.replace(/,/g, '').trim().toLowerCase();
  // "20k" → 20000, "1.5k" → 1500
  const kMatch = s.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // "1m" or "1.025m" → 1000000 / 1025000
  const mMatch = s.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
  const plain = parseFloat(s);
  if (isNaN(plain)) return null;
  // Context-aware scaling for bare numbers:
  // TC rates: bare "18" or "19.5" in market colour context → 18,000 / 19,500
  if (context === 'tc' && plain > 0 && plain < 100) return Math.round(plain * 1000);
  // BB lump sums: "975" → 975,000; "1.025" → 1,025,000
  if (context === 'bb') {
    if (plain > 0 && plain < 10) return Math.round(plain * 1000000);   // 1.025 → 1,025,000
    if (plain >= 10 && plain < 10000) return Math.round(plain * 1000); // 975 → 975,000
  }
  return plain;
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
  let tier;
  if (d <= 10) tier = '1-10';
  else if (d <= 20) tier = '11-20';
  else tier = '21+';
  return `${tier} ${months[m]}`;
}

// Chronologically-sortable key for the laycan bucket — the bucket's start date.
function laycanBucketKey(isoDate) {
  if (!isoDate) return '9999-99-99';
  const [y, m, d] = isoDate.split('-').map(Number);
  const startDay = d <= 10 ? 1 : d <= 20 ? 11 : 21;
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(startDay)}`;
}

function laycanSortKey(isoDate) {
  if (!isoDate) return '9999-99-99';
  return isoDate;
}

// ─── Vessel Line Parser ──────────────────────────────────────────────────────

function parseVesselLine(line) {
  const result = {
    source: null, owner: null, vessel_name: null, dwt: null, build_year: null,
    draft: null, scrubber: null, current_position: null, open_date: null, open_date_end: null,
    eta_ecsa: null, eta_ecsa_end: null, eta_type: null, delivery_basis: null
  };

  // "WITH BROKER" prefix: "WITH QUADRA MV ..." → source is QUADRA
  const withMatch = line.match(/^WITH\s+(\S+)\s+/i);
  if (withMatch) {
    result.source = withMatch[1].trim();
    line = line.slice(withMatch[0].length).trim();
  }

  // Find MV/MT position to help locate vessel name vs source
  const mvPos = line.search(/\bM[VT]\s/i);

  // Source/broker before " - " BUT only if the dash comes before MV,
  // or if there's no MV at all
  const dashIdx = line.indexOf(' - ');
  if (dashIdx !== -1) {
    const afterDash = line.slice(dashIdx + 3).trim();
    const mvAfterDash = /^M[VT]\s/i.test(afterDash);
    const dashIsBeforeMV = mvPos === -1 || dashIdx < mvPos;
    // It's a specs-to-port separator if: specs parens end right before dash AND no MV after dash
    const dashIsSpecsToPort = !mvAfterDash && dashIdx > 0 && /\)\s*$/.test(line.slice(0, dashIdx).trim());

    if ((dashIsBeforeMV || mvAfterDash) && !dashIsSpecsToPort) {
      // Normal: "BAUMARINE - MV SILVERMINE..." or "BAUMARINE (note) - MV SILVERMINE..."
      let src = line.slice(0, dashIdx).trim();
      const srcAnnotation = src.match(/\(([^)]+)\)/);
      if (srcAnnotation) {
        result.source_note = srcAnnotation[1].trim();
        src = src.replace(srcAnnotation[0], '').trim();
      }
      if (!result.source) result.source = src;
      line = line.slice(dashIdx + 3);
    }
  }

  // Extended specs in parens: (81'688DWT ON 14.469 BUILT 2017) or (82,225DWT ON 14.47M BUILT 2013)
  const extSpecMatch = line.match(/\((\d[\d',.]*)(?:\s*DWT)?(?:\s+ON\s+(\d+(?:\.\d+)?)(?:M)?)?\s*(?:BUILT\s+(\d{4}))?\)/i);
  if (extSpecMatch) {
    const dwtStr = extSpecMatch[1].replace(/[',]/g, '');
    const dwtRaw = parseInt(dwtStr, 10);
    if (!isNaN(dwtRaw)) result.dwt = dwtRaw < 1000 ? dwtRaw * 1000 : dwtRaw;
    if (extSpecMatch[2]) result.draft = parseFloat(extSpecMatch[2]);
    if (extSpecMatch[3]) result.build_year = parseInt(extSpecMatch[3], 10);
    line = line.replace(extSpecMatch[0], '').trim();
    // If there's a " - " right after specs, consume it
    line = line.replace(/^\s*-\s*/, '').trim();
  }

  // Standard short specs: (81/17), (82/2013), (77095/14)
  if (!result.dwt) {
    const sizeMatch = line.match(/\((\d+(?:,\d+)?)\/(\d{2,4})\)/);
    if (sizeMatch) {
      const dwtRaw = parseInt(sizeMatch[1].replace(/,/g, ''), 10);
      result.dwt = dwtRaw < 1000 ? dwtRaw * 1000 : dwtRaw;
      const yearRaw = parseInt(sizeMatch[2], 10);
      result.build_year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      line = line.replace(sizeMatch[0], '').trim();
    }
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
  // Find first colon that is NOT inside parentheses (avoid splitting on "p6:" inside parens)
  let colonIdx = -1;
  let parenDepth = 0;
  for (let ci = 0; ci < line.length && ci < 40; ci++) {
    if (line[ci] === '(') parenDepth++;
    else if (line[ci] === ')') parenDepth--;
    else if (line[ci] === ':' && parenDepth === 0) { colonIdx = ci; break; }
  }
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

  // P6 extraction — multiple formats:
  // "(p6: 16,700 vs 18k)", "(p6: 17,150)", "(p6 assuming 18,250 = 19,300)"
  // "(p6 bss 18750 offer = 18,500)"
  let p6Match = line.match(/\(\s*p6\s*(?::\s*)?([0-9k,.]+)\s+vs\s+([0-9k,.]+)\s*\)/i);
  if (p6Match) {
    // "(p6: 16,700 vs 18k)" → bid vs offer
    p6_bid = parseRate(p6Match[1].trim());
    p6_offer = parseRate(p6Match[2].trim());
    line = line.replace(p6Match[0], '').trim();
  } else {
    // Match patterns with = sign: "(p6 assuming 18,250 = 19,300)" or "(p6 bss 18750 offer = 18,500)"
    p6Match = line.match(/\(\s*p6\s*[^)]*?=\s*([0-9k,.]+)\s*(?:…|\.{3})?\s*\)/i);
    if (p6Match) {
      p6_offer = parseRate(p6Match[1].trim());
      line = line.replace(p6Match[0], '').trim();
    } else {
      // "(p6: 17,150)" — single value
      p6Match = line.match(/\(\s*p6\s*(?::\s*)?([0-9k,.]+)\s*\)/i);
      if (p6Match) {
        const val = parseRate(p6Match[1].trim());
        if (is_bid) { p6_bid = val; } else { p6_offer = val; }
        line = line.replace(p6Match[0], '').trim();
      }
    }
  }

  // TC + BB pattern: "19k + 900k" or "19,750 + 975" or "19600+1.025m"
  // Format: TC_RATE + BB_LUMPSUM [bss BASIS] [from DATE]
  const tcBbMatch = line.match(/(?:offers?\s+|was\s+|@\s*)?([0-9k,.]+)\s*\+\s*([0-9k,.m]+)/i);
  if (tcBbMatch) {
    const rate1 = parseRate(tcBbMatch[1].trim(), 'tc');
    const lump1 = parseRate(tcBbMatch[2].trim(), 'bb');

    // Check if there's a "vs" with another TC+BB pair
    const vsMatch = line.match(/vs\s+([0-9k,.]+)\s*\+\s*([0-9k,.m]+)/i);
    if (vsMatch) {
      bid_usd = rate1;
      bid_bb_usd = lump1;
      offer_usd = parseRate(vsMatch[1].trim(), 'tc');
      bb_usd = parseRate(vsMatch[2].trim(), 'bb');
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
      bid_usd = parseRate(claimsMatch[1].trim(), 'tc');
      offer_usd = parseRate(claimsMatch[2].trim(), 'tc');
    } else {
      const vsMatch2 = line.match(/(?:was\s+)?([0-9k,.]+)\s+vs\s+([0-9k,.]+)/i);
      if (vsMatch2) {
        bid_usd = parseRate(vsMatch2[1].trim(), 'tc');
        offer_usd = parseRate(vsMatch2[2].trim(), 'tc');
      }
    }
  }

  // "Ideas 21,500", "Rating 21500", "thinking 18 in front" — single offer
  if (!offer_usd && !bid_usd) {
    const ideasMatch = line.match(/\b(?:ideas?|thinking|loosely\s+thinking|rating)\s+([0-9k,.]+)/i);
    if (ideasMatch) {
      is_idea = true;
      offer_usd = parseRate(ideasMatch[1].trim(), 'tc');
    }
  }

  // Route from "ECSA OPT NCSA/FEAST" or similar trailing route preferences
  if (!route) {
    const routeTrail = line.match(/\b(ECSA|USG|NCSA)\b.*?\b(OPT|FH|TA|FEAST)\b/i);
    if (routeTrail) {
      const rt = routeTrail[0].toUpperCase();
      if (rt.includes('ECSA')) route = rt.includes('TA') ? 'ECSA TA' : 'ECSA FH';
      else if (rt.includes('USG')) route = rt.includes('TA') ? 'USG TA' : 'USG FH';
      else if (rt.includes('NCSA')) route = 'NCSA FH';
    }
  }

  // "Offers 19750+975" already handled above
  // "Offers X" single rate
  if (!offer_usd && !tcBbMatch) {
    const offersMatch = line.match(/\boffers?\s+([0-9k,.]+)/i);
    if (offersMatch) {
      offer_usd = parseRate(offersMatch[1].trim(), 'tc');
    }
  }

  // "@ 19k" for bid lines
  if (is_bid && !bid_usd && !tcBbMatch) {
    const atMatch = line.match(/@\s*([0-9k,.]+)/i);
    if (atMatch) {
      bid_usd = parseRate(atMatch[1].trim(), 'tc');
    }
  }

  // "Collecting" or "rvtng ideas" = early stage, no rates (handle truncated "collec")
  const collecting = /\b(collect(ing)?|rvtng|reverting)\b/i.test(line);

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
  if (/\bON\s+SUBS\b/i.test(text)) return 'FIXED';
  if (/\bOFF[\s-]?MKT\b|\bOFF[\s-]?MARKET\b/i.test(text)) return 'WITHDRAWN';
  if (/\bFIXED\b/i.test(text)) return 'FIXED';
  if (/\bFAILED\b/i.test(text)) return 'FAILED';
  if (/\bEX[\s-]?OUR[\s-]?CP\b/i.test(text)) return 'WITHDRAWN';
  return 'OPEN';
}

// ─── Pre-processor: normalize single-line messages into multi-line ───────────

function preprocessMessage(rawText) {
  // Split on "---", "----", "-----" etc. (3+ dashes) to create separate lines
  let text = rawText.replace(/-{3,}/g, '\n');

  // Extract inline (BOD ...) from vessel line and put on its own line
  // Matches: (BOD BSS SANTOS: ABT 700/140) or (BOD: 784/112) etc.
  text = text.replace(/\(BOD\b([^)]*)\)/gi, (match, inner) => {
    return '\nBOD' + inner;
  });

  return text;
}

// ─── Main Message Parser ─────────────────────────────────────────────────────

function parseTonnageMessage(rawText) {
  const processed = preprocessMessage(rawText);
  const lines = processed.split('\n').map(l => l.trim()).filter(Boolean);

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

  // For cargo bids: first line is cargo description, not a vessel line.
  // Parse vessel info from the bid line instead.
  if (isCargoBid) {
    // Parse first line as cargo context (source + route + laycan)
    const firstLine = lines[0] || '';
    const dashIdx = firstLine.indexOf(' - ');
    if (dashIdx !== -1) {
      vessel.source = firstLine.slice(0, dashIdx).trim();
    }
    // Extract route from first line
    const routePatterns = ['ECSA FH', 'ECSA TA', 'USG FH', 'USG TA', 'NCSA FH'];
    for (const rp of routePatterns) {
      if (firstLine.toUpperCase().includes(rp)) {
        vessel.notes = `Cargo bid: ${firstLine}`;
        break;
      }
    }
    if (!vessel.notes) vessel.notes = `Cargo bid: ${firstLine}`;

    // Extract ETA/laycan from first line if present
    const etaFromCargo = firstLine.match(/(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\s*(onw)?/i);
    if (etaFromCargo) {
      vessel.eta_ecsa = parseDate(etaFromCargo[1]);
      vessel.eta_type = etaFromCargo[2] ? 'ONW' : 'EXACT';
    }

    // Now parse remaining lines for bid info + vessel details
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (/\bbid(ding)?\b/i.test(line)) {
        // Extract vessel name + specs from bid line: "MV Navios Victory (77/14)"
        const mvMatch = line.match(/M[VT]\s+(.+?)\s*\((\d+)\/(\d{2,4})\)/i);
        if (mvMatch) {
          vessel.vessel_name = mvMatch[1].trim();
          const dwtRaw = parseInt(mvMatch[2], 10);
          vessel.dwt = dwtRaw < 1000 ? dwtRaw * 1000 : dwtRaw;
          const yearRaw = parseInt(mvMatch[3], 10);
          vessel.build_year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
        }
        const mc = parseMarketColourLine(line);
        mc.is_bid = true;
        if (!mc.route) {
          for (const rp of routePatterns) {
            if (firstLine.toUpperCase().includes(rp)) { mc.route = rp; break; }
          }
        }
        vessel.market_colour.push(mc);
      }
    }
  } else {
    // Standard vessel message parsing
    for (let line of lines) {
      // Strip wrapping parentheses: "(BOD BSS SANTOS: ABT 700/140)" → "BOD BSS SANTOS: ABT 700/140"
      const stripped = line.replace(/^\((.+)\)$/, '$1').trim();

      // BOD line
      if (/^BOD\b/i.test(stripped) || /\bBOD\b.*\d+.*\/.*\d+/i.test(stripped)) {
        const bod = parseBODLine(stripped);
        Object.assign(vessel, bod);
        continue;
      }

      // Skip section headers like "//remain//", "//new//"
      if (/^\/\/\w+\/\/$/.test(line)) continue;

      // Rate lines starting with "-$" (e.g. "-$20k fr ecsa fh")
      if (/^\s*-\$\d/i.test(line)) {
        const rateMatch = line.match(/\$([0-9k,.]+)/i);
        if (rateMatch) {
          const route = /ecsa\s*fh|fh/i.test(line) ? 'ECSA FH' : /safr|sa\b/i.test(line) ? 'SAFR' : /ecsa/i.test(line) ? 'ECSA FH' : null;
          const rate = parseRate(rateMatch[1], 'tc');
          if (rate) {
            vessel.market_colour.push({ route, bid_usd: null, offer_usd: rate, bb_usd: null, bid_bb_usd: null, bid_multiple_claims: false, p6_bid: null, p6_offer: null, delivery_basis: null, offer_date: null, is_bid: false, is_idea: true, collecting: false, notes: line.trim() });
          }
        }
        continue;
      }

      // Standalone ETA line: "ETA RBAY 10APR / ETA SANTOS 26APR" or "ETA SANTOS 26APR"
      if (/^ETA\b/i.test(line) && !vessel.eta_ecsa) {
        // Try to find the last ETA date (rightmost = final destination ETA)
        const etaMatches = [...line.matchAll(/ETA\s+(?:\w+\s+)?(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)/gi)];
        if (etaMatches.length > 0) {
          const lastEta = etaMatches[etaMatches.length - 1];
          vessel.eta_ecsa = parseDate(lastEta[1]);
          vessel.eta_type = /\bonw\b/i.test(line) ? 'ONW' : 'EXACT';
        }
        // Also try compressed format: "10APR"
        if (!vessel.eta_ecsa) {
          const compressed = [...line.matchAll(/(\d{1,2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi)];
          if (compressed.length > 0) {
            const last = compressed[compressed.length - 1];
            vessel.eta_ecsa = parseDate(last[1] + ' ' + last[2]);
            vessel.eta_type = /\bonw\b/i.test(line) ? 'ONW' : 'EXACT';
          }
        }
        continue;
      }

      // "SLD DAHEJ 27MAR" = sailed from port on date
      if (/^SLD\b/i.test(line)) {
        const sldMatch = line.match(/^SLD\s+(\w+)\s+(\d{1,2})\s*([a-z]+)/i);
        if (sldMatch) {
          vessel.current_position = sldMatch[1].toUpperCase();
          vessel.open_date = parseDate(sldMatch[2] + ' ' + sldMatch[3]);
        }
        continue;
      }

      // Market colour / rate lines
      if (/^=/.test(line) || /claims\s+seeing/i.test(line) || /\b(loosely\s+)?thinking\b/i.test(line)
          || /^\s*ideas?\b/i.test(line) || /^\s*offers?\s+\d/i.test(line) || /^\s*on\s+subs\b/i.test(line)
          || /^\s*last\s+offered\b/i.test(line) || /^\s*pref\b/i.test(line) || /^\s*collecting\b/i.test(line)
          || /^\s*rating\b/i.test(line)) {
        const mc = parseMarketColourLine(line);
        if (mc.route || mc.bid_usd || mc.offer_usd || mc.p6_bid || mc.p6_offer || mc.collecting) {
          vessel.market_colour.push(mc);
          if (mc.bb_usd && !vessel.bb_offer) vessel.bb_offer = mc.bb_usd;
        }
        continue;
      }

      // Status lines: "OFF-MKT & EX-OUR CP", "FIXED KOCH..."
      if (/\bOFF[\s-]?MKT\b|\bEX[\s-]?OUR[\s-]?CP\b|\bFIXED\b|\bFAILED\b|\bWITHDRAWN\b/i.test(line) && vessel.vessel_name) {
        const statusNotes = line.replace(/\bOFF[\s-]?MKT\b|\bEX[\s-]?OUR[\s-]?CP\b/gi, '').replace(/[&]/g, '').trim();
        if (statusNotes) {
          vessel.notes = vessel.notes ? vessel.notes + '; ' + statusNotes : statusNotes;
        }
        continue;
      }

      // Line starting with "MV" — vessel line (possibly with owner already set from previous line)
      if (/^M[VT]\s/i.test(line) && !vessel.vessel_name) {
        if (vessel.source && !vessel.owner) vessel.owner = vessel.source;
        // Try to extract DWT in comma format: "82,311/2014"
        const commaSpec = line.match(/(\d{1,3}(?:,\d{3})+)\/(\d{4})/);
        if (commaSpec) {
          vessel.dwt = parseInt(commaSpec[1].replace(/,/g, ''), 10);
          vessel.build_year = parseInt(commaSpec[2], 10);
          line = line.replace(commaSpec[0], '').trim();
        }
        // Check for scrubber
        if (/\bscrubber\b/i.test(line)) vessel.scrubber = true;
        // Extract vessel name (after MV, before specs)
        const nameMatch = line.match(/^M[VT]\s+(.+?)(?:\s+\d|\s*\(|\s*$)/i);
        if (nameMatch) vessel.vessel_name = nameMatch[1].trim();
        else {
          const simpleName = line.replace(/^M[VT]\s+/i, '').replace(/\(.*\)/, '').trim();
          vessel.vessel_name = simpleName || null;
        }
        // Check for SLD (sailed) inline
        const sldInline = line.match(/\bSLD\s+(\w+)\s+(\d{1,2})\s*([a-z]+)/i);
        if (sldInline) {
          vessel.current_position = sldInline[1].toUpperCase();
          vessel.open_date = parseDate(sldInline[2] + ' ' + sldInline[3]);
        }
        continue;
      }

      // First unmatched line = vessel line (or owner if no MV)
      if (!vessel.vessel_name && !vessel.source) {
        // Look ahead: if this line has no MV/specs and the NEXT line starts with MV,
        // treat this as an owner name, not a vessel line
        const nextLines = lines.slice(lines.indexOf(line) + 1);
        const nextHasMV = nextLines.some(l => /^M[VT]\s/i.test(l));
        const thisHasMV = /\bM[VT]\s/i.test(line);
        const thisHasSpecs = /\(\d+[,']?\d*\/\d{2,4}\)/.test(line) || /\d{2,3}[,']\d{3}\/\d{4}/.test(line);

        if (!thisHasMV && !thisHasSpecs && nextHasMV) {
          // This is just an owner/source name
          vessel.source = line.trim();
          vessel.owner = line.trim();
        } else {
          Object.assign(vessel, parseVesselLine(line));
        }
        continue;
      }

      // Owner-only line (short, all caps, no MV) — if we don't have owner yet
      if (!vessel.owner && line.trim().split(/\s+/).length <= 3 && /^[A-Z\s]+$/.test(line.trim())) {
        vessel.owner = line.trim();
        continue;
      }

      vessel.parse_warnings.push(`Unmatched line: "${line}"`);
    }
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
  // Split on blank lines, but rejoin chunks that are continuations
  const rawChunks = rawBlock.split(/\n{2,}/).map(m => m.trim()).filter(Boolean);
  const messages = [];
  for (const chunk of rawChunks) {
    const firstLine = chunk.split('\n')[0].trim();

    // Skip section headers like "//remain//", "//new//", "//update//"
    if (/^\/\/\w+\/\/$/.test(firstLine) && chunk.split('\n').length === 1) {
      // Standalone header — treat rate lines after it as context for next message
      continue;
    }

    // If this chunk starts with a continuation pattern, append to previous
    if (messages.length > 0 && /^[=(]|^BOD\b|^on\s+subs\b|^off[\s-]?mkt\b|^fixed\b|^failed\b|^-\$/i.test(firstLine)) {
      messages[messages.length - 1] += '\n' + chunk;
    }
    // If this chunk starts with MV/MT (vessel line) and previous has no vessel yet, join
    else if (messages.length > 0 && /^M[VT]\s/i.test(firstLine)) {
      messages[messages.length - 1] += '\n' + chunk;
    }
    // If this chunk starts with ETA and previous exists, join
    else if (messages.length > 0 && /^ETA\b/i.test(firstLine)) {
      messages[messages.length - 1] += '\n' + chunk;
    }
    else {
      messages.push(chunk);
    }
  }

  // Filter out messages that are just section headers with rate context
  return messages
    .filter(m => {
      const lines = m.split('\n').map(l => l.trim()).filter(Boolean);
      // Must have at least one line with MV or vessel-like content
      return lines.some(l => /\bM[VT]\s/i.test(l) || /\(\d+[,']\d*\/?\d+\)/.test(l) || /\d+[,']?\d*\/\d{2,4}/.test(l));
    })
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
