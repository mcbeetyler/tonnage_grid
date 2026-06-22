const CARGO_SYSTEM_PROMPT = `You are a dry bulk cargo book parser for a Panamax/Kamsarmax charterers' broker. Extract cargo entries from spreadsheet paste data into structured JSON.

The input is tab-separated text from a Google Sheet. Structure:
1. Summary rows at top (like "IN 30 Total Cargo Count: 45 Fresh/Fixed cargoes: 2 0") — IGNORE these
2. A column header row, typically: "[blank] Size Age Delivery Redelivery Cargo Laycan Com Updated Comment FRESH FIXED USER" — the first column has no header but holds the charterer name in data rows
3. Stem header rows (e.g. "Cont/Baltic TA", "ECSA fronthaul") with a count number in column 2 — these mark the section, not cargoes
4. Cargo rows under each stem section, where column 0 = charterer name
5. Another stem header, more cargoes, etc.

KNOWN STEM NAMES (normalize OUTPUT to these exact spellings):
- ECSA Fronthaul, ECSA TA
- NCSA Fronthaul, NCSA TA
- USG Fronthaul, USG TA
- USEC Fronthaul, USEC TA  (also accept "USEC FHAUL")
- EC CAN TA, EC CAN Fronthaul
- Cont/Baltic TA, Cont/Baltic Fronthaul
- WAFR Fronthaul, WAFR TA
- Bsea/Med Fronthaul, Bsea/Med TA  (also accept "Bsea/WMed/EMed" variants — normalize to "Bsea/Med")

COLUMN MEANING (positional in the sheet):
- col 0: charterer name (lowercase okay, e.g. "olam", "cargill", "cofco int")
- col 1 (Size): vessel size like "pmx", "kmx", "pmx/kmx", "66000", "60-55000/10", "80000/10"
- col 2 (Age): optional age constraint, often empty
- col 3 (Delivery): LOAD area like "ecsa", "ncsa", "usg", "santos", "rouen + la pallice", "miss river"
- col 4 (Redelivery): DISCHARGE area like "china", "spore-jpn", "feast", "ara", "fos"
- col 5 (Cargo): cargo type like "grain", "coal", "ore", "petcoke", "hss", "bauxite", "concentrates", "iore", "sugar"
- col 6 (Laycan): laycan string like "10apr onw", "15-30apr", "1-5may", "5jul onw", "22jul onw", "june dates or 1-10jul"
- col 7 (Com): commission like "5ttl", "3.75ttl" — IGNORE
- col 8 (Updated): the date the cargo was last updated, like "25Mar", "2Apr", "22Jun"
- col 9 (Comment): notes — IGNORE for now
- col 10 (FRESH): boolean text "TRUE"/"FALSE"
- col 11 (FIXED): boolean text "TRUE"/"FALSE"
- col 12 (USER): username — IGNORE

OUTPUT FIELDS (use exactly these names):
- charterer: string. Strip "- NOT FOR LIST" suffix silently. Lowercase is fine — preserve as written.
- size: string
- load: string (from Delivery)
- disch: string (from Redelivery)
- cargo: string
- laycan: string (preserve verbatim, do NOT normalize)
- updated: string (preserve verbatim, like "22Jun")
- fresh: boolean (TRUE → true)
- fixed: boolean (TRUE → true)
- stem: which stem section this cargo was under (normalized to one of the names above)

RULES:
- A row where the first non-empty cell matches a known stem name = SECTION HEADER. Update current stem context, do NOT emit it as a cargo.
- Summary rows ("Total Cargo Count", "IN 30", "Fresh/Fixed cargoes") = metadata, skip.
- Column header rows = schema, skip.
- Only emit a row if column 0 has a real charterer name (length ≥ 2, not a stem name, not a pure number, not "#", not "total").
- Empty cells → empty string "".
- A cargo row may have FALSE/FALSE in fresh/fixed even if other cells are empty — that alone doesn't make it a cargo. Need a charterer in col 0 to count.
- If a stem section's row immediately after the header has nothing in col 0 (just FALSE/FALSE/user), that's a stem-spacer row — skip.

Return ONLY a JSON array of cargo objects. No markdown, no explanation. Start with [ and end with ].`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        system: CARGO_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Parse this cargo book paste into JSON:\n\n${text}` }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Anthropic API error ${response.status}: ${err.error?.message || response.statusText}`);
    }

    const data = await response.json();
    let raw = data.content.find(b => b.type === 'text')?.text;
    if (!raw) throw new Error('No response from model');

    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    const parsed = JSON.parse(raw);
    const cargoes = Array.isArray(parsed) ? parsed : [parsed];

    res.status(200).json(cargoes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
