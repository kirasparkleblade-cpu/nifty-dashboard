// lib/yahoo.js
// Pulls daily OHLC candles from Yahoo Finance's public chart endpoint for an NSE symbol.

async function fetchDailyOHLC(nseSymbol, rangeDays = 40) {
  const yahooSymbol = `${nseSymbol}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?interval=1d&range=3mo`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed (${res.status}) for ${yahooSymbol}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${yahooSymbol}`);

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const { open = [], high = [], low = [], close = [] } = quote;

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (
      open[i] == null ||
      high[i] == null ||
      low[i] == null ||
      close[i] == null
    ) {
      continue; // Yahoo sometimes returns null rows for halted/no-trade days
    }
    candles.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i],
    });
  }

  return candles.slice(-rangeDays);
}

// Runs an array of async jobs with a concurrency cap so we don't fire 400 requests at once.
async function runWithConcurrency(items, worker, concurrency = 15) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: String(err) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

module.exports = { fetchDailyOHLC, runWithConcurrency };
