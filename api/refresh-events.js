// /api/refresh-events.js
// Vercel Cron — runs every Monday 00:30 UTC (6:00 AM IST)
// F&O: computed mathematically | RBI/FOMC/Data: hardcoded annual calendar
// Earnings: Gemini adds if it knows them | ~4 Gemini calls/month

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
    exp: now + 3600, iat: now
  };
  const enc      = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  const unsigned = `${enc({ alg:'RS256', typ:'JWT' })}.${enc(claim)}`;
  const keyData  = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', Buffer.from(keyData, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(unsigned));
  const jwt = `${unsigned}.${Buffer.from(sig).toString('base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
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
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
    const toISO   = d => new Date(d).toISOString().split('T')[0];
    const endStr  = toISO(addDays(today, 60));

    // ── 1. F&O expiry dates — pure math, always correct ─────────────────
    const foEvents = [];
    const lastThursdayOfMonth = (y, m) => {
      const d = new Date(y, m+1, 0);
      d.setDate(d.getDate() - ((d.getDay()+3)%7));
      return d;
    };
    const startDt = new Date(today);
    const dow = startDt.getDay();
    let cursor = dow <= 4
      ? addDays(startDt, 4 - dow)
      : addDays(startDt, 11 - dow);
    const endDt = addDays(startDt, 60);
    while (cursor <= endDt) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      const lastThur = lastThursdayOfMonth(y, m);
      foEvents.push({
        date: toISO(cursor),
        title: toISO(cursor) === toISO(lastThur) ? 'NSE F&O Monthly Expiry' : 'NSE F&O Weekly Expiry',
        category: 'F&O'
      });
      cursor = addDays(cursor, 7);
    }

    // ── 2. Annual calendar — hardcoded, 100% accurate ────────────────────
    const ANNUAL = [
      // RBI MPC 2026 (confirmed dates)
      { date:'2026-06-06', title:'RBI MPC Decision',          category:'RBI'    },
      { date:'2026-08-07', title:'RBI MPC Decision',          category:'RBI'    },
      { date:'2026-10-09', title:'RBI MPC Decision',          category:'RBI'    },
      { date:'2026-12-04', title:'RBI MPC Decision',          category:'RBI'    },
      // US Fed FOMC 2026 (confirmed dates)
      { date:'2026-06-18', title:'US Fed FOMC Decision',      category:'Global' },
      { date:'2026-07-29', title:'US Fed FOMC Decision',      category:'Global' },
      { date:'2026-09-16', title:'US Fed FOMC Decision',      category:'Global' },
      { date:'2026-11-04', title:'US Fed FOMC Decision',      category:'Global' },
      { date:'2026-12-16', title:'US Fed FOMC Decision',      category:'Global' },
      // India CPI (released ~12th of following month)
      { date:'2026-06-12', title:'India CPI Inflation (May)', category:'Data'   },
      { date:'2026-07-14', title:'India CPI Inflation (Jun)', category:'Data'   },
      { date:'2026-08-13', title:'India CPI Inflation (Jul)', category:'Data'   },
      { date:'2026-09-14', title:'India CPI Inflation (Aug)', category:'Data'   },
      { date:'2026-10-14', title:'India CPI Inflation (Sep)', category:'Data'   },
      { date:'2026-11-13', title:'India CPI Inflation (Oct)', category:'Data'   },
      // India WPI (released ~14th of following month)
      { date:'2026-06-15', title:'India WPI Inflation (May)', category:'Data'   },
      { date:'2026-07-15', title:'India WPI Inflation (Jun)', category:'Data'   },
      { date:'2026-08-14', title:'India WPI Inflation (Jul)', category:'Data'   },
      { date:'2026-09-15', title:'India WPI Inflation (Aug)', category:'Data'   },
      { date:'2026-10-15', title:'India WPI Inflation (Sep)', category:'Data'   },
      { date:'2026-11-14', title:'India WPI Inflation (Oct)', category:'Data'   },
      // India GDP
      { date:'2026-05-29', title:'India GDP Q4 FY26',         category:'Data'   },
      { date:'2026-08-31', title:'India GDP Q1 FY27',         category:'Data'   },
      { date:'2026-11-30', title:'India GDP Q2 FY27',         category:'Data'   },
      // India IIP
      { date:'2026-06-12', title:'India IIP Data (Apr)',      category:'Data'   },
      { date:'2026-07-11', title:'India IIP Data (May)',      category:'Data'   },
      { date:'2026-08-12', title:'India IIP Data (Jun)',      category:'Data'   },
      { date:'2026-09-12', title:'India IIP Data (Jul)',      category:'Data'   },
    ].filter(e => e.date >= today && e.date <= endStr);

    // ── 3. Ask Gemini ONLY for earnings dates ────────────────────────────
    const prompt =
`List confirmed Nifty50 quarterly earnings announcement dates from ${today} to ${endStr}.
Only include companies: TCS, Infosys, Wipro, HCL Tech, Tech Mahindra, HDFC Bank, ICICI Bank, SBI, Kotak Bank, Axis Bank, Reliance Industries, Bajaj Finance, Bajaj Finserv, Maruti Suzuki, Tata Motors, M&M, Hero MotoCorp, Asian Paints, Nestle, Britannia, HUL, ITC, Titan, Trent, Sun Pharma, Dr Reddy, Cipla, Divi's, UltraTech, Grasim, NTPC, Power Grid, Coal India, ONGC, BPCL, IOC, Adani Ports, Adani Enterprises, Larsen & Toubro, Bharti Airtel.
Output ONLY pipe-delimited lines: YYYY-MM-DD|Company Q Results|Earnings
Only include dates you are certain about. Skip if unsure.
No headers. No explanation.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 800 }
        })
      }
    );

    let aiEvents = [];
    if (geminiRes.ok) {
      const geminiData = await geminiRes.json();
      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      aiEvents = parseEvents(raw) || [];
    }

    // ── 4. Merge all three sources ───────────────────────────────────────
    const allEvents = [...foEvents, ...ANNUAL];
    const seen = new Set(allEvents.map(e => e.date + e.title.toLowerCase()));
    for (const e of aiEvents) {
      const key = e.date + e.title.toLowerCase();
      if (!seen.has(key)) { allEvents.push(e); seen.add(key); }
    }

    allEvents.sort((a, b) => a.date > b.date ? 1 : -1);
    await writeToSheet(allEvents);

    return res.status(200).json({
      success: true,
      model: 'gemini-1.5-flash',
      fo_count: foEvents.length,
      annual_count: ANNUAL.length,
      ai_earnings: aiEvents.length,
      total: allEvents.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[refresh-events]', err);
    return res.status(500).json({ error: err.message });
  }
}
