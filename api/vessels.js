import { createClient } from '@vercel/kv';

// Upstash integration injects env vars with a `tonnage_grid_KV_` prefix
// rather than the unprefixed names the default `kv` export expects.
const kv = createClient({
  url: process.env.tonnage_grid_KV_REST_API_URL,
  token: process.env.tonnage_grid_KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

// Optimistic concurrency:
//   GET  → { rev, vessels }
//   POST { rev, vessels } → 200 { rev: rev+1 } if rev matches the stored one,
//                           409 { rev, vessels } (current server state) if not.
// A stale browser tab can no longer clobber edits made elsewhere — it gets a
// 409 and the client merges before retrying.
// Legacy POST bodies (bare array) are still accepted so an old cached client
// can't get locked out; they bypass the check exactly like the old behaviour.
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const [vessels, rev] = await Promise.all([
      kv.get('pt_vessels'),
      kv.get('pt_vessels_rev'),
    ]);
    res.status(200).json({ rev: rev ?? 0, vessels: vessels ?? [] });
  } else if (req.method === 'POST') {
    const body = req.body;

    // Legacy shape: bare array — accept and bump rev (old clients)
    if (Array.isArray(body)) {
      const rev = ((await kv.get('pt_vessels_rev')) ?? 0) + 1;
      await kv.set('pt_vessels', body);
      await kv.set('pt_vessels_rev', rev);
      return res.status(200).json({ ok: true, rev });
    }

    if (!body || !Array.isArray(body.vessels) || typeof body.rev !== 'number') {
      return res.status(400).json({ error: 'Expected { rev, vessels }' });
    }

    const currentRev = (await kv.get('pt_vessels_rev')) ?? 0;
    if (body.rev !== currentRev) {
      const vessels = (await kv.get('pt_vessels')) ?? [];
      return res.status(409).json({ rev: currentRev, vessels });
    }

    const rev = currentRev + 1;
    await kv.set('pt_vessels', body.vessels);
    await kv.set('pt_vessels_rev', rev);
    res.status(200).json({ ok: true, rev });
  } else {
    res.status(405).end();
  }
}
