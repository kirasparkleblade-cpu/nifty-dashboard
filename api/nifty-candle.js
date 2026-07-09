// api/nifty-candle.js
// Vercel serverless function (Node.js runtime).
// Fetches OHLCV chart data from Yahoo Finance server-side and returns it as JSON.
// This file must NOT contain any browser code (no `document`, `window`, `canvas`, etc.)
// — it runs in Node on Vercel's servers, not in a browser.

export default async function handler(req, res) {
  try {
    const symbol = (req.query.symbol || '^NSEI').toString();
    const interval = (req.query.interval || '30m').toString();
    const range = (req.query.range || '1mo').toString();

    const yahooUrl =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

    const yahooRes = await fetch(yahooUrl, {
      headers: {
        // Yahoo blocks requests that don't look like a real browser.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!yahooRes.ok) {
      const text = await yahooRes.text().catch(() => '');
      res.status(502).json({
        chart: {
          result: null,
          error: {
            code: 'UPSTREAM_ERROR',
            description: `Yahoo Finance returned HTTP ${yahooRes.status}. ${text.slice(0, 200)}`
          }
        }
      });
      return;
    }

    const data = await yahooRes.json();

    // Cache at the edge for 60s so repeated loads don't hammer Yahoo.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({
      chart: {
        result: null,
        error: {
          code: 'FUNCTION_ERROR',
          description: err && err.message ? err.message : String(err)
        }
      }
    });
  }
}
