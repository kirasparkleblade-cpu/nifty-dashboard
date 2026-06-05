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
  const claudeKey = process.env.DEEPSEEK_API_KEY;
  if (!claudeKey) return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set' });

  try {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today  = istNow.toISOString().split('T')[0];
    const endDt  = new Date(today); endDt.setDate(endDt.getDate() + 60);
    const endStr = endDt.toISOString().split('T')[0];

    // ── Step 1: Generate rule-based events (zero hallucination) ──────────
    // These are computed mathematically — no AI needed, always correct
    const ruleEvents = [];

    // Every Thursday = NSE F&O Weekly Expiry
    // Last Thursday of month = Monthly Expiry instead
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
    const toISO   = d => d.toISOString().split('T')[0];
    const lastThursdayOfMonth = (y, m) => {
      const d = new Date(y, m+1, 0); // last day of month
      d.setDate(d.getDate() - ((d.getDay()+3)%7)); // back to Thursday
      return d;
    };

    // Find first Thursday on or after today
    const startDt = new Date(today);
    const dow = startDt.getDay(); // 0=Sun,4=Thu
    const daysToThur = (4 - dow + 7) % 7;
    let cursor = addDays(startDt, daysToThur);
    const endDt2 = new Date(endStr);

    while (cursor <= endDt2) {
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

    // ── Step 2: Ask AI only for events it CANNOT hallucinate dates for ────
    // RBI MPC, FOMC, Earnings — AI knows these from training, but we
    // instruct it to only output dates it is 100% certain about.
    const prompt =
`Today is ${today}. List ONLY confirmed Indian market events from ${today} to ${endStr} that you are 100% certain about.
STRICT RULES:
- Only include events with exact confirmed dates (not approximate)
- Do NOT include NSE F&O expiry dates (already handled)
- Only include: RBI MPC decisions, US Fed FOMC decisions, India CPI/WPI/GDP/IIP data releases, confirmed Nifty50 earnings dates
- If you are not 100% sure of the exact date, SKIP that event entirely
- Output ONLY pipe-delimited lines: YYYY-MM-DD|Title max 7 words|Category
- Category must be one of: RBI F&O Budget Earnings Global Data Other
- No headers. No explanation. No markdown.`;

    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${claudeKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1200
      })
    });

    if (!dsRes.ok) {
      const err = await dsRes.json();
      throw new Error('DeepSeek error: ' + (err?.error?.message || dsRes.status));
    }

    const dsData = await dsRes.json();
    const raw = dsData?.choices?.[0]?.message?.content || '';

    // Parse AI additions (RBI, FOMC, Earnings, Data releases)
    const aiEvents = parseEvents(raw) || [];

    // Merge rule-based (F&O) + AI (everything else) — deduplicated
    const seen = new Set(ruleEvents.map(e => e.date + e.title.toLowerCase()));
    const merged = [...ruleEvents];
    for (const e of aiEvents) {
      const key = e.date + e.title.toLowerCase();
      if (!seen.has(key)) { merged.push(e); seen.add(key); }
    }

    if (!merged.length) throw new Error('No events. Raw: ' + raw.slice(0, 200));
    merged.sort((a, b) => a.date > b.date ? 1 : -1);
    await writeToSheet(merged);

    return res.status(200).json({
      success: true,
      model: 'deepseek-chat',
      count: merged.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
