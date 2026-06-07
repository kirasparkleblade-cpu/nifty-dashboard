// /api/refresh-events.js
// Runs ONCE A WEEK — Monday 00:30 UTC (6:00 AM IST)
// Calls Gemini for the week's events → writes to Google Sheet
// Only ~4 calls/month — well within gemini-1.5-flash free tier (1500/day)

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

  const rows = [
    ['date', 'title', 'category', 'updated'],
    ...events.map(e => [e.date, e.title, e.category, new Date().toISOString()])
  ];

  // Clear sheet
  const clearRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ updateCells: { range: { sheetId: 0 }, fields: 'userEnteredValue' } }]
      })
    }
  );
  if (!clearRes.ok) {
    const t = await clearRes.text();
    throw new Error(`Clear failed (${clearRes.status}): ${t.slice(0,200)}`);
  }

  // Write rows
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

function parseEvents(raw) {
  const valid = ['RBI','F&O','Budget','Earnings','Global','Data','Other'];
  const events = [];
  for (const line of (raw||'').split('\n').map(l => l.trim()).filter(l => l.includes('|'))) {
    const [date, title, category] = line.split('|').map(p => p.trim());
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && title) {
      events.push({ date, title, category: valid.find(c => (category||'').includes(c)) || 'Other' });
    }
  }
  return events.length ? events : null;
}

export default async function handler(req, res) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  try {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today  = istNow.toISOString().split('T')[0];

    // ── Step 1: Compute this week's F&O expiry mathematically ──────────
    // Every Thursday = weekly expiry, last Thursday of month = monthly
    const ruleEvents = [];
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
    const toISO   = d => d.toISOString().split('T')[0];
    const lastThursdayOfMonth = (y, m) => {
      const d = new Date(y, m+1, 0);
      d.setDate(d.getDate() - ((d.getDay()+3)%7));
      return d;
    };

    // Next 14 days of Thursdays (covers this week + next)
    const startDt = new Date(today);
    const dow = startDt.getDay();
    const daysToThur = (4 - dow + 7) % 7 || 7;
    let cursor = addDays(startDt, daysToThur === 7 ? 0 : daysToThur);
    // Go back to find any Thursday this week too
    if (dow > 4) cursor = addDays(startDt, 7 - dow + 4);
    else if (dow === 4) cursor = startDt;
    else cursor = addDays(startDt, 4 - dow);

    const endDt = addDays(startDt, 30); // 30 days ahead
    while (cursor <= endDt) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      const lastThur = lastThursdayOfMonth(y, m);
      const isMonthly = toISO(cursor) === toISO(lastThur);
      ruleEvents.push({
        date: toISO(cursor),
        title: isMonthly ? 'NSE F&O Monthly Expiry' : 'NSE F&O Weekly Expiry',
        category: 'F&O'
      });
      cursor = addDays(cursor, 7);
    }

    // ── Step 2: Ask Gemini ONLY for this week's non-F&O events ─────────
    // Very short prompt = very few tokens = quota safe
    const endStr = toISO(addDays(startDt, 30)); // 30 days ahead

    const prompt =
`List confirmed Indian market events from ${today} to ${endStr}.
Output ONLY pipe-delimited lines: YYYY-MM-DD|Title max 6 words|Category
Category: RBI Budget Earnings Global Data Other
Include ONLY: RBI MPC decisions, US Fed FOMC, India CPI/WPI/GDP/IIP releases, confirmed Nifty50 earnings.
Do NOT include F&O expiry dates.
Only include events you are 100% certain about. Skip if unsure.
No headers. No explanation.`;

    // Use cheapest model
    const model = 'gemini-1.5-flash';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 600 }
        })
      }
    );

    let aiEvents = [];
    if (geminiRes.ok) {
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      aiEvents = parseEvents(raw) || [];
    }
    // If Gemini fails quota — no problem, F&O events still show from math

    // ── Step 3: Merge F&O (math) + AI events ───────────────────────────
    const seen = new Set(ruleEvents.map(e => e.date + e.title.toLowerCase()));
    const merged = [...ruleEvents];
    for (const e of aiEvents) {
      const key = e.date + e.title.toLowerCase();
      if (!seen.has(key)) { merged.push(e); seen.add(key); }
    }

    merged.sort((a, b) => a.date > b.date ? 1 : -1);
    await writeToSheet(merged);

    return res.status(200).json({
      success: true,
      model,
      fo_count: ruleEvents.length,
      ai_count: aiEvents.length,
      total: merged.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
