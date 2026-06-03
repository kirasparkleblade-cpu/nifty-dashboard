// /api/refresh-events.js
// Vercel Cron Job — runs daily at 00:30 UTC (6:00 AM IST)
// Uses Groq (free) → writes to Google Sheet → widget reads sheet

// ── Google Sheets write ───────────────────────────────────────────────────
async function writeToSheet(events) {
  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
  const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Events';
  const SA_RAW    = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  // Parse service account — handles raw JSON or base64
  let sa;
  try { sa = JSON.parse(SA_RAW); }
  catch(e) {
    try { sa = JSON.parse(Buffer.from(SA_RAW, 'base64').toString('utf-8')); }
    catch(e2) {
      const once = Buffer.from(SA_RAW, 'base64').toString('utf-8');
      sa = JSON.parse(Buffer.from(once, 'base64').toString('utf-8'));
    }
  }

  const token = await getGoogleAccessToken(sa);
  const base  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
  const range = encodeURIComponent(`${SHEET_TAB}!A:D`);

  // 1. Clear existing data
  const clearRes = await fetch(`${base}/values/${range}:clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!clearRes.ok) {
    const t = await clearRes.text();
    throw new Error(`Clear failed (${clearRes.status}): ${t.slice(0,200)}`);
  }

  // 2. Write header + events
  const rows = [
    ['date', 'title', 'category', 'updated'],
    ...events.map(e => [e.date, e.title, e.category, new Date().toISOString()])
  ];
  const writeRange = encodeURIComponent(`${SHEET_TAB}!A1`);
  const writeRes = await fetch(
    `${base}/values/${writeRange}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );
  if (!writeRes.ok) {
    const t = await writeRes.text();
    throw new Error(`Write failed (${writeRes.status}): ${t.slice(0,200)}`);
  }
}

// ── Google OAuth2 JWT ─────────────────────────────────────────────────────
async function getGoogleAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const enc      = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  const unsigned = `${enc({ alg:'RS256', typ:'JWT' })}.${enc(claim)}`;

  const keyData  = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', Buffer.from(keyData, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(unsigned));
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token failed: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Parse Groq response ───────────────────────────────────────────────────
function parseEvents(raw) {
  const valid = ['RBI','F&O','Budget','Earnings','Global','Data','Other'];
  const events = [];
  for (const line of raw.split('\n').map(l => l.trim()).filter(l => l.includes('|'))) {
    const [date, title, category] = line.split('|').map(p => p.trim());
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && title) {
      events.push({ date, title, category: valid.find(c => (category||'').includes(c)) || 'Other' });
    }
  }
  return events.length ? events : null;
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not set in environment variables' });

  try {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today  = istNow.toISOString().split('T')[0];
    const endDt  = new Date(today); endDt.setDate(endDt.getDate() + 60);
    const endStr = endDt.toISOString().split('T')[0];

    const prompt =
`List Indian stock market events from ${today} to ${endStr}.
Output ONLY pipe-delimited lines: YYYY-MM-DD|Title max 7 words|Category
Category must be one of: RBI F&O Budget Earnings Global Data Other
Include: NSE F&O weekly expiry every Thursday, NSE monthly expiry last Thursday of month, RBI MPC decisions, India CPI WPI GDP IIP releases, US Fed FOMC meetings, major Nifty50 earnings.
No headers. No explanation. No markdown.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1200
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      throw new Error('Groq error: ' + (err?.error?.message || groqRes.status));
    }

    const groqData = await groqRes.json();
    const raw    = groqData?.choices?.[0]?.message?.content || '';
    const events = parseEvents(raw);
    if (!events || !events.length) throw new Error('No events parsed. Raw: ' + raw.slice(0, 200));

    events.sort((a, b) => a.date > b.date ? 1 : -1);
    await writeToSheet(events);

    return res.status(200).json({
      success: true,
      model: 'llama-3.3-70b-versatile',
      count: events.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
