import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PARSE_SYSTEM_PROMPT = `You are a dry bulk shipping message parser. Extract vessel tonnage data from WhatsApp messages into structured JSON.

FIELD DEFINITIONS:
- source: The broker who sent the message (before " - " or after "WITH"). This is NOT the owner.
- owner: The vessel owner/operator. The name before " - " is usually the OWNER, not a broker. "CENTROFIN - MV NIRIIS" means CENTROFIN is the owner. "WITH QUADRA MV..." means QUADRA is the broker. If the source appears to be an owner (marketing their own vessel), put the same name in both source and owner.
- vessel_name: Ship name (after MV/MT, without the MV/MT prefix)
- dwt: Deadweight tonnage (number, e.g. 81688). (81/17) means 81,000 DWT built 2017. (81'688DWT) means 81,688 DWT.
- build_year: Year built (4-digit)
- draft: Maximum draft in meters if provided
- scrubber: true if SCR/scrubber/+S mentioned, null if unknown
- current_position: Current port/location
- open_date: Date vessel is open (ISO format YYYY-MM-DD). If range like "10-15 APR", use earliest date.
- eta_ecsa: ETA to ECSA/loading area (ISO format). If range, use earliest.
- eta_ecsa_end: End of ETA range if given (ISO format), null if single date.
- eta_type: "ONW" if onwards/approximate, "EXACT" if firm date
- delivery_basis: Delivery terms (APS ECSA, SANTOS, PARANAGUA, DLOSP, etc.)
- bod_ifo: Bunkers on delivery - IFO/LSFO/HFO quantity in MT
- bod_mdo: Bunkers on delivery - MDO/LSMGO quantity in MT
- bod_basis: BOD basis port (e.g. SANTOS, ENNORE)
- bod_fuel_type: "LSFO/LSMGO" if low-sulphur, null for standard IFO/MDO
- market_colour: Array of rate/offer objects, each with:
  - route: "ECSA FH", "ECSA TA", "USG FH", etc. FEAST = Far East = FH (fronthaul)
  - bid_usd: Bid/market side rate ($/day)
  - offer_usd: Owner's asking rate ($/day). "Rating", "Ideas", "Offers", "RATING" all mean the offer.
  - bb_usd: Ballast bonus lump sum ($). "19k + 900k" means 19,000/day TC + $900,000 BB.
  - p6_bid: P6 equivalent of bid
  - p6_offer: P6 equivalent of offer. Parse from (p6: X) or (p6 bss X = Y) where Y is the p6 equiv.
- status: "OPEN", "ON SUBS", "FIXED", "FAILED", "WITHDRAWN". "OFF-MKT" or "EX-OUR CP" = WITHDRAWN. "On subs (nfd)" = ON SUBS. "FXD" or "FIXED" = FIXED.
- notes: The raw offer/rate line verbatim (e.g. "Ideas 21k try less (p6: 17,750 vs 19,200)") plus any extra context (CP notes, cargo details, route preferences). Always include the original rate/offer text here.

IMPORTANT PARSING RULES:
- Use current year (${new Date().getFullYear()}) for dates without a year
- Return an array of vessel objects, one per vessel in the input
- Multiple messages may be separated by blank lines or sent as one block — parse each vessel separately
- "RATING 21500" means offer of $21,500/day
- "Ideas 18k" means offer of $18,000/day
- "try 18k infront" means the bid side is $18,000/day
- "ECSA OPT NCSA/FEAST" means route options are ECSA FH or NCSA FH
- If a line contains "(CP ON THIS VSL)" note it in notes but still parse the vessel
- Messages without a " - " separator may still be valid — owner name may be omitted
- A vessel offered on multiple routes: create one market_colour entry per route
- Range ETAs like "ETA 20/25 APR" → eta_ecsa: earliest, eta_ecsa_end: latest, eta_type: "ONW"
- Speed/consumption specs inline (e.g. "14.5K / 32MT") → ignore, not needed
- If a message is ambiguous or partial, still extract what you can — don't skip vessels
- "nfd" = no fixed date, treat as ONW

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Parse these vessel tonnage messages into JSON:\n\n${text}` }],
    });

    const raw = message.content.find(b => b.type === 'text')?.text;
    if (!raw) throw new Error('No response from model');

    const parsed = JSON.parse(raw);
    const vessels = Array.isArray(parsed) ? parsed : [parsed];

    res.status(200).json(vessels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
