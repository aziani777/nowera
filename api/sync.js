import crypto from 'crypto';

const BIN_URL = 'https://api.jsonbin.io/v3/b';
const JWT_SECRET = process.env.JWT_SECRET || 'aztodo-secret-change-me';
const MAIN_USER = 'adzian.mcc@gmail.com';

// Verify the same self-contained token created by /api/auth
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getEmail(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const payload = verifyToken(h.slice(7));
  return payload?.email?.toLowerCase() || null;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.JSONBIN_API_KEY;
  const BIN_ID  = process.env.JSONBIN_BIN_ID;

  if (!API_KEY || !BIN_ID) {
    return res.status(500).json({ error: 'Server not configured. Add JSONBIN_API_KEY and JSONBIN_BIN_ID in Vercel environment variables.' });
  }

  const email = getEmail(req);
  if (!email) return res.status(401).json({ error: 'Sign in required for cloud sync' });

  // Read the full bin (shared store, partitioned per user)
  async function readBin() {
    const r = await fetch(`${BIN_URL}/${BIN_ID}/latest`, { headers: { 'X-Master-Key': API_KEY } });
    const d = await r.json();
    return d.record || {};
  }

  // GET → pull this user's data
  if (req.method === 'GET') {
    try {
      const record = await readBin();
      if (record.users && record.users[email]) {
        return res.status(200).json(record.users[email]);
      }
      // Migration: main user's data used to live at the top level of the bin
      if (email === MAIN_USER) {
        const { users, ...legacy } = record;
        return res.status(200).json(legacy);
      }
      return res.status(200).json({});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PUT → push this user's data (preserves everyone else's)
  if (req.method === 'PUT') {
    try {
      const record = await readBin();
      if (!record.users) record.users = {};
      record.users[email] = req.body || {};
      const r = await fetch(`${BIN_URL}/${BIN_ID}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': API_KEY,
          'X-Bin-Versioning': 'false'
        },
        body: JSON.stringify(record)
      });
      const data = await r.json();
      return res.status(r.status).json({ ok: r.ok, ts: data?.metadata?.parentId || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
