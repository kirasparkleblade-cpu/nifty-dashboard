// /api/refresh-events.js
// Vercel Cron Job — runs daily at 00:30 UTC (6:00 AM IST)
// Uses Groq (free, fast) → writes to Google Sheet → widget reads sheet

// ── Google Sheets write ───────────────────────────────────────────────────
async function writeToSheet(events) {
  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
  const API_KEY   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Events';

  // Handle both raw JSON and base64-encoded service account
  let serviceAccount;
  try {
    // Try raw JSON first
    serviceAccount = JSON.parse(API_KEY);
  } catch(e) {
    // Fall back to base64 decode
    try {
      serviceAccount = JSON.parse(Buffer.from(API_KEY, 'base64').toString('utf-8'));
    } catch(e2) {
      // Try cleaning the base64 string
      const cleaned = API_KEY.replace(/\s/g, '');
      serviceAccount = JSON.parse(Buffer.from(cleaned, 'base64').toString('utf-8'));
    }
  }
  const token = await getGoogleAccessToken(serviceAccount);

  // Clear sheet
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_TAB}!A:D:clear`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );

  // Write header + events
  const rows = [
    ['date', 'title', 'category', 'updated'],
    ...events.map(e => [e.date, e.title, e.category, new Date().toISOString()])
  ];

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${SHEET_TAB}!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error('Sheets write failed: ' + JSON.stringify(err));
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

  const enc     = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  const header  = enc({ alg: 'RS256', typ: 'JWT' });
  const payload = enc(claim);
  const unsigned = `${header}.${payload}`;

  const keyData  = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const binaryKey = Buffer.from(keyData, 'base64');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(unsigned));
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google token failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Parse pipe-delimited response from Groq ───────────────────────────────
function parseEvents(raw) {
  if (!raw) return null;
  const valid = ['RBI', 'F&O', 'Budget', 'Earnings', 'Global', 'Data', 'Other'];
  const events = [];
  for (const line of raw.split('\n').map(l => l.trim()).filter(l => l.includes('|'))) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 3) {
      const [date, title, category] = parts;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        events.push({ date, title, category: valid.find(c => category.includes(c)) || 'Other' });
      }
    }
  }
  return events.length ? events : null;
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

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

    // Call Groq API (free tier — llama3 model)
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json'
      },
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
    if (!events || !events.length) throw new Error('No events parsed from Groq response');

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
