// api/nifty-bias.js
// Aggregates everything the NIFTY 50 Bias widget needs into one response,
// in the same KEY: VALUE shape the widget's textarea parser already expects.
//
// Sources:
//   Yahoo v8 chart  -> NIFTY historicals (EMA20/DMA200/RSI/MACD/trend/prev candle),
//                       Dow Jones, Nikkei (Asia proxy)
//   NSE (cookie handshake, same pattern as api/nse-events.js)
//                   -> India VIX, option-chain (PCR/OI/Max Pain), FII cash flows
//
// CAVEATS (be aware before trusting this at market open):
//  - GIFT_NIFTY is not available from either source — left as "N/A".
//  - NSE's option-chain and fiidiiTradeReact endpoints are its most
//    aggressively bot-protected. They can intermittently fail or rate-limit
//    even with a valid cookie. Each section fails independently — if NSE
//    blocks the option-chain call, you still get Yahoo-derived technicals.
//  - FII data is provisional/T+1 per NSE's own disclaimer.

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

async function nseFetch(path, cookie) {
  const res = await fetch(`https://www.nseindia.com${path}`, {
    headers: { ...NSE_HEADERS, cookie },
  });
  if (!res.ok) throw new Error(`NSE ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function yahooDaily(symbol, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; QuantMonarchWidget/1.0)" },
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} -> HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} -> malformed response`);
  const closes = result.indicators.quote[0].close.filter((c) => c != null);
  const opens = result.indicators.quote[0].open.filter((c) => c != null);
  return { meta: result.meta, closes, opens };
}

// ── Indicator math ──────────────────────────────────────────────────────
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaVal = values[0];
  const out = [emaVal];
  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
    out.push(emaVal);
  }
  return out;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macdLine(values) {
  if (values.length < 26) return null;
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  return ema12[ema12.length - 1] - ema26[ema26.length - 1];
}

// ── Max Pain from option chain ─────────────────────────────────────────
function computeMaxPain(chain) {
  const strikes = [...new Set(chain.map((c) => c.strikePrice))];
  let bestStrike = null;
  let minPain = Infinity;
  for (const S of strikes) {
    let pain = 0;
    for (const c of chain) {
      const K = c.strikePrice;
      if (c.CE) pain += (c.CE.openInterest || 0) * Math.max(0, S - K);
      if (c.PE) pain += (c.PE.openInterest || 0) * Math.max(0, K - S);
    }
    if (pain < minPain) {
      minPain = pain;
      bestStrike = S;
    }
  }
  return bestStrike;
}

function computePCR(chain) {
  let ceOI = 0,
    peOI = 0;
  for (const c of chain) {
    if (c.CE) ceOI += c.CE.openInterest || 0;
    if (c.PE) peOI += c.PE.openInterest || 0;
  }
  if (ceOI === 0) return null;
  return peOI / ceOI;
}

function computeAtmBuildup(chain, spot) {
  let closest = chain[0];
  let minDiff = Infinity;
  for (const c of chain) {
    const diff = Math.abs(c.strikePrice - spot);
    if (diff < minDiff) {
      minDiff = diff;
      closest = c;
    }
  }
  const ceChg = closest.CE?.changeinOpenInterest || 0;
  const peChg = closest.PE?.changeinOpenInterest || 0;
  if (peChg > ceChg && peChg > 0) return "PE buildup (support forming)";
  if (ceChg > peChg && ceChg > 0) return "CE buildup (resistance forming)";
  return "No clear buildup";
}

export default async function handler(req, res) {
  const out = {};
  const errors = {};

  // ── NIFTY technicals from Yahoo ──────────────────────────────────────
  let spot = null;
  try {
    const { meta, closes, opens } = await yahooDaily("%5ENSEI", "1y");
    spot = meta.regularMarketPrice;
    const ema20 = ema(closes, 20);
    const dma200 = sma(closes, 200);
    const rsiVal = rsi(closes, 14);
    const macdVal = macdLine(closes);
    const lastClose = closes[closes.length - 1];
    const lastOpen = opens[opens.length - 1];

    out.EMA20 = lastClose > ema20[ema20.length - 1] ? "Above" : "Below";
    out.DMA200 = dma200 ? (lastClose > dma200 ? "Above" : "Below") : "N/A";
    out.RSI = rsiVal
      ? rsiVal > 60
        ? `Bullish ${rsiVal.toFixed(1)}`
        : rsiVal < 40
        ? `Bearish ${rsiVal.toFixed(1)}`
        : `Neutral ${rsiVal.toFixed(1)}`
      : "N/A";
    out.MACD = macdVal !== null ? (macdVal > 0 ? "Above Zero" : "Below Zero") : "N/A";
    out.TREND =
      dma200 && lastClose > ema20[ema20.length - 1] && ema20[ema20.length - 1] > dma200
        ? "Uptrend"
        : dma200 && lastClose < ema20[ema20.length - 1] && ema20[ema20.length - 1] < dma200
        ? "Downtrend"
        : "Sideways";
    out.PREV_CANDLE = lastClose > lastOpen ? "Bullish" : "Bearish";
  } catch (err) {
    errors.technicals = err.message;
  }

  // ── Dow Jones ─────────────────────────────────────────────────────────
  try {
    const { meta } = await yahooDaily("%5EDJI", "5d");
    const chg = meta.regularMarketPrice - meta.chartPreviousClose;
    out.DOW_JONES = `${chg >= 0 ? "Up" : "Down"} ${chg >= 0 ? "+" : ""}${chg.toFixed(0)}`;
  } catch (err) {
    errors.dow = err.message;
  }

  // ── Asia (Nikkei proxy) ───────────────────────────────────────────────
  try {
    const { meta } = await yahooDaily("%5EN225", "5d");
    const chg = meta.regularMarketPrice - meta.chartPreviousClose;
    out.ASIA = chg >= 0 ? "Positive" : "Negative";
  } catch (err) {
    errors.asia = err.message;
  }

  out.GIFT_NIFTY = "N/A (not available via Yahoo/NSE public APIs)";

  // ── NSE: VIX, option chain, FII ──────────────────────────────────────
  let cookie = null;
  try {
    cookie = await getNseCookie();
  } catch (err) {
    errors.nseCookie = err.message;
  }

  if (cookie) {
    // VIX
    try {
      const idx = await nseFetch("/api/allIndices", cookie);
      const vix = idx?.data?.find((i) => (i.index || "").toUpperCase().includes("VIX"));
      out.VIX = vix ? `${vix.last} (${vix.percentChange >= 0 ? "+" : ""}${vix.percentChange}%)` : "N/A";
    } catch (err) {
      errors.vix = err.message;
    }

    // Option chain -> PCR, Max Pain, OI buildup
    try {
      const oc = await nseFetch("/api/option-chain-indices?symbol=NIFTY", cookie);
      const chain = oc?.records?.data || [];
      const underlying = oc?.records?.underlyingValue || spot;
      if (chain.length) {
        const pcr = computePCR(chain);
        out.PCR = pcr !== null ? `${pcr > 1 ? "Bullish" : "Bearish"} ${pcr.toFixed(2)}` : "N/A";
        out.OI_ATM = computeAtmBuildup(chain, underlying);
        const maxPain = computeMaxPain(chain);
        out.MAX_PAIN = maxPain ? `${underlying > maxPain ? "Above" : "Below"} ${maxPain}` : "N/A";
      }
    } catch (err) {
      errors.optionChain = err.message;
    }

    // FII cash flows
    try {
      const fii = await nseFetch("/api/fiidiiTradeReact", cookie);
      const fiiRow = Array.isArray(fii) ? fii.find((r) => (r.category || "").toUpperCase().includes("FII")) : null;
      if (fiiRow) {
        const net = parseFloat(fiiRow.netValue || fiiRow.buyValue - fiiRow.sellValue);
        out.FII = `${net >= 0 ? "Buy" : "Sell"} ₹${Math.abs(net).toFixed(0)}Cr`;
      }
    } catch (err) {
      errors.fii = err.message;
    }
  }

  // ── Macro events: reuse the event-calendar proxy logic (today/tomorrow only) ──
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const evRes = await fetch(`${proto}://${host}/api/nse-events`);
    if (evRes.ok) {
      const evData = await evRes.json();
      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
      const soon = (evData.events || []).find((e) => e.category === "Board Meeting" || (e.purpose || "").toLowerCase().includes("rbi"));
      out.MACRO_EVENT = soon ? `${soon.purpose} (${soon.company || soon.symbol || ""})` : "None flagged";
    } else {
      out.MACRO_EVENT = "N/A";
    }
  } catch (err) {
    out.MACRO_EVENT = "N/A";
    errors.macroEvent = err.message;
  }

  // ── Deterministic bias score (mirrors the widget's own fallback logic) ──
  const bullWords = ["above", "up", "bullish", "positive", "buildup (support", "buy"];
  const bearWords = ["below", "down", "bearish", "negative", "buildup (resistance", "sell"];
  let bull = 0,
    bear = 0,
    counted = 0;
  for (const key of ["EMA20", "DMA200", "RSI", "MACD", "TREND", "PREV_CANDLE", "DOW_JONES", "ASIA", "PCR", "OI_ATM", "FII"]) {
    const v = (out[key] || "").toLowerCase();
    if (!v || v === "n/a") continue;
    counted++;
    if (bullWords.some((w) => v.includes(w))) bull++;
    else if (bearWords.some((w) => v.includes(w))) bear++;
  }
  const score = counted ? Math.round(((bull - bear) / counted + 1) * 5) : 5;
  out.BIAS_SCORE = String(Math.max(0, Math.min(10, score)));
  out.BIAS = score >= 7 ? "Bullish" : score >= 6 ? "Mildly Bullish" : score <= 3 ? "Bearish" : score <= 4 ? "Mildly Bearish" : "Neutral";
  out.CONFIDENCE = counted >= 8 ? "High" : counted >= 5 ? "Medium" : "Low";
  out.SUPPORT = "auto-calc pending — add pivot logic if needed";
  out.RESISTANCE = "auto-calc pending — add pivot logic if needed";
  out.DECISION_ZONE = "—";
  out.SUMMARY = `Auto-generated from ${counted} live signals (${bull} bullish, ${bear} bearish). This is a deterministic tally, not AI-written commentary — treat as a quick signal snapshot, not investment advice.`;

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    fields: out,
    errors, // per-section failures, widget can ignore or surface these
  });
}
