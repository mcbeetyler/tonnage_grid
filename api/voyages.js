import { kv } from '@vercel/kv';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

// Voyages storage:
//   pt_voyages = { p7: [...], p8: [...] }
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const voyages = await kv.get('pt_voyages') ?? { p7: [], p8: [] };
    res.status(200).json(voyages);
  } else if (req.method === 'POST') {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Expected {p7, p8} object' });
    }
    await kv.set('pt_voyages', { p7: body.p7 || [], p8: body.p8 || [] });
    res.status(200).json({ ok: true });
  } else {
    res.status(405).end();
  }
}
