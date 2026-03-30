export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' });
  }

  const { workspaces = [], existingTasks = [] } = req.body || {};
  const workspaceList = workspaces.map(w => w.label).join(', ') || 'Perso, Business';
  const wsIds = workspaces.map(w => `"${w.id}"`).join(', ');
  const skipList = existingTasks.slice(0, 20).join(' | ') || 'none';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        mcp_servers: [
          { type: 'url', url: 'https://gmail.mcp.claude.com/mcp', name: 'gmail' }
        ],
        messages: [{
          role: 'user',
          content: `Read the last 48 hours of emails in Gmail. For each email, assess whether it requires action, is just informational, or can be ignored.

Available workspaces: ${workspaceList}
Already imported tasks (skip creating duplicates): ${skipList}

Classify each email into one of three types:

1. **"task"** — requires the user to DO something (reply, pay, schedule, call, review, decide, send, book, fix...)
2. **"info"** — useful to be aware of but no action needed (confirmation, receipt, update, FYI, shipped, approved, status update...)
3. **"skip"** — newsletters, automated notifications, spam, marketing, social media digests, unsubscribe emails

Return ONLY a JSON array. Each object must have:
- "type": "task" | "info" | "skip"
- "subject": the email subject (max 80 chars)
- "from": sender name or email
- "summary": one sentence summary of what the email is about (max 100 chars)

If type is "task", also include:
- "text": action to take (max 60 chars, starts with verb e.g. "Reply to...", "Pay...", "Schedule...")
- "section": best matching workspace id from: ${wsIds}
- "priority": "high" | "medium" | "low"
- "due": YYYY-MM-DD if there is a deadline mentioned, otherwise null
- "note": sender + subject context (max 80 chars)

If type is "info", also include:
- "text": one-line summary of what you should know (max 80 chars)

Omit "skip" emails entirely from the output — do not include them.

Return [] if nothing relevant. Return ONLY valid JSON array, no markdown, no explanation.`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const raw = data.content?.find(c => c.type === 'text')?.text || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();

    let items = [];
    try { items = JSON.parse(clean); } catch (e) { items = []; }

    const tasks = items.filter(i => i.type === 'task');
    const infos = items.filter(i => i.type === 'info');

    return res.status(200).json({ tasks, infos });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
