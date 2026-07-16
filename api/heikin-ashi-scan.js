// api/heikin-ashi-scan.js
// GET /api/heikin-ashi-scan
// Scans the NSE midcap + smallcap universe on the daily timeframe for the 3-red-candle
// Heikin Ashi staircase setup, and reports whether the most recent candle has already
// opened above the zone high (i.e. the breakout already happened).

const { getStockUniverse } = require("../lib/nseStocks");
const { fetchDailyOHLC, runWithConcurrency } = require("../lib/yahoo");
const { toHeikinAshi, detectThreeRedStaircase } = require("../lib/heikinAshi");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");

  try {
    const { symbols, source, error: universeError } = await getStockUniverse();

    const scanned = await runWithConcurrency(
      symbols,
      async (symbol) => {
        const candles = await fetchDailyOHLC(symbol, 40);
        if (candles.length < 4) return null;

        // The most recent candle may still be "live" (today, mid-session). Pattern detection
        // should run on the last 3 *fully closed* candles, so if the last candle is today and
        // the market's still open we exclude it from the pattern window but still use it to
        // check for a breakout above a zone found in the prior 3.
        const closed = candles.slice(0, -1);
        const latest = candles[candles.length - 1];

        // Try pattern on fully-closed candles ending yesterday...
        const haClosed = toHeikinAshi(closed);
        const zoneFromClosed = detectThreeRedStaircase(haClosed);

        // ...and also on the full set in case today's candle is itself a closed EOD candle
        // (e.g. you're checking after market hours).
        const haFull = toHeikinAshi(candles);
        const zoneFromFull = detectThreeRedStaircase(haFull.slice(0, -1));

        const zone = zoneFromClosed || zoneFromFull;
        if (!zone) return null;

        const breakoutTriggered = latest.open > zone.zoneHigh;

        return {
          symbol,
          zoneHigh: round2(zone.zoneHigh),
          zoneLow: round2(zone.zoneLow),
          rangePct: round2(zone.rangePct),
          zoneStart: zone.startDate,
          zoneEnd: zone.endDate,
          latestDate: latest.date,
          latestOpen: round2(latest.open),
          latestClose: round2(latest.close),
          status: breakoutTriggered ? "BREAKOUT" : "WATCHING",
        };
      },
      15
    );

    const matches = scanned.filter((r) => r && !r.error);
    matches.sort((a, b) => (a.status === b.status ? 0 : a.status === "BREAKOUT" ? -1 : 1));

    res.status(200).json({
      scannedAt: new Date().toISOString(),
      universeSize: symbols.length,
      universeSource: source,
      universeWarning: universeError || null,
      matchCount: matches.length,
      matches,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}
