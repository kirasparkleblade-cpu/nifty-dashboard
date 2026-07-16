// lib/heikinAshi.js
// Converts regular OHLC candles to Heikin Ashi, then looks for the specific 3-candle
// setup from your chart screenshots:
//   - 3 consecutive RED Heikin Ashi candles
//   - each with (essentially) no upper wick, i.e. HA-high == HA-open (flat top)
//   - each candle stepping DOWN from the previous one (a descending staircase)
//   - the high-to-low range across all 3 candles is < 5%
//
// The zone high/low returned uses the *real* (non-HA) OHLC of those 3 candles, since that's
// what price actually needs to trade through to "break out" the next day.

const NO_WICK_TOLERANCE = 0.001; // 0.1% - candles are rarely a mathematically perfect flat top
const MAX_ZONE_RANGE_PCT = 5; // the ask: high/low range across the 3 candles must be < 5%

function toHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].haOpen + ha[i - 1].haClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    ha.push({
      date: c.date,
      real: c,
      haOpen,
      haHigh,
      haLow,
      haClose,
      isRed: haClose < haOpen,
    });
  }
  return ha;
}

function hasNoUpperWick(candle) {
  const bodyTop = Math.max(candle.haOpen, candle.haClose);
  if (candle.haHigh <= 0) return false;
  return (candle.haHigh - bodyTop) / candle.haHigh <= NO_WICK_TOLERANCE;
}

/**
 * Looks at the most recent fully-closed candles and checks whether the last 3 form the pattern.
 * Returns a zone object or null.
 */
function detectThreeRedStaircase(haCandles) {
  if (haCandles.length < 3) return null;
  const n = haCandles.length;
  const [c1, c2, c3] = [haCandles[n - 3], haCandles[n - 2], haCandles[n - 1]];

  const allRed = c1.isRed && c2.isRed && c3.isRed;
  if (!allRed) return null;

  const allFlatTop = hasNoUpperWick(c1) && hasNoUpperWick(c2) && hasNoUpperWick(c3);
  if (!allFlatTop) return null;

  // descending staircase: each candle's body sits at or below the previous one's
  const stepsDown =
    c2.haOpen <= c1.haOpen + c1.haOpen * 0.0005 &&
    c3.haOpen <= c2.haOpen + c2.haOpen * 0.0005 &&
    c2.haHigh <= c1.haHigh &&
    c3.haHigh <= c2.haHigh;
  if (!stepsDown) return null;

  const realHigh = Math.max(c1.real.high, c2.real.high, c3.real.high);
  const realLow = Math.min(c1.real.low, c2.real.low, c3.real.low);
  const rangePct = ((realHigh - realLow) / realLow) * 100;
  if (rangePct >= MAX_ZONE_RANGE_PCT) return null;

  return {
    zoneHigh: realHigh,
    zoneLow: realLow,
    rangePct,
    startDate: c1.date,
    endDate: c3.date,
    candles: [c1, c2, c3],
  };
}

module.exports = { toHeikinAshi, detectThreeRedStaircase, hasNoUpperWick };
