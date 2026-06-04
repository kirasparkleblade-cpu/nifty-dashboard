// /api/refresh-events.js
// Vercel Cron Job — runs daily at 00:30 UTC (6:00 AM IST)
// Uses Groq (free) → writes to Google Sheet → widget reads sheet

async function writeToSheet(events) {
  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
  const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Events';
  const SA_RAW    = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

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

  // Build rows
  const rows = [
    ['date', 'title', 'category', 'updated'],
    ...events.map(e => [e.date, e.title, e.category, new Date().toISOString()])
  ];

  // Step 1: clear all values using sheetId=0 (first sheet)
  const clearRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: { sheetId: 0 },
            fields: 'userEnteredValue'
          }
        }]
      })
    }
  );
  if (!clearRes.ok) {
    const t = await clearRes.text();
    throw new Error(`Clear failed (${clearRes.status}): ${t.slice(0,200)}`);
  }

  // Step 2: write rows using A1 notation with sheet index
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1?valueInputOption=RAW`,
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

  const keyData   = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
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

export default async function handler(req, res) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today  = istNow.toISOString().split('T')[0];
    const endDt  = new Date(today); endDt.setDate(endDt.getDate() + 60);
    const endStr = endDt.toISOString().split('T')[0];

    // Known fixed dates — AI only fills gaps, cannot invent new ones
    const knownEvents = [
      // F&O Weekly (every Thursday)
      "2026-06-05|NSE F&O Weekly Expiry|F&O",
      "2026-06-11|NSE F&O Weekly Expiry|F&O",
      "2026-06-18|NSE F&O Monthly Expiry|F&O",
      "2026-06-25|NSE F&O Weekly Expiry|F&O",
      "2026-07-02|NSE F&O Weekly Expiry|F&O",
      "2026-07-09|NSE F&O Weekly Expiry|F&O",
      "2026-07-16|NSE F&O Weekly Expiry|F&O",
      "2026-07-23|NSE F&O Monthly Expiry|F&O",
      "2026-07-30|NSE F&O Weekly Expiry|F&O",
      "2026-08-06|NSE F&O Weekly Expiry|F&O",
      "2026-08-13|NSE F&O Weekly Expiry|F&O",
      "2026-08-20|NSE F&O Weekly Expiry|F&O",
      "2026-08-27|NSE F&O Monthly Expiry|F&O",
      "2026-09-03|NSE F&O Weekly Expiry|F&O",
      "2026-09-10|NSE F&O Weekly Expiry|F&O",
      "2026-09-17|NSE F&O Weekly Expiry|F&O",
      "2026-09-24|NSE F&O Monthly Expiry|F&O",
      // RBI MPC (confirmed dates)
      "2026-06-06|RBI MPC Decision|RBI",
      "2026-08-07|RBI MPC Decision|RBI",
      "2026-10-09|RBI MPC Decision|RBI",
      "2026-12-04|RBI MPC Decision|RBI",
      // US Fed FOMC (confirmed dates)
      "2026-06-18|US Fed FOMC Decision|Global",
      "2026-07-29|US Fed FOMC Decision|Global",
      "2026-09-16|US Fed FOMC Decision|Global",
      "2026-11-04|US Fed FOMC Decision|Global",
      "2026-12-16|US Fed FOMC Decision|Global",
      // India Macro Data (approx release dates)
      "2026-06-12|India CPI Inflation May|Data",
      "2026-06-12|India WPI Inflation May|Data",
      "2026-06-30|India GDP Q4 FY26|Data",
      "2026-07-14|India CPI Inflation Jun|Data",
      "2026-07-31|India IIP Data May|Data",
      "2026-08-13|India CPI Inflation Jul|Data",
      "2026-09-12|India CPI Inflation Aug|Data",
    ].filter(e => e.split("|")[0] >= today && e.split("|")[0] <= endStr).join("\n");

    const prompt =
`Here are confirmed Indian market events from ${today} to ${endStr}:
${knownEvents}

Now add ONLY real confirmed events not already listed above — such as verified Nifty50 Q1 earnings dates (TCS, Infosys, HDFC Bank, Reliance etc) if you know their exact confirmed date.
DO NOT invent or guess dates. Only include events you are certain about.
Output ONLY pipe-delimited lines in same format: YYYY-MM-DD|Title max 7 words|Category
Category must be one of: RBI F&O Budget Earnings Global Data Other
No headers. No explanation. No markdown. If unsure about any date, skip it.`;

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
    const raw = groqData?.choices?.[0]?.message?.content || '';

    // Parse known seed events
    const seedEvents = parseEvents(knownEvents);

    // Parse AI additions (may be empty if AI found nothing new)
    const aiEvents = parseEvents(raw) || [];

    // Merge — known events take priority, AI can only add new ones
    const seen = new Set(seedEvents.map(e => e.date + e.title.toLowerCase()));
    const merged = [...seedEvents];
    for (const e of aiEvents) {
      const key = e.date + e.title.toLowerCase();
      if (!seen.has(key)) { merged.push(e); seen.add(key); }
    }

    if (!merged.length) throw new Error('No events. Raw: ' + raw.slice(0, 200));
    merged.sort((a, b) => a.date > b.date ? 1 : -1);
    await writeToSheet(merged);

    return res.status(200).json({
      success: true,
      model: 'llama-3.3-70b-versatile',
      count: merged.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
