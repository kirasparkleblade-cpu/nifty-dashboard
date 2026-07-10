// api/niftybank.js
// Vercel serverless proxy for Bank Nifty spot price.
// PRIMARY: NSE's own allIndices endpoint — same cookie handshake already
// working reliably for VIX in nifty-bias.js.
// FALLBACK: Yahoo v8 chart with cookie+crumb auth.
//
// NOTE: this file is fully self-contained (no cross-file imports) —
// deliberately, after a cross-file import to a shared helper caused a
// silent 500 on every single request (crashed before reaching any
// try/catch, so no error detail even reached the response body).

const NSE_BASE = "https://www.nseindia.com/";
const NSE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "accept": "*/*",
  "referer": NSE_BASE,
};

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let yahooSessionCache = null;
let yahooSessionExpiry = 0;

async function getYahooSession() {
  if (yahooSessionCache && Date.now() < yahooSessionExpiry) return yahooSessionCache;

  const homeRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": YAHOO_UA },
    redirect: "manual",
  });
  const setCookie = homeRes.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("Yahoo cookie fetch -> no Set-Cookie returned by fc.yahoo.com");

  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": YAHOO_UA, cookie },
  });
  if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch -> HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("<html")) throw new Error("Yahoo crumb fetch -> invalid crumb");

  yahooSessionCache = { cookie, crumb };
  yahooSessionExpiry = Date.now() + 10 * 60 * 1000;
  return yahooSessionCache;
}

async function getNseCookie() {
  const homeRes = await fetch(NSE_BASE, { headers: NSE_HEADERS });
  const setCookie = homeRes.headers.get("set-cookie") || "";
  return setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchFromNse() {
  const cookie = await getNseCookie();
  const res = await fetch("https://www.nseindia.com/api/allIndices", {
    headers: { ...NSE_HEADERS, cookie },
  });
  if (!res.ok) throw new Error(`NSE allIndices -> HTTP ${res.status}`);
  const data = await res.json();
  const row = data?.data?.find((i) => (i.index || "").toUpperCase() === "NIFTY BANK");
  if (!row) throw new Error("NSE allIndices -> NIFTY BANK row not found");

  return {
    symbol: "BANK NIFTY",
    price: row.last,
    prevClose: row.previousClose,
    change: row.variation,
    changePct: row.percentChange,
    dayHigh: row.high,
    dayLow: row.low,
    marketState: null,
    currency: "INR",
    updatedAt: new Date().toISOString(),
    source: "nse-allIndices",
  };
}

async function fetchFromYahoo() {
  const session = await getYahooSession();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEBANK?interval=1d&range=1d&crumb=${encodeURIComponent(
    session.crumb
  )}`;
  const upstream = await fetch(url, {
    headers: { "User-Agent": YAHOO_UA, cookie: session.cookie },
  });
  if (!upstream.ok) throw new Error(`Yahoo fallback -> HTTP ${upstream.status}`);
  const data = await upstream.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo fallback -> malformed response");
  const meta = result.meta;

  return {
    symbol: "BANK NIFTY",
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose,
    change: meta.regularMarketPrice - meta.chartPreviousClose,
    changePct: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    marketState: meta.marketState,
    currency: meta.currency,
    updatedAt: new Date().toISOString(),
    source: "yahoo-v8-chart",
  };
}

export default async function handler(req, res) {
  let payload;
  let nseError = null;

  try {
    payload = await fetchFromNse();
  } catch (err) {
    nseError = err.message;
    try {
      payload = await fetchFromYahoo();
    } catch (yahooErr) {
      return res.status(502).json({
        error: "Both NSE and Yahoo fetch failed",
        nseError,
        yahooError: yahooErr.message,
      });
    }
  }

  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json(payload);
}
