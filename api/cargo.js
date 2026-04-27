import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.tonnage_grid_KV_REST_API_URL,
  token: process.env.tonnage_grid_KV_REST_API_TOKEN,
});

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

// Cargo history storage:
//   pt_cargo_history = array of all cargoes ever seen, with first_seen / last_seen
//   pt_cargo_current = array of cargo IDs currently in the market (from last paste)
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const history = await kv.get('pt_cargo_history') ?? [];
    const current = await kv.get('pt_cargo_current') ?? [];
    res.status(200).json({ history, current });
  } else if (req.method === 'POST') {
    const { history, current } = req.body;
    if (!Array.isArray(history) || !Array.isArray(current)) {
      return res.status(400).json({ error: 'Expected {history, current} arrays' });
    }
    await kv.set('pt_cargo_history', history);
    await kv.set('pt_cargo_current', current);
    res.status(200).json({ ok: true });
  } else {
    res.status(405).end();
  }
}
