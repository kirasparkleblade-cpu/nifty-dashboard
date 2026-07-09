// api/niftybank.js
// Vercel serverless proxy — bypasses Yahoo Finance CORS block for browser fetches.
// Uses the v7 quote endpoint (different shape than v8 chart, used for NIFTY 50).

export default async function handler(req, res) {
  try {
    const url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5ENSEBANK";

    const upstream = await fetch(url, {
      headers: {
        // Yahoo blocks requests with no user-agent
        "User-Agent": "Mozilla/5.0 (compatible; QuantMonarchWidget/1.0)"
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream fetch failed" });
    }

    const data = await upstream.json();
    const result = data?.quoteResponse?.result?.[0];

    if (!result) {
      return res.status(502).json({ error: "Malformed upstream response" });
    }

    const payload = {
      symbol: "BANK NIFTY",
      price: result.regularMarketPrice,
      prevClose: result.regularMarketPreviousClose,
      change: result.regularMarketChange,
      changePct: result.regularMarketChangePercent,
      dayHigh: result.regularMarketDayHigh,
      dayLow: result.regularMarketDayLow,
      marketState: result.marketState,
      currency: result.currency,
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
