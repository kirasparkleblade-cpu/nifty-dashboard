// /api/refresh-events.js
// Vercel Serverless Function + Cron Job
// Runs once daily at 00:30 UTC (6:00 AM IST)
// Calls Gemini ONCE → writes results to Google Sheet
// Widget reads the sheet all day → zero AI tokens per page load

const PREFERRED_MODELS = [
  'gemini-1.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// ── Google Sheets write via REST API ─────────────────────────────────────
async function writeToSheet(events) {
  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
  const API_KEY   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // base64-encoded service account JSON
  const SHEET_TAB = 'Events';

  // Decode service account
  const serviceAccount = JSON.parse(
    Buffer.from(API_KEY, 'base64').toString('utf-8')
  );

  // Get access token using JWT
  const token = await getGoogleAccessToken(serviceAccount);

  // Clear existing data first
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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: rows })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error('Sheets write failed: ' + JSON.stringify(err));
  }
}

// ── Minimal JWT for Google OAuth2 ────────────────────────────────────────
async function getGoogleAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  // Build JWT (header.payload.signature)
  const enc    = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  const header = enc({ alg: 'RS256', typ: 'JWT' });
  const payload= enc(claim);
  const unsigned = `${header}.${payload}`;

  // Sign with RS256
  const keyData = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const binaryKey = Buffer.from(keyData, 'base64');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(unsigned)
  );
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Gemini helpers ────────────────────────────────────────────────────────
async function getBestModel(geminiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
  );
  const data  = await res.json();
  const avail = (data.models || [])
    .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
    .map(m => m.name.replace('models/', ''));
  for (const p of PREFERRED_MODELS) {
    const found = avail.find(a => a === p || a.startsWith(p + '-'));
    if (found) return found;
  }
  if (avail.length) return avail[0];
  throw new Error('No Gemini models available');
}

function parseEvents(raw) {
  if (!raw) return null;
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
             .replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Try JSON
  try { const p = JSON.parse(t); if (Array.isArray(p) && p.length) return p; } catch(e) {}
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s > -1 && e > s) { try { const p = JSON.parse(t.slice(s, e+1)); if (Array.isArray(p) && p.length) return p; } catch(e){} }
  // Pipe-separated
  const valid = ['RBI','F&O','Budget','Earnings','Global','Data','Other'];
  const evs = [];
  for (const line of t.split('\n').map(l => l.trim()).filter(l => l.includes('|'))) {
    const [date, title, category] = line.split('|').map(p => p.trim());
    if (/^\d{4}-\d{2}-\d{2}$/.test(date))
      evs.push({ date, title, category: valid.find(c => category.includes(c)) || 'Other' });
  }
  return evs.length ? evs : null;
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow manual trigger via GET with secret, or automatic cron
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    // Vercel cron passes the secret in Authorization header automatically
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  try {
    // 1. Get cheapest available model
    const model = await getBestModel(geminiKey);

    // 2. Build date range (today IST → +60 days)
    const istNow  = new Date(Date.now() + 5.5*60*60*1000);
    const today   = istNow.toISOString().split('T')[0];
    const endDt   = new Date(today); endDt.setDate(endDt.getDate() + 60);
    const endStr  = endDt.toISOString().split('T')[0];

    // 3. Call Gemini — compact prompt to minimise tokens
    const prompt =
`List Indian stock market events from ${today} to ${endStr}.
Output ONLY pipe-delimited lines: YYYY-MM-DD|Title max 7 words|Category
Category must be one of: RBI F&O Budget Earnings Global Data Other
Include: NSE F&O weekly expiry every Thursday, NSE monthly expiry last Thursday of month, RBI MPC decisions, India CPI WPI GDP IIP releases, US Fed FOMC meetings, major Nifty50 earnings.
No headers. No explanation. No markdown.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 1200 }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      throw new Error('Gemini error: ' + (err?.error?.message || geminiRes.status));
    }

    const geminiData = await geminiRes.json();
    const raw    = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const events = parseEvents(raw);
    if (!events || !events.length) throw new Error('No events parsed from Gemini response');

    events.sort((a, b) => a.date > b.date ? 1 : -1);

    // 4. Write to Google Sheet
    await writeToSheet(events);

    return res.status(200).json({
      success: true,
      model,
      count: events.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
