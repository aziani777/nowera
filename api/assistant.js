export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { history = [], workspaces = [], today = '', lang = 'en' } = req.body || {};
  const wsList = workspaces.map(w => `${w.id}: ${w.label}`).join(', ') || 'perso: PERSO';

  const system = `You are Nowera's task assistant. The user describes tasks in natural language (English or French); you convert them into structured tasks.
Today is ${today}. User interface language: ${lang}.
Available workspaces (id: label): ${wsList}.

Respond ONLY with a JSON object, no markdown, no explanation:
{"reply":"one short friendly sentence in the user's language","tasks":[{"text":"...","due":"YYYY-MM-DD or \\"\\"","priority":"low|medium|high","section":"<workspace id>","recur":"\\"\\"|daily|weekly|monthly"}]}

Rules:
- Split multiple actions into separate tasks.
- Resolve relative dates (tomorrow, vendredi prochain...) using today's date.
- Pick the most fitting workspace id from the list; when unsure use the first one.
- If the user is only chatting or asking a question, return "tasks":[] and answer briefly in "reply".`;

  const messages = history
    .filter(m => m && m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1000) }));
  if (!messages.length) return res.status(400).json({ error: 'Empty message' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system,
        messages,
      }),
    });
    if (!r.ok) {
      const e = await r.text();
      return res.status(r.status).json({ error: e });
    }
    const d = await r.json();
    const raw = d.content?.find(c => c.type === 'text')?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    let out;
    try { out = JSON.parse(clean); } catch { out = { reply: clean.slice(0, 300), tasks: [] }; }
    return res.status(200).json({ reply: out.reply || '', tasks: Array.isArray(out.tasks) ? out.tasks : [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
