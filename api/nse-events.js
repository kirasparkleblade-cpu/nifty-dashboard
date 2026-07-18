// api/nse-events.js
// NSE blocks direct/unauthenticated hits to its API — it requires a session
// cookie obtained by first visiting the homepage with browser-like headers.
// This proxy replicates that handshake, then calls event-calendar.
//
// NOTE: NSE does not publish a schema for this endpoint and its field names
// have changed before without notice. This handler tries several likely key
// names per event and also returns `raw` (first 2 records untouched) so you
// can see the real shape and adjust FIELD MAPPING below in one place if a
// field comes back empty.

const BASE_URL = "https://www.nseindia.com/";
const EVENT_URL = "https://www.nseindia.com/api/event-calendar";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-encoding": "gzip, deflate, br",
  "referer": BASE_URL,
};

// NSE's own frontend sends these on the actual XHR call to /api/* endpoints —
// a bare server-to-server request without them is one of the easier ways
// for their WAF to tell it isn't a real browser tab making the call.
const API_HEADERS = {
  ...BROWSER_HEADERS,
  accept: "application/json, text/plain, */*",
  "x-requested-with": "XMLHttpRequest",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

function formatDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

// Best-effort category detection from the event's purpose/subject text.
function categorize(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("result")) return "Earnings";
  if (t.includes("dividend")) return "Dividend";
  if (t.includes("bonus") || t.includes("split") || t.includes("buyback")) return "Corp Action";
  if (t.includes("agm") || t.includes("egm") || t.includes("annual general") || t.includes("general meeting")) return "AGM/EGM";
  if (t.includes("board meeting") || t.includes("bm ")) return "Board Meeting";
  return "Other";
}

export default async function handler(req, res) {
  try {
    const today = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);

    const fromDate = req.query?.from_date || formatDDMMYYYY(today);
    const toDate = req.query?.to_date || formatDDMMYYYY(to);
    const index = req.query?.index || "equities";

    // Step 1: hit the homepage to get a session cookie.
    const homeRes = await fetch(BASE_URL, { headers: BROWSER_HEADERS });
    const setCookie = homeRes.headers.get("set-cookie") || "";
    // Node's fetch collapses multiple Set-Cookie headers into one string
    // separated by commas in some runtimes — extract name=value pairs safely.
    const cookieHeader = setCookie
      .split(/,(?=[^;]+?=)/)
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    // Step 2: call the actual event-calendar endpoint with that cookie.
    const url = `${EVENT_URL}?index=${encodeURIComponent(index)}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`;

    const upstream = await fetch(url, {
      headers: {
        ...API_HEADERS,
        cookie: cookieHeader,
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Upstream fetch failed",
        status: upstream.status,
      });
    }

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      // NSE returned something that isn't JSON — almost always a bot-block
      // or captcha HTML page even on a 200 status. Surface a snippet so we
      // can see exactly what it was instead of a generic parse error.
      return res.status(502).json({
        error: "NSE returned non-JSON response (likely a bot-block page)",
        bodySnippet: rawText.slice(0, 300),
      });
    }
    const list = Array.isArray(data) ? data : data?.data || [];

    const events = list.map((ev) => {
      const symbol = pick(ev, ["symbol", "SYMBOL", "Symbol"]);
      const company = pick(ev, ["company", "companyName", "COMPANY", "comp"]);
      const purpose = pick(ev, ["purpose", "bm_desc", "subject", "PURPOSE", "description"]);
      const date = pick(ev, ["date", "bm_date", "boardMeetingDate", "meetingDate", "DATE"]);

      return {
        symbol,
        company,
        purpose,
        date, // raw NSE date string, format may be DD-MMM-YYYY
        category: categorize(purpose),
      };
    });

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      count: events.length,
      updatedAt: new Date().toISOString(),
      events,
      raw: list.slice(0, 2), // debug aid — remove once field mapping is confirmed
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
