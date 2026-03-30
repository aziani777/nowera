async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(d));
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not set' });

  const { workspaces = [], existingTasks = [] } = req.body || {};

  try {
    // 1 — Get fresh access token
    const accessToken = await getAccessToken();

    // 2 — Fetch emails from last 48h
    const since = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${since}&maxResults=25`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();
    const messages = listData.messages || [];
    if (!messages.length) return res.status(200).json({ tasks: [], infos: [] });

    // 3 — Fetch metadata for each email
    const emailSummaries = await Promise.all(
      messages.map(async (m) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msg = await msgRes.json();
        const headers = msg.payload?.headers || [];
        const get = (name) => headers.find(h => h.name === name)?.value || '';
        return {
          subject: get('Subject'),
          from: get('From').replace(/<.*>/g, '').trim(),
          snippet: (msg.snippet || '').slice(0, 200),
        };
      })
    );

    // 4 — Ask Claude to classify
    const workspaceList = workspaces.map(w => w.label).join(', ') || 'Perso, Business';
    const wsIds = workspaces.map(w => `"${w.id}"`).join(', ') || '"perso"';
    const skipList = existingTasks.slice(0, 20).join(' | ') || 'none';
    const emailBlock = emailSummaries.map((e, i) =>
      `[${i + 1}] From: ${e.from} | Subject: ${e.subject} | Preview: ${e.snippet}`
    ).join('\n');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are a smart email triage assistant. Classify each email as "task", "info", or "skip".

Available workspaces: ${workspaceList}
Already imported (skip duplicates): ${skipList}

Classification rules:
- "task" → user needs to DO something: reply, pay, call, schedule, review, sign, send, fix, book...
- "info" → useful to know but no action: receipt, confirmation, shipped, approved, FYI, status update...
- "skip" → newsletter, marketing, social, automated alert, spam → exclude from output entirely

Emails:
${emailBlock}

Return ONLY a JSON array. No markdown, no explanation.

For "task": {"type":"task","subject":"...","from":"...","summary":"one sentence max 100 chars","text":"verb + action max 60 chars","section":one of [${wsIds}],"priority":"high"|"medium"|"low","due":"YYYY-MM-DD or null","note":"context max 80 chars"}

For "info": {"type":"info","subject":"...","from":"...","summary":"one sentence max 100 chars","text":"what to know max 80 chars"}

Return [] if nothing relevant.`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      const e = await claudeRes.text();
      return res.status(claudeRes.status).json({ error: e });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.find(c => c.type === 'text')?.text || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();

    let items = [];
    try { items = JSON.parse(clean); } catch (e) { items = []; }

    return res.status(200).json({
      tasks: items.filter(i => i.type === 'task'),
      infos: items.filter(i => i.type === 'info'),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
