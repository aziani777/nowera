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

function toYMD(isoString) {
  if (!isoString) return null;
  return isoString.slice(0, 10);
}

function toHHMM(isoString) {
  if (!isoString || isoString.length === 10) return ''; // all-day
  const d = new Date(isoString);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function guessSection(summary, workspaces) {
  if (!workspaces.length) return 'perso';
  const lower = (summary || '').toLowerCase();
  for (const ws of workspaces) {
    if (lower.includes(ws.label.toLowerCase())) return ws.id;
  }
  return workspaces[0].id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not set' });

  const { workspaces = [], dateFrom, dateTo } = req.body || {};

  try {
    const accessToken = await getAccessToken();

    // Fetch events from Google Calendar primary calendar
    const timeMin = new Date(dateFrom || new Date()).toISOString();
    const timeMax = new Date(dateTo || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString();

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
      }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calRes.ok) {
      const e = await calRes.text();
      return res.status(calRes.status).json({ error: e });
    }

    const calData = await calRes.json();
    const items = calData.items || [];

    const events = items
      .filter(ev => ev.status !== 'cancelled')
      .map(ev => {
        const start = ev.start?.dateTime || ev.start?.date || '';
        const date = toYMD(start);
        const time = toHHMM(start);
        const notes = [ev.location, ev.description].filter(Boolean).join(' · ').slice(0, 80);
        return {
          title: ev.summary || '(No title)',
          date,
          time,
          section: guessSection(ev.summary, workspaces),
          notes,
          gcalId: ev.id,
        };
      })
      .filter(ev => ev.date);

    return res.status(200).json({ events });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
