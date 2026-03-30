# Panamax Tonnage Tracker

**Owner**: Tyler McBee — Arrow Shipbroking, Geneva Atlantic Desk  
**Role**: Charterers' broker (Koch) focused on ECSA Fronthaul & Transatlantic stems  
**Purpose**: Bespoke tonnage tracking tool to replace a buggy internal prototype.  
Mirrors the functionality of an in-development internal tool, with customisations for personal workflow.

---

## What This Tool Does

Dry bulk freight broking generates a constant stream of vessel position updates via WhatsApp.
These arrive in semi-structured text, often in multiple formats depending on the sender.
This tool:

1. **Parses** raw WhatsApp tonnage messages into structured vessel objects
2. **Displays** vessels on a tonnage board with key fields visible at a glance
3. **Normalises** rate intelligence to P6 equivalent (the universal comparator across vessels)
4. **Tracks status** as vessels go from Open → Fixed / Failed / Withdrawn

---

## Repo Structure

```
panamax-tonnage-tracker/
├── README.md                  ← You are here
├── dashboard.html             ← Standalone single-file dashboard (open in Chrome)
├── src/
│   ├── parser.js              ← Core parsing logic (Node.js module + browser-inlined)
│   ├── parser.test.js         ← Unit tests: run with `node src/parser.test.js`
│   └── schema.js              ← Vessel data schema (JSDoc types + example objects)
└── data/
    └── sample_vessels.json    ← Sample vessel data for dashboard testing
```

---

## Running the Tool

**Dashboard** (no build step):
```bash
open dashboard.html   # macOS
# or drag into Chrome
```

State is persisted to `localStorage`. To pre-load sample data:
1. Open Chrome DevTools Console
2. Run: `localStorage.setItem('pt_vessels', JSON.stringify([...]))`  
   (paste the contents of `data/sample_vessels.json`)

**Run tests**:
```bash
node src/parser.test.js
# Expected: 43 passed, 0 failed
```

---

## Domain Knowledge for Claude Code

### Message Format

WhatsApp tonnage messages follow a loose convention. The canonical 3-line format:

```
OWNER - MV VESSEL NAME (DWT_K/YEAR) PORT OPEN_DATE / ETA ETA_DATE [ONW]
BOD ABT IFO_QTY/MDO_QTY
= ROUTE: Claims seeing BID [multiple times] vs OFFER (p6: P6_BID vs P6_OFFER)
```

**Real example** (the primary test case):
```
QUADRA - MV SAKIZAYA MIRACLE (81/17) GOA 31 MARCH / ETA 25 APR ONW
BOD ABT 1250/240
= ECSA FH: Claims seeing 20k multiple times vs 21,500 (p6: 16,700 vs 18k)
```

### Field Definitions

| Field | Meaning |
|---|---|
| `(81/17)` | 81,000 DWT / built 2017 (thousands / 2-digit year) |
| `GOA 31 MARCH` | Current port + open date (vessel completing current employment) |
| `ETA 25 APR ONW` | Earliest ETA to ECSA loading area. ONW = may slip later |
| `BOD ABT 1250/240` | Bunkers on delivery: ~1250mt IFO + 240mt MDO |
| `Claims seeing 20k` | Bid side: what the owner *claims* to see (unverified market intel) |
| `vs 21,500` | Offer side: owner's actual ask for this vessel |
| `p6: 16,700 vs 18k` | **P6-normalised equivalents of bid and offer** |
| `multiple times` | Owner emphasising bid depth (treat with some scepticism) |

### Why P6 Equivalent Matters

Vessels differ in size, speed, fuel consumption, and ballast position.
Raw $/day offers are not directly comparable across vessels.
**P6 equivalent converts all offers to the Baltic P6 route benchmark** (Santos/Qingdao, 66k mt HSS),
normalising across the fleet. This is the primary comparator in the dashboard.

The P6 route (P8 in Baltic notation) is:
- Santos to Qingdao, 66,000MT HSS (High-specification soya)  
- ~90-105 day trip
- Assessed basis gross, 5% TTL commission

### Routes Tyler Tracks

| Code | Description |
|---|---|
| `ECSA FH` | ECSA Fronthaul — Santos/Paranagua → China/Japan |
| `ECSA TA` | ECSA Transatlantic — Santos → ARA/Med |
| `USG FH` | US Gulf Fronthaul → Asia |
| `USG TA` | US Gulf Transatlantic → ARA |
| `NCSA FH` | North CSA Fronthaul |
| `USEC TA` | US East Coast Transatlantic |
| `WAFR` | West Africa |
| `BSEA` | Black Sea |
| `MED` | Mediterranean |

### Vessel Status Lifecycle

```
OPEN → FIXED   (vessel was taken, fixture agreed)
OPEN → FAILED  (negotiations broke down)
OPEN → WITHDRAWN (owner pulled vessel from market)
```

### Commission Structure

Tyler operates as charterers' broker for Koch.  
Standard commission: **5% TTL** (3.75% adcom to charterer + 1.25% broker commission).  
Koch benefits from adcom as a line in voyage P&L.

---

## Build Priorities for Claude Code

### Priority 1 — Parser Robustness
The parser handles the canonical 3-line format well (43/43 tests passing).
Needs improvement for:
- [ ] Vessels without a `- ` separator (owner name may be omitted)
- [ ] Multi-route messages (vessel offered on both ECSA FH and ECSA TA in same message)
- [ ] Range ETAs (e.g. "ETA 20/25 APR")  
- [ ] Messages with speed/consumption specs inline
- [ ] Messages from different brokers (format varies more than owner-direct messages)

### Priority 2 — Dashboard Enhancements
- [ ] **Inline bid entry**: allow manual entry of a bid/counter against a vessel
- [ ] **Spread calculation**: display `p6_offer - p6_bid` as a spread column
- [ ] **BKI Equivalent column**: the Arrow internal tool uses BKI equivalent (not raw $/day) 
      as the primary offer-side benchmark. BKI = Baltic Kamsarmax Index normalised to P5TC.
      Need a BKI→P6 conversion or a separate BKI column.
- [ ] **Laycan slot badge**: bucket ETA into fortnightly periods (Apr FH, Apr LH, May FH, etc.)
      Apr FH = Apr 1-15, Apr LH = Apr 16-30, May FH = May 1-15, etc.
      ONW dates: classify by the opening day number.
- [ ] **Change log tab**: timestamped record of all status changes and bid entries
- [ ] **Export**: copy board as tab-separated text for pasting into email

### Priority 3 — Cargo Book Integration
A separate cargo book dashboard (for cargoes, not vessels) also exists.
Eventually the two should be linkable so a vessel can be matched to a cargo.

---

## Screenshot Reference

The target internal tool has these columns:
`Select | Update | Flags | Name | Owner | DWT | Built | Draft | Dely | ETR | ETA best speed | ETA full speed | TC offer | BB offer | Index Eqvt dop | R... | Offers | DOP return | APS Return | Fitted? | Chart benefit (%) | Spread`

Key columns to replicate:
- **Index Eqvt dop** = BKI/P6 equivalent at delivery port — this is what Tyler calls the "normalised offer"
- **BB offer** = Ballast bonus offer (lump sum in addition to T/C rate for ballasting to load port)
- **Spread** = owner offer minus BKI equivalent (positive = owner above market)
- **APS Return** = all-in return to owner on APS basis

---

## Contact / Context

- Tyler's primary cargo is **Santos/Qingdao soybeans** (Koch account, ECSA FH)
- Secondary: ECSA TA, USG stems
- Geneva office; colleagues Will Lowdell and Elisa Chauvelot in same WhatsApp groups
- Market data sources: Baltic Exchange (P5TC, BPI routes), Ship & Bunker
- The tool should eventually connect to the Anthropic API for AI-assisted parsing
  (Tyler already uses Claude via his own API key stored in localStorage in a related tool)
