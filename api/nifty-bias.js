// api/nifty-bias.js
// Aggregates everything the NIFTY 50 Bias widget needs into one response,
// in the same KEY: VALUE shape the widget's textarea parser already expects.
//
// Sources:
//   Yahoo v8 chart  -> NIFTY historicals (EMA20/DMA200/RSI/MACD/trend/prev candle,
//                       pivot S/R), Dow Jones, Crude Oil, USD/INR
//   Yahoo v7 quote (with automatic v8-chart fallback if v7 fails)
//                   -> Nikkei, Shanghai, global VIX
//   api/gift-nifty  -> user-supplied Google Apps Script source for GIFT Nifty
//   NSE (cookie handshake, same pattern as api/nse-events.js)
//                   -> India VIX, option-chain (PCR/OI/Max Pain), FII cash flows
//
// CAVEATS (be aware before trusting this at market open):
//  - v7 quote (Nikkei/Shanghai/global VIX) has failed before (it's what
//    broke Bank Nifty — Yahoo sometimes requires an auth cookie/crumb for
//    v7 that v8 chart doesn't need). Each call tries v7 first and silently
//    falls back to v8 chart if it fails — check `errors.*V7` keys in the
//    response to see if fallback was used.
//  - GIFT Nifty's field names weren't verifiable ahead of time — my preview
//    tool respects robots.txt and Google Apps Script blocks it there. The
//    proxy (api/gift-nifty.js) tries several likely key names and returns
//    the raw payload for debugging if the price comes back empty.
//  - NSE's option-chain and fiidiiTradeReact endpoints are its most
//    aggressively bot-protected. They can intermittently fail or rate-limit
//    even with a valid cookie. Each section fails independently — if NSE
//    blocks the option-chain call, you still get Yahoo-derived technicals.
//  - FII data is provisional/T+1 per NSE's own disclaimer.
//  - Support/Resistance uses DAILY data (not 1m/5m) — classic pivots are
//    defined off one full previous session's H/L/C, which daily data
//    already gives exactly. Finer intraday granularity would only matter
//    for a different indicator (rolling intraday pivots), not a "better"
//    version of this one.

const NSE_BASE = "https://www.nseindia.com/";
const NSE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "accept": "*/*",
  "referer": NSE_BASE,
};

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Yahoo now gates index tickers (anything starting with ^) behind a session
// cookie + crumb token on BOTH v7 quote and v8 chart — confirmed live: CL=F
// and INR=X worked unauthenticated while ^NSEI/^DJI/^N225/^VIX all 404'd.
// Non-index symbols don't need this. Cached at module scope so a warm
// Lambda container reuses the session instead of re-authenticating on
// every request.
let yahooSessionCache = null;
let yahooSessionExpiry = 0;

async function getYahooSession() {
  if (yahooSessionCache && Date.now() < yahooSessionExpiry) return yahooSessionCache;

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

  yahooSessionCache = { cookie, crumb };
  yahooSessionExpiry = Date.now() + 10 * 60 * 1000; // 10 min
  return yahooSessionCache;
}

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
  const isIndex = symbol.includes("%5E") || symbol.startsWith("^");
  let url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${range}`;
  const headers = { "User-Agent": YAHOO_UA };

  if (isIndex) {
    const session = await getYahooSession();
    url += `&crumb=${encodeURIComponent(session.crumb)}`;
    headers.cookie = session.cookie;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Yahoo ${symbol} -> HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} -> malformed response`);
  const closes = result.indicators.quote[0].close.filter((c) => c != null);
  const opens = result.indicators.quote[0].open.filter((c) => c != null);
  const highs = result.indicators.quote[0].high.filter((c) => c != null);
  const lows = result.indicators.quote[0].low.filter((c) => c != null);
  return { meta: result.meta, closes, opens, highs, lows };
}

// v7 quote endpoint — tried first per request, since it sometimes returns
// richer fields (percent change already computed) than v8 chart. Index
// tickers need the same cookie+crumb session as v8 chart. If v7 still
// fails after that, we fall back to v8 chart for the same symbol so the
// widget doesn't go blank.
async function yahooQuoteWithFallback(symbol) {
  try {
    const isIndex = symbol.includes("%5E") || symbol.startsWith("^");
    let url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const headers = { "User-Agent": YAHOO_UA };

    if (isIndex) {
      const session = await getYahooSession();
      url += `&crumb=${encodeURIComponent(session.crumb)}`;
      headers.cookie = session.cookie;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`v7 HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.quoteResponse?.result?.[0];
    if (!result || result.regularMarketPrice == null) throw new Error("v7 malformed/empty");
    return {
      price: result.regularMarketPrice,
      prevClose: result.regularMarketPreviousClose,
      change: result.regularMarketChange,
      source: "v7-quote",
    };
  } catch (v7err) {
    // Fallback: v8 chart, 5-day range, derive change manually.
    const { meta } = await yahooDaily(symbol, "5d");
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      change: meta.regularMarketPrice - meta.chartPreviousClose,
      source: "v8-chart-fallback",
      v7Error: v7err.message,
    };
  }
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

function classicPivots(high, low, close) {
  const p = (high + low + close) / 3;
  const r1 = 2 * p - low;
  const s1 = 2 * p - high;
  const r2 = p + (high - low);
  const s2 = p - (high - low);
  return { pivot: p, r1, r2, s1, s2 };
}

export default async function handler(req, res) {
  const out = {};
  const errors = {};

  // ── NIFTY technicals from Yahoo ──────────────────────────────────────
  let spot = null;
  let pivots = null;
  try {
    const { meta, closes, opens, highs, lows } = await yahooDaily("%5ENSEI", "1y");
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

    // Pivots: use the last fully completed session. During live trading
    // hours the most recent bar is still forming, so fall back one bar.
    const idx = meta.marketState === "REGULAR" ? highs.length - 2 : highs.length - 1;
    if (idx >= 0) {
      pivots = classicPivots(highs[idx], lows[idx], closes[idx]);
    }
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

  // ── Asia: Nikkei + Shanghai ──────────────────────────────────────────
  try {
    const nikkei = await yahooQuoteWithFallback("%5EN225");
    out.NIKKEI = `${nikkei.change >= 0 ? "Up" : "Down"} ${nikkei.change >= 0 ? "+" : ""}${nikkei.change.toFixed(0)}`;
    if (nikkei.v7Error) errors.nikkeiV7 = nikkei.v7Error; // v7 failed, used v8 fallback — non-fatal
  } catch (err) {
    errors.nikkei = err.message;
  }

  try {
    const shanghai = await yahooQuoteWithFallback("000001.SS");
    out.SHANGHAI = `${shanghai.change >= 0 ? "Up" : "Down"} ${shanghai.change >= 0 ? "+" : ""}${shanghai.change.toFixed(0)}`;
    if (shanghai.v7Error) errors.shanghaiV7 = shanghai.v7Error;
  } catch (err) {
    errors.shanghai = err.message;
  }

  // Composite ASIA sentiment from whichever of the two came back.
  const asiaSignals = [out.NIKKEI, out.SHANGHAI].filter(Boolean);
  if (asiaSignals.length) {
    const upCount = asiaSignals.filter((s) => s.startsWith("Up")).length;
    out.ASIA = upCount > asiaSignals.length / 2 ? "Positive" : upCount < asiaSignals.length / 2 ? "Negative" : "Mixed";
  }

  // ── Global VIX (CBOE fear gauge — distinct from India VIX below) ────────
  try {
    const vix = await yahooQuoteWithFallback("%5EVIX");
    out.GLOBAL_VIX = `${vix.price.toFixed(1)} (${vix.change >= 0 ? "+" : ""}${vix.change.toFixed(1)})`;
    if (vix.v7Error) errors.globalVixV7 = vix.v7Error;
  } catch (err) {
    errors.globalVix = err.message;
  }

  // ── Crude Oil (WTI) ───────────────────────────────────────────────────
  try {
    const { meta } = await yahooDaily("CL=F", "5d");
    const chg = meta.regularMarketPrice - meta.chartPreviousClose;
    const pct = (chg / meta.chartPreviousClose) * 100;
    out.CRUDE_OIL = `$${meta.regularMarketPrice.toFixed(1)} (${chg >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
  } catch (err) {
    errors.crudeOil = err.message;
  }

  // ── USD/INR ───────────────────────────────────────────────────────────
  try {
    const { meta } = await yahooDaily("INR=X", "5d");
    const chg = meta.regularMarketPrice - meta.chartPreviousClose;
    out.USDINR = `₹${meta.regularMarketPrice.toFixed(2)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)})`;
  } catch (err) {
    errors.usdinr = err.message;
  }

  // ── GIFT Nifty (from user-supplied Google Apps Script source) ──────────
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const giftRes = await fetch(`${proto}://${host}/api/gift-nifty`);
    if (giftRes.ok) {
      const gift = await giftRes.json();
      if (gift.price != null) {
        const chg = gift.change != null ? gift.change : null;
        out.GIFT_NIFTY = chg != null ? `${chg >= 0 ? "Gap Up" : "Gap Down"} ${chg >= 0 ? "+" : ""}${chg}` : `${gift.price}`;
      } else {
        errors.giftNifty = "Source reachable but price field not found — check /api/gift-nifty raw output";
      }
    } else {
      errors.giftNifty = `HTTP ${giftRes.status}`;
    }
  } catch (err) {
    errors.giftNifty = err.message;
  }

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

  // ── Macro events: pull the nearest upcoming item from the event-calendar proxy ──
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const evRes = await fetch(`${proto}://${host}/api/nse-events`);
    if (evRes.ok) {
      const evData = await evRes.json();
      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
      const cutoff = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      cutoff.setDate(cutoff.getDate() + 5);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const upcoming = (evData.events || [])
        .filter((e) => e.date && e.date >= todayIST && e.date <= cutoffStr)
        .sort((a, b) => (a.date > b.date ? 1 : -1));

      out.MACRO_EVENT = upcoming.length
        ? `${upcoming[0].purpose || upcoming[0].category} — ${upcoming[0].company || upcoming[0].symbol || ""} (${upcoming[0].date})`
        : "None in next 5 days";
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
  for (const key of ["EMA20", "DMA200", "RSI", "MACD", "TREND", "PREV_CANDLE", "DOW_JONES", "ASIA", "GIFT_NIFTY", "PCR", "OI_ATM", "FII"]) {
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
  out.SUPPORT = pivots ? `${pivots.s1.toFixed(0)}, ${pivots.s2.toFixed(0)}` : "N/A — Yahoo fetch failed";
  out.RESISTANCE = pivots ? `${pivots.r1.toFixed(0)}, ${pivots.r2.toFixed(0)}` : "N/A — Yahoo fetch failed";
  out.DECISION_ZONE = pivots ? `${pivots.s1.toFixed(0)}–${pivots.r1.toFixed(0)}` : "N/A";

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    fields: out,
    errors, // per-section failures, widget can ignore or surface these
  });
}
