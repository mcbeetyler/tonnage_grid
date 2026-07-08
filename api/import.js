import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.tonnage_grid_KV_REST_API_URL,
  token: process.env.tonnage_grid_KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

const SOURCES = ['ecsa', 'natl', 'cargo'];

// Google Sheets feed drop-box.
//   POST { source, data }  ← from the Apps Script (Basic auth handled by
//                            middleware.js like every other route)
//   GET                    → { ecsa: ts, natl: ts, cargo: ts } freshness stamps
//   GET ?src=ecsa          → { ts, data } full payload for one source
// The dashboard (feeds.js) polls GET, compares stamps to what it last
// applied, and runs fresh payloads through the existing sync pipelines.
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { source, data } = req.body || {};
    if (!SOURCES.includes(source) || data == null) {
      return res.status(400).json({ error: 'Expected { source: ecsa|natl|cargo, data }' });
    }
    const ts = new Date().toISOString();
    await kv.set('feed_' + source, { ts, data });
    return res.status(200).json({ ok: true, ts });
  }

  if (req.method === 'GET') {
    const src = req.query.src;
    if (src) {
      if (!SOURCES.includes(src)) return res.status(400).json({ error: 'Unknown source' });
      const payload = await kv.get('feed_' + src);
      return res.status(200).json(payload || { ts: null, data: null });
    }
    const all = await Promise.all(SOURCES.map(s => kv.get('feed_' + s)));
    const stamps = {};
    SOURCES.forEach((s, i) => { stamps[s] = all[i] ? all[i].ts : null; });
    return res.status(200).json(stamps);
  }

  res.status(405).end();
}
