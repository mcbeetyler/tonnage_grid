import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.tonnage_grid_KV_REST_API_URL,
  token: process.env.tonnage_grid_KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

// Daily supply snapshots for the S&D page.
//   pt_snd_snapshots = { 'YYYY-MM-DD': { BASIN: { open, n15, n30 }, ... }, ... }
// Every browser that has both boards loaded posts today's counts on load;
// several browsers a day are merged by MAX per basin per field, so a tab
// with a stale or empty NATL list can never pull a good day's numbers down.
// Demand needs no snapshot — the cargo book keeps its own history.
const KEY = 'pt_snd_snapshots';
const KEEP_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const days = (await kv.get(KEY)) ?? {};
    return res.status(200).json({ days });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const incoming = req.body && req.body.days;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Expected { days: { date: { basin: { open, n15, n30 } } } }' });
  }

  const days = (await kv.get(KEY)) ?? {};
  let merged = 0;
  for (const [date, basins] of Object.entries(incoming)) {
    if (!DATE_RE.test(date) || !basins || typeof basins !== 'object') continue;
    const day = days[date] || {};
    for (const [basin, c] of Object.entries(basins)) {
      if (!c || typeof c !== 'object') continue;
      const cur = day[basin] || {};
      for (const f of ['open', 'n15', 'n30']) {
        const n = Number(c[f]);
        if (!Number.isFinite(n) || n < 0) continue;
        cur[f] = Math.max(cur[f] ?? 0, Math.round(n));
      }
      day[basin] = cur;
    }
    days[date] = day;
    merged++;
  }
  // Keep the map bounded: oldest days fall off past ~13 months
  const dates = Object.keys(days).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete days[d];

  await kv.set(KEY, days);
  res.status(200).json({ ok: true, merged, total: Object.keys(days).length });
}
