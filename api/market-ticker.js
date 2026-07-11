// api/market-ticker.js
// Single batched Yahoo v7 quote call for a horizontal ticker widget.
// v7 accepts comma-separated symbols in one request, so this is one Yahoo
// call for the whole list instead of 26 separate ones.
//
// Self-contained (no cross-file imports) — deliberately, after a cross-file
// import caused a silent crash on another proxy in this project.
//
// CAVEAT: some Nifty sector index tickers (^CNXIT, ^CNXAUTO, etc.) have
// spotty/inconsistent coverage on Yahoo — a few may simply not resolve.
// This proxy filters those out silently rather than erroring the whole
// batch; check the `missing` array in the response to see which ones didn't
// come back.

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

// symbol -> short display label for the ticker card
const INSTRUMENTS = [
  ["%5EGSPC", "S&P 500"],
  ["%5EIXIC", "Nasdaq"],
  ["%5EDJI", "Dow Jones"],
  ["%5EN225", "Nikkei 225"],
  ["%5EHSI", "Hang Seng"],
  ["000001.SS", "Shanghai"],
  ["%5EKS11", "KOSPI"],
  ["%5EFTSE", "FTSE 100"],
  ["%5EGDAXI", "DAX"],
  ["%5EFCHI", "CAC 40"],
  ["BZ=F", "Brent Crude"],
  ["INR=X", "USD/INR"],
  ["%5ETNX", "US 10Y Yield"],
  ["%5ECNXFINSERVICE", "Nifty Fin Services"],
  ["%5ECNXIT", "Nifty IT"],
  ["%5ECNXAUTO", "Nifty Auto"],
  ["%5ECNXFMCG", "Nifty FMCG"],
  ["%5ECNXPHARMA", "Nifty Pharma"],
  ["%5ECNXHEALTHCARE", "Nifty Healthcare"],
  ["%5ECNXMETAL", "Nifty Metal"],
  ["%5ECNXENERGY", "Nifty Energy"],
  ["%5ECNXOILANDGAS", "Nifty Oil & Gas"],
  ["%5ECNXREALTY", "Nifty Realty"],
  ["%5ECNXMEDIA", "Nifty Media"],
  ["%5ECNXPSUBANK", "Nifty PSU Bank"],
  ["%5ECNXPVTBANK", "Nifty Pvt Bank"],
  ["BTC-USD", "Bitcoin"],
  ["ETH-USD", "Ethereum"],
  ["SOL-USD", "Solana"],
  ["BNB-USD", "BNB"],
  ["XRP-USD", "XRP"],
];

export default async function handler(req, res) {
  try {
    const session = await getYahooSession();
    const symbolsParam = INSTRUMENTS.map(([sym]) => sym).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbolsParam}&crumb=${encodeURIComponent(
      session.crumb
    )}`;

    const upstream = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA, cookie: session.cookie },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Yahoo batch quote -> HTTP ${upstream.status}` });
    }

    const data = await upstream.json();
    const results = data?.quoteResponse?.result || [];

    // Yahoo returns results keyed by symbol; the raw symbol in the
    // response uses the actual ticker text (e.g. "^GSPC"), not the
    // URL-encoded form, so match by decoding our list's symbols too.
    const byTicker = {};
    for (const r of results) byTicker[r.symbol] = r;

    const items = [];
    const missing = [];

    for (const [encodedSym, label] of INSTRUMENTS) {
      const rawSym = decodeURIComponent(encodedSym);
      const r = byTicker[rawSym];
      if (!r || r.regularMarketPrice == null) {
        missing.push(label);
        continue;
      }
      items.push({
        label,
        symbol: rawSym,
        price: r.regularMarketPrice,
        change: r.regularMarketChange,
        changePct: r.regularMarketChangePercent,
        currency: r.currency || "",
      });
    }

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      items,
      missing, // labels that didn't resolve — check here if the widget looks sparse
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
