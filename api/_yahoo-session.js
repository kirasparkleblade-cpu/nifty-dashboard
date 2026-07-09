// api/_yahoo-session.js
// Shared helper: Yahoo now gates index tickers (anything starting with ^)
// behind a session cookie + crumb token on both v7 quote and v8 chart —
// confirmed live: CL=F and INR=X worked unauthenticated while
// ^NSEI/^NSEBANK/^DJI/^N225/^VIX all 404'd. Non-index symbols don't need
// this. Cached at module scope so a warm Lambda container reuses the
// session instead of re-authenticating on every request.
//
// Import into any proxy with:
//   import { yahooFetch } from "./_yahoo-session.js";

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let sessionCache = null;
let sessionExpiry = 0;

async function getYahooSession() {
  if (sessionCache && Date.now() < sessionExpiry) return sessionCache;

  const homeRes = await fetch("https://finance.yahoo.com", {
    headers: { "User-Agent": YAHOO_UA },
  });
  const setCookie = homeRes.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": YAHOO_UA, cookie },
  });
  if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch -> HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("<html")) throw new Error("Yahoo crumb fetch -> invalid crumb");

  sessionCache = { cookie, crumb };
  sessionExpiry = Date.now() + 10 * 60 * 1000; // 10 min
  return sessionCache;
}

function isIndexSymbol(symbol) {
  return symbol.includes("%5E") || symbol.startsWith("^");
}

// Fetches any Yahoo Finance URL, auto-attaching cookie+crumb if the symbol
// embedded in it looks like an index ticker. `symbol` should be the raw (or
// URL-encoded) ticker, e.g. "%5ENSEI" or "^NSEI".
export async function yahooFetch(url, symbol) {
  const headers = { "User-Agent": YAHOO_UA };
  let finalUrl = url;

  if (isIndexSymbol(symbol)) {
    const session = await getYahooSession();
    finalUrl += (url.includes("?") ? "&" : "?") + `crumb=${encodeURIComponent(session.crumb)}`;
    headers.cookie = session.cookie;
  }

  return fetch(finalUrl, { headers });
}
