// api/niftybank.js
// Vercel serverless proxy — bypasses Yahoo Finance CORS block for browser fetches.
// Uses the v8 chart endpoint (same as nifty.js). ^NSEBANK is an index
// ticker — Yahoo requires a session cookie + crumb for these now.
// See api/_yahoo-session.js for the shared auth helper.

import { yahooFetch } from "./_yahoo-session.js";

export default async function handler(req, res) {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEBANK?interval=1d&range=1d";

    const upstream = await yahooFetch(url, "%5ENSEBANK");

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream fetch failed" });
    }

    const data = await upstream.json();
    const result = data?.chart?.result?.[0];

    if (!result) {
      return res.status(502).json({ error: "Malformed upstream response" });
    }

    const meta = result.meta;
    const payload = {
      symbol: "BANK NIFTY",
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      change: meta.regularMarketPrice - meta.chartPreviousClose,
      changePct:
        ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      marketState: meta.marketState,
      currency: meta.currency,
      updatedAt: new Date().toISOString()
    };

    // Cache at the edge for 15s so you don't hammer Yahoo on every viewer load
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
