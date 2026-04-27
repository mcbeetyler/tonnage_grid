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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const vessels = await kv.get('pt_vessels') ?? [];
    res.status(200).json(vessels);
  } else if (req.method === 'POST') {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected array' });
    }
    await kv.set('pt_vessels', req.body);
    res.status(200).json({ ok: true });
  } else {
    res.status(405).end();
  }
}
