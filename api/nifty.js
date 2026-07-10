// api/nifty.js
// Vercel serverless proxy for NIFTY 50 spot price.
// PRIMARY: NSE's own allIndices endpoint — same cookie handshake already
// working reliably for VIX in nifty-bias.js. This is the exchange's own
// data, not a reverse-engineered scrape of a third party, so it's the more
// durable choice long-term.
// FALLBACK: Yahoo v8 chart with cookie+crumb auth (see _yahoo-session.js) —
// kept in case NSE itself is rate-limiting at the moment of the request.

import { yahooFetch } from "./_yahoo-session.js";

const NSE_BASE = "https://www.nseindia.com/";
const NSE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "accept": "*/*",
  "referer": NSE_BASE,
};

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
  const row = data?.data?.find((i) => (i.index || "").toUpperCase() === "NIFTY 50");
  if (!row) throw new Error("NSE allIndices -> NIFTY 50 row not found");

  return {
    symbol: "NIFTY 50",
    price: row.last,
    prevClose: row.previousClose,
    change: row.variation,
    changePct: row.percentChange,
    dayHigh: row.high,
    dayLow: row.low,
    marketState: null, // NSE allIndices doesn't expose this directly
    currency: "INR",
    updatedAt: new Date().toISOString(),
    source: "nse-allIndices",
  };
}

async function fetchFromYahoo() {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1d";
  const upstream = await yahooFetch(url, "%5ENSEI");
  if (!upstream.ok) throw new Error(`Yahoo fallback -> HTTP ${upstream.status}`);
  const data = await upstream.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo fallback -> malformed response");
  const meta = result.meta;

  return {
    symbol: "NIFTY 50",
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
